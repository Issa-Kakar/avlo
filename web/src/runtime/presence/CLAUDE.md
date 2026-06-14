# Presence/Awareness System

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `runtime/presence/presence.ts` | ~260 | Awareness lifecycle, send (throttle + backpressure), receive dispatch. Delegates peer state to the renderer. |
| `runtime/presence/presence-renderer.ts` | ~590 | `PresenceCursorRenderer` class — SoA peer-state, slot pool, self-driven rAF, DOM `<img>` cursors. |
| `runtime/presence/presence-pointer.ts` | ~75 | Pure dispatch for the `document`-level local-cursor input path (move/out/blur/camera-sync). No listeners of its own — InputManager + CanvasRuntime own those |
| `stores/presence-store.ts` | ~41 | Zustand store: `peerIdentities`, `peerCount` (identity-only, self-filtered) |

---

## Architecture

### Three-Layer Split

**1. Network Layer** (`presence.ts`): Awareness lifecycle, send throttling/backpressure, receive dispatch. Holds no peer state — every awareness update is forwarded to `cursorRenderer.processAwarenessBatch(...)`.

**2. Identity Layer** (`presence-store.ts`): Zustand store for React. Contains `peerIdentities` (`Map<userId, PeerIdentity>`) and `peerCount`. Written by the renderer's `rebuildPeerStore()` when peers join/leave (rare). `setPeers()` filters out the local user via `getUserId()` before storing.

**3. Rendering Layer** (`presence-renderer.ts`): `PresenceCursorRenderer` class owns peer-state SoA tables, the slot pool, the DOM `<img>` elements, and a self-driven rAF. Created in `attach()`, disposed in `detach()`.

### Why DOM Cursors

The overlay canvas (`z-index: 2`) sits below the editor overlay (`editorHost` `z-index: 3`). Rendering peer cursors on the overlay canvas left them occluded by any in-flight text/code editor surface. The renderer mounts cursors as `<img>` children of a third div (`cursorHost`, `z-index: 4`, `pointerEvents: 'none'`, `contain: 'layout style'`) sibling to the canvases and the editor overlay. Cursors stack above the editor and BELOW the floating UI (context-menu 300, Toolbar/ZoomControls 380, TopBar 400) — matching the whiteboard model (Figma, Miro, Excalidraw) where cursors live on the canvas, not over the toolbar. The container's `overflow: hidden` clips cursors that translate beyond the canvas region.

### DOM Host Plumbing

`cursorHost` mirrors `editorHost`: owned by React (`Canvas.tsx`), passed through `RuntimeConfig → CanvasRuntime.start → new SurfaceManager(...)`. `SurfaceManager` writes the ref to a module-level `cursorHost`; the renderer reads it lazily via `getCursorHost()` from `@/runtime/SurfaceManager`. CanvasRuntime never imports the renderer — the host plumbing is entirely in the existing SurfaceManager path.

### Why the Split

Cursor positions change at 20Hz per peer and project to screen space at 60fps+. Storing them in Zustand would trigger selector re-evaluation every frame for zero benefit (no React component renders cursors). The SoA tables give the rAF loop typed-array indexed reads with no middleware.

Identity changes (peer join/leave) are rare and need to drive React re-renders (`UserAvatarCluster`). Zustand is correct there.

### ClientId vs UserId

- **userId:** Stable per browser profile. Persisted in `device-ui-store` via localStorage. Accessed via `getUserId()`. Same across tabs for the same user.
- **clientId:** `Y.Doc.clientID` — unique per tab. Two tabs of the same user have different clientIds but the same userId.

This distinction drives two different filtering strategies:

| Path | Keyed by | Why |
|------|----------|-----|
| Renderer slots (`slotByClientId`) | clientId | Same user in 2 tabs → 2 cursor entries. Each tab sees the other's cursor. |
| `peerIdentities` store | userId | Same user in 2 tabs → 1 identity entry. Avatar cluster shows unique people. |
| Send optimization (`hasActivePeers()`) | clientId | "Is anyone listening for my cursor?" Correct for multi-tab: tab A sees tab B as a peer. |
| `peerCount` | userId (self-filtered) | "Are other people here?" The "ME" avatar always renders regardless. |

### Provider-Owned Awareness

Awareness is **not** created separately. `YProvider` creates it in its constructor (`awareness = new Awareness(doc)`). The presence module attaches to it via `attach(provider)` and accesses `provider.awareness`.

- Provider wires `awareness.on('change', ...)` for broadcasting state changes over the wire
- Provider clears `awareness._checkInterval` (disables 15s heartbeat, preserves DO hibernation)
- On `doc.destroy()`, y-protocols auto-destroys awareness via `doc.on('destroy')` listener

---

## PresenceCursorRenderer (`presence-renderer.ts`)

### State (SoA)

All allocated once at construction (`CAPACITY = 128`):

```
positions     Float32Array[CAPACITY*4]   // per slot: tx, ty = network target (world units),
                                         //          dx, dy = smoothed display (world units)
lastWritten   Float32Array[CAPACITY*2]   // per slot: last written CSS-px (cx, cy) — skip-write cache
flags         Uint8Array[CAPACITY]       // bit-packed (see glossary below)
activeSlots   Uint16Array[CAPACITY]      // dense list of active slot indices — tick iterates [0..activeCount)
slotToActive  Int16Array[CAPACITY]       // reverse index into activeSlots; −1 when slot is free
slotGen       Uint32Array[CAPACITY]      // generation counter; bumped on alloc AND free to invalidate
                                         //   in-flight bitmap resolvers for the slot's prior tenant
clientIdBySlot Int32Array[CAPACITY]      // slot → clientId; −1 when free

userIds   string[CAPACITY]               // identity (immutable per-tenancy — see Awareness Integration)
names     string[CAPACITY]
colors    string[CAPACITY]
blobUrls  (string | null)[CAPACITY]      // current bitmap URL — revoked on freeSlot + on bitmap swap
elements  (HTMLImageElement | null)[CAPACITY]

freeList         number[]                // LIFO slot indices (pop = alloc)
slotByClientId   Map<number, number>     // clientId → slot — only Map on the awareness hot path
activeCount      number                  // length of activeSlots' dense prefix
```

Memory at full capacity ~5 KB typed arrays + 128 strings + up to 128 `HTMLImageElement`. Negligible.

**Flag bits.** Bit-packed in `flags[slot]`; reads/writes fold into a local `f` per slot to single typed-array op.

| Bit | Set when | Cleared when |
|---|---|---|
| `FLAG_ACTIVE` | `allocSlot` | `freeSlot` |
| `FLAG_HAS_CURSOR` | awareness state includes `cursor: {x,y}` | awareness state has `cursor: undefined`, or `freeSlot` |
| `FLAG_SETTLED` | `\|cx − tcx\| < 0.5 && \|cy − tcy\| < 0.5` in tick; or snap-on-first-sample in `upsertFromState` | new target arrives via `upsertFromState` |
| `FLAG_WAS_IN_VP` | tick promotes element to `visibility: visible` | tick demotes to `hidden` (or `freeSlot`) |
| `FLAG_IMG_LOADED` | `<img>.onload` fires (one-shot per slot tenancy) | `freeSlot` (via `flags = 0`) |

**Slot lifecycle.** `FLAG_ACTIVE` is the gate — set by `allocSlot`, cleared by `freeSlot`. Outside that window the slot's entry sits in `freeList` and every other table holds reset sentinels.

```
free        →  allocSlot                            →  active
  (in freeList,    pop from freeList, append to       (in activeSlots,
   FLAG_ACTIVE=0,   activeSlots, slotToActive=idx,     FLAG_ACTIVE=1,
   element=null)   bump slotGen, setIdentity,         element non-null,
                   buildElementForSlot, requestBitmap   blobUrl set once
                                                       bitmap resolves)
active      →  freeSlot                             →  free
              swap-remove from activeSlots,
              bump slotGen, revoke blobUrl,
              null out element/identity, push freeList
```

Within an `active` window, identity is treated as immutable; only `target` and `FLAG_HAS_CURSOR` mutate via `upsertFromState`. (Identity-mutation would require a re-`requestBitmap`; the `slotGen` mechanism is already in place.)

### Lifecycle

```
attach():
  cameraUnsub = subscribeCamera(_onCameraChange)
  lastTickMs = 0
  // No host registration here — host lives in SurfaceManager;
  // renderer reads getCursorHost() lazily in allocSlot.

dispose():
  destroyed = true
  cancelAnimationFrame(rafId)        // 1. stop rAF first — no more DOM writes
  cameraUnsub()                       // 2. then unsubscribe — no kicks queued
  while (activeCount > 0) freeSlot(activeSlots[activeCount-1])   // 3. tear down each slot (revokes blob, removes <img>)
  usePresenceStore.setPeers(EMPTY)    // 4. clear React store
```

The DOM host is NOT removed here — React owns its lifetime. By the time `dispose()` runs during a normal disconnect path, React may have already unmounted the host div. `freeSlot`'s `el.parentNode?.removeChild(el)` is null-safe.

### rAF Driver

**Self-paced** — no external scheduler. The loop wakes on external events, self-perpetuates while smoothing, then idles.

**Wake conditions** (each calls `kickRaf()`, which is idempotent on `rafId !== null`):
- `subscribeCamera` callback — any of `scale | pan.x | pan.y | cssWidth | cssHeight | dpr` changed.
- `processAwarenessBatch` — any add/update/remove touched a slot.
- `<img>.onload` — bitmap loaded; tick may now promote visibility.
- Tick itself — re-kicks if any cursor was unsettled this frame.

**Stop condition**: tick returns without re-kicking when every active slot is `SETTLED` (or `!HAS_CURSOR`). Settled + idle camera = zero rAF reschedules.

`tick(now)`:
1. Read camera once into locals: `scale, pan.x, pan.y, cssWidth, cssHeight`. (Locals stabilize V8 monomorphism across the loop body.)
2. `dt`: first tick (`lastTickMs === 0`) defaults to 16 ms — there's no prior timestamp to diff against. Subsequent ticks clamp to `DT_CLAMP_MS = 200` (prevents jump on tab-resume). `alpha = 1 - exp(-dt / TAU_MS)`, with `TAU_MS = 60`.
3. Walk `activeSlots[0..activeCount)`:
   - If `!HAS_CURSOR`: hide if `WAS_IN_VP`, clear that bit, skip.
   - Smooth `display += (target - display) * alpha` unless `SETTLED`. (Smoothing is in world coords; the visible motion is sub-pixel-stable because the GPU compositor accepts fractional translates.)
   - Project to CSS px: `cx = (dx - panX) * scale; cy = (dy - panY) * scale`.
   - **Settle check in CSS px** (zoom-aware: same perceptual 0.5 px threshold at every zoom level). If `|cx − tcx| < 0.5 && |cy − tcy| < 0.5` → snap display to target + set `SETTLED`.
   - **Viewport cull with asymmetric hysteresis**: margin = `wasInVp ? 150 : 50`. The expanded viewport is `[-margin, cssW+margin] × [-margin, cssH+margin]`. Asymmetry makes it easier to stay visible (150 px out) than to start showing (50 px in) — prevents flicker at the boundary when a peer's cursor drifts on/off screen.
   - Visible iff `inVp && IMG_LOADED`. Toggling `visibility` flips `FLAG_WAS_IN_VP`.
   - **Skip-write cache**: `lastWritten[slot]` holds the most recent CSS-px `(cx, cy)` written. Exact `!==` compare → settled cursor with stationary camera produces zero `style.translate` writes per tick. Camera move or smoothing step always differs by at least one float ULP, so the cache never holds stale data after motion.
   - Write `el.style.translate = '<cx>px <cy>px'` when visible AND value changed; update `lastWritten`.
4. Re-kick rAF only if `anyUnsettled`.

Hot-path invariants:
- Only allocation in the loop body is the transform string (acknowledged unavoidable, one per visible peer per smoothing frame).
- No closures created per iteration; `tick` is a single arrow field, `_onCameraChange` is a separate arrow field — both allocated once at construction.
- All iteration is typed-array indexed; no `for-of`, no `Map.values()`, no destructuring.
- Flag reads/writes fold into a local `f` per slot — one read at the top, conditional write at the bottom.
- `style.translate` (CSS individual transform) over `style.transform = 'translate3d(...)'` — same GPU compositor promotion (covered by `will-change: transform`), fewer chars in the string.

### Bitmap Pipeline

Async by construction (`OffscreenCanvas.convertToBlob` returns a Promise). The element must be live in DOM before the bitmap resolves, but invisible — there's no acceptable window for a wrongly-positioned frame to paint.

**No-flash sequence** (`buildElementForSlot`):
1. `document.createElement('img')`.
2. Set styles in this order: `position`, `top`, `left`, `pointer-events`, `will-change`, **`visibility: hidden`**, **`translate: <cx>px <cy>px`**. (The transform is set BEFORE the element enters DOM — first paint can't catch a default `0,0` position.)
3. `host.appendChild(el)` — now in DOM, invisible, at the right transform.
4. `el.onload` handler set; will fire when `src` is assigned and the PNG decodes.
5. `src` is NOT set here — the renderer-side `requestBitmap` resolver writes it after the blob is ready.

On `onload`: stale-guard (`elements[slot] !== el`) → set `width/height = naturalWidth/Height / BITMAP_SCALE` → flip `FLAG_IMG_LOADED` → `kickRaf` so the next tick promotes visibility (if also in viewport).

**`requestBitmap(slot)`**:
1. **Bump-then-capture**: `gen = ++slotGen[slot]`. Any later `freeSlot` / re-`requestBitmap` will bump again — the captured `gen` only matches if this exact tenancy is still in this exact slot at resolve time.
2. `renderBitmapBlob(color, name)` — async `OffscreenCanvas` 2× draw of label (rounded rect + WCAG-luminance text color) and the IconSelect arrow path, encoded via `convertToBlob({ type: 'image/png' })`.
3. On resolve:
   - Bail if `destroyed` or `slotGen[slot] !== gen` → discard blob, GC reclaims.
   - Bail if `elements[slot] === null` → revoke the freshly-created URL, return. (Slot was freed between bump and resolve.)
   - Otherwise: `URL.createObjectURL(blob) → el.src` first, **then** `URL.revokeObjectURL(oldUrl)`. Order matters — some browsers keep an old image cached by URL until `src` is reassigned, and revoking before the swap can drop the cache entry mid-paint.

Label width measurement uses `measureTextCached(LABEL_FONT, name)` from `core/text/text-measure.ts` — shares the singleton measure context with bookmark/code/text/sticky-note/shape-label. `LABEL_FONT` is weight 500 (a non-matrix font string); `measureTextCached` accepts any font string, so this path doesn't conflict with the matrix-based font caches used by the text system.

### Slot Reuse / Async Resolution Safety

| Scenario | Mechanism |
|---|---|
| Peer A in slot 5, leaves while bitmap pending; peer B reclaims slot 5; A's blob resolves later. | `freeSlot` and `allocSlot` both bump `slotGen[5]`. Resolver checks `slotGen[5] !== capturedGen` → discards blob; no URL created, no leak. |
| Slot 5 element is null when blob resolves. | Guard: `elements[slot] === null` → revoke new URL. |
| `dispose()` mid-render. | `destroyed` flag → resolver early-exits. Blob is GC'd. |
| `onload` fires after element was replaced. | `this.elements[slot] !== el` guard. |
| Future identity-mutation (color change). | Today identity is immutable on existing slots. The trigger would be a one-line diff in `upsertFromState` calling `requestBitmap`; `slotGen` already handles the out-of-order resolution case. |

### Awareness Integration

`processAwarenessBatch(added, updated, removed, getState)`:
1. **Removals first.** Every removal returns a slot to `freeList` and tears down its DOM element. Running them ahead of adds/updates means a busy churn (peer A leaves + peer B joins in the same batch) re-uses A's slot for B rather than approaching `CAPACITY`. The local `clientId` is filtered at every step (`cid === localClientId` → skip).
2. **Adds + updates share `upsertFromState`.**
   - New slot: `allocSlot → setIdentity → requestBitmap`. Marks identityDirty.
   - Existing slot: identity treated as immutable (no diff against `userIds[slot] / names[slot] / colors[slot]`). Only `target` and `FLAG_HAS_CURSOR` move.
3. **Snap vs smooth rule.** Driven by `hadCursor = (flags[slot] & FLAG_HAS_CURSOR) !== 0`:
   - `cursor` arrives && `!hadCursor` (first sample, OR cursor was previously cleared and is reappearing) → set target AND snap display to target, set `FLAG_HAS_CURSOR | FLAG_SETTLED`. Without this, smoothing would interpolate from a stale `(0,0)` or last-seen position over hundreds of ms.
   - `cursor` arrives && `hadCursor` → set target only, clear `FLAG_SETTLED` (tick will smooth).
   - `cursor === undefined` → clear `FLAG_HAS_CURSOR`. Tick hides the element next frame.
4. `rebuildPeerStore()` only if identity dirty (new slot or removal).
5. `kickRaf` if any add/update/remove touched a slot.

`clearAllPeers()` (used by status `'connected'` AND `'disconnected'`): walks active slots back-to-front (so swap-remove from `activeSlots` doesn't shift indices under iteration), calls `freeSlot`, rebuilds peer store. On `'connected'` it primes the renderer for the post-sync awareness flood; on `'disconnected'` it gives immediate visual cleanup.

---

## Send Path

The local cursor is driven from a **`document`-level** pointer path, not the
base-canvas pointer events. The canvas is conceptually a full-viewport surface
underneath all DOM chrome, so the world position under the pointer is always
well-defined — even when the toolbar / menus / editor overlays sit on top.
`presence-pointer.ts` is pure dispatch (no listeners of its own): InputManager
owns the `document` listeners, CanvasRuntime owns the camera trigger.

```
InputManager (document 'pointermove')
  → handlePresencePointerMove(e)
  → screenToWorldInto(e.clientX, e.clientY, scratch)   // zero-alloc
  → updateCursor(worldX, worldY)

InputManager (document 'pointerout', relatedTarget === null → left the window)
  → handlePresencePointerOut(e) → clearCursor()

InputManager (window 'blur')
  → handlePresenceBlur() → clearCursor()

CanvasRuntime camera subscription (wheel-zoom / keyboard-pan / edge-scroll)
  → syncPresenceCursorOnCameraMove()
  → replays the last screen position through the new camera → updateCursor(...)
```

`presence-pointer.ts` holds the only `updateCursor` / `clearCursor` call sites.
The base-canvas `handlePointerMove` still runs `setLastCursorWorld` for
paste-at-cursor placement (deliberately canvas-scoped) but no longer touches
presence; `handlePointerLeave` no longer clears the cursor — moving onto DOM
chrome must not vanish it, so clears come only from genuine window exit / blur.

### updateCursor(worldX, worldY)

1. **Null guard:** Returns if `currentAwareness` is null (tab restore safety)
2. **Quantize:** `Math.round(worldX)`, `Math.round(worldY)` → integer world units
3. **Equality check:** Skip if unchanged vs the `localCursor` scratch tuple (`hasLocalCursor` gates the first write). Both `localCursor` and `lastSentCursor` are module tuples mutated in place + booleans — zero allocation per move.
4. **Alone optimization:** If `!cursorRenderer || !cursorRenderer.hasActivePeers()`, stores locally but doesn't schedule send. Single integer compare (`activeCount > 0`). When a peer later joins, `updateHandler` flushes the parked cursor (see Receive Path → Solo→Join Catch-Up).
5. **Dirty + schedule:** Sets `dirty = true`, calls `scheduleSend()`

### clearCursor()

1. Returns early if `hasLocalCursor` is already false
2. Sets `hasLocalCursor = false`, `dirty = true`
3. Calls `scheduleSend()`

### scheduleSend() → flush()

- **Throttle:** Deterministic 50ms `setTimeout` (20Hz). Not RAF, not monitor-dependent.
- **De-duplication:** `flush()` checks if cursor === lastSentCursor AND `identitySent` — skips if nothing changed.
- **Backpressure:** Reads `provider.ws.bufferedAmount`:
  - `> 512KB` → reschedule at 200ms (5Hz)
  - `> 128KB` → reschedule at 100ms (10Hz)
  - Normal → proceed
- **Mobile:** `isMobile()` from camera-store → sends `undefined` cursor (no cursor visual on touch devices)
- **Sends:** `currentAwareness.setLocalStateField('cursor', {x, y})` — the field merge is LOCAL-only; the wire still carries the full state JSON (see Wire Format)

### sendFullState()

Called on WS connect/reconnect. Sends the full identity + cursor via `awareness.setLocalState({userId, name, color, cursor})`. Needed because the DO may have hibernated and lost awareness state.

---

## Receive Path

### Event: `'update'` not `'change'`

- `'update'` fires on every incoming awareness protocol message, regardless of deep-equality
- `'change'` only fires when `equalityDeep` detects actual state differences
- Using `'update'` ensures peers always appear on reconnect, even when the server relays identical state (fixes intermittent cursor-not-rendering on refresh)
- The heartbeat interval is already cleared in our provider fork — no spurious timer-driven events
- The provider broadcasts on `'change'` (only actual state changes hit the wire). Our handler processing `'update'` is receive-side only.
- Processing identical cursor data is harmless (same target = no visual change)

### updateHandler

`presence.ts`'s `updateHandler` is a thin shim: snapshot `hadActive`, forward the batch to `cursorRenderer.processAwarenessBatch(...)`, snapshot `hasActive`, optionally run Solo→Join catch-up. No peer state lives in `presence.ts` anymore.

### Solo→Join Catch-Up

```typescript
if (hasActive && !hadActive && hasLocalCursor) {
  dirty = true;
  scheduleSend();
}
```

The alone-optimization (`updateCursor` step 4) stores the cursor locally but never broadcasts while no peer is active. When the first peer appears, the parked cursor would otherwise stay invisible until the next pointer move — this flushes it immediately. `scheduleSend()` no-ops if disconnected/pending; `flush()` de-dups against `lastSentCursor` — safe and idempotent.

---

## Render Path

The renderer is owned by `presence.ts`, NOT by the overlay loop. It manages its own rAF — no `AnimationController` registration. The overlay loop still hosts `EraserTrailAnimation` and other canvas-bound jobs but no longer carries the cursor job. The wake/stop semantics, tick body, and skip-write cache are documented in the **rAF Driver** subsection above; the rest of this section covers the bitmap visual.

```
presence.attach()
  → new PresenceCursorRenderer(localClientId).attach()
  → subscribeCamera(_onCameraChange)        // single subscription handles scale/pan/cssW/cssH/dpr
```

### Cursor Bitmap

- Rendered on `OffscreenCanvas` at 2× for retina; encoded as `Blob` via `convertToBlob`, referenced by `URL.createObjectURL → <img>.src`.
- **Pointer shape:** the `IconSelect` arrow (`components/icons/index.tsx`) — a filled SVG path in a 24-unit viewBox, reused verbatim as a `Path2D` (`SELECT_CURSOR_PATH` constant inside `presence-renderer.ts`) so the peer cursor matches the toolbar icon exactly. Four cubic-rounded vertices, symmetric about the 45° diagonal: tip (hotspot, on the diagonal), concave notch (on the diagonal, recessed), and a mirror-pair of wings. Drawn scaled by `POINTER_SCALE` (≈23px), filled with user color + 1px dark outline.
- **Label:** `roundRect` (`LABEL_RADIUS` = 7) with user color fill, luminance-based text color (WCAG), `500 12px "Inter", system-ui, sans-serif`. Label width measured via `measureTextCached(LABEL_FONT, name)` from `core/text/text-measure.ts` — the same singleton measure context shared with bookmark, code, sticky-note, shape-label, text-system.
- **Fonts:** Always loaded before canvas exists (`main.tsx` awaits `ensureFontsLoaded()`).
- No cache — one bitmap per peer for the peer's lifetime in the room. Identity is immutable on existing slots; if/when an identity-change feature lands, `requestBitmap` re-runs and the `slotGen` guard handles out-of-order resolution.

---

## Lifecycle

### Initialization

```
RoomDocManager.init()
  → initializeWebSocketProvider()
    → new YProvider(host, roomId, ydoc, opts)     // provider auto-creates awareness
    → attach(provider, onStatusChange)
      → currentAwareness = provider.awareness
      → cachedLocalClientId = awareness.clientID
      → cursorRenderer = new PresenceCursorRenderer(cachedLocalClientId)
      → cursorRenderer.attach()                    // subscribes to camera
      → awareness.on('update', updateHandler)
      → provider.on('status', statusHandler)
```

### Status: Connected

```
statusHandler({status: 'connected'})
  → cursorRenderer.clearAllPeers()    // frees slots + DOM, empties store
  → connected = true
  → sendFullState()                    // full identity + cursor for DO hibernation recovery
  → if dirty: scheduleSend()           // catch up pending cursor
  → onStatusChange(true)               // RoomDocManager: wsConnected = true
```

### Status: Disconnected

```
statusHandler({status: 'disconnected'})
  → connected = false
  → Clear: hasLocalCursor, hasLastSentCursor, identitySent, timer, dirty
  → cursorRenderer.clearAllPeers()    // immediate visual cleanup
  → awareness.setLocalState(null)      // signal departure
  → onStatusChange(false)              // RoomDocManager: wsConnected = false
```

### Teardown

```
RoomDocManager.destroy()
  → detach()
    1. Stop timer (prevent flush during teardown)
    2. awareness.setLocalState(null)    // signal departure while WS still open
    3. awareness.off('update', updateHandler)
    4. provider.off('status', statusHandler)
    5. Reset all send state
    6. cursorRenderer.dispose()         // rAF cancel → camera unsub → free slots (revoke blobs, remove <img>) → empty peer store
    7. Null out currentAwareness, currentProvider
  → provider.disconnect()               // closes WebSocket
  → provider.destroy()
  → ydoc.destroy()                      // y-protocols auto-destroys awareness
```

**Key ordering:** `detach()` before `provider.disconnect()` so the departure signal (`setLocalState(null)`) broadcasts while the WebSocket is still open. Timer stops first in `detach()` to prevent `flush()` from firing during teardown. Inside `dispose()`, rAF is cancelled before the camera unsub so a late camera tick can't queue a new frame, and slots are freed before the peer store is emptied so blob URLs are revoked even if the host has already been detached by React.

---

## Wire Format

```typescript
// Full state (connect/reconnect):
awareness.setLocalState({
  userId: string,       // ULID, stable per browser profile
  name: string,         // e.g. "Witty Penguin"
  color: string,        // e.g. "#5B8DEF" (from 16-color palette)
  cursor?: { x: number, y: number }  // integer world coords
})

// Cursor update (pointer move):
awareness.setLocalStateField('cursor', { x, y })

// Cursor clear (pointer leave):
awareness.setLocalStateField('cursor', undefined)

// Departure (disconnect/detach):
awareness.setLocalState(null)
```

`setLocalStateField` merges the field into LOCAL state only — it does NOT keep identity off the wire. y-protocols' `encodeAwarenessUpdate` serializes the FULL state JSON for every changed client on every flush, so identity re-broadcasts with each cursor packet (~20 Hz while moving). Keep this object small: it's exactly why the deferred presence `avatarHash` field will be a 32-hex content hash, never a URL — it rides every cursor flush.

---

## UserAvatarCluster

- Reads `peerIdentities` from `usePresenceStore` (userId-keyed, self already filtered out)
- Always renders "ME" avatar (unconditional, no peer count check)
- Renders up to 4 peer avatars + overflow count (`+N` badge)
- When alone: peer list naturally empty, only "ME" shows — no explicit `isAlone` check
- Initials: two-letter from name parts (e.g. "Witty Penguin" → "WP")

---

## User Identity

Generated at module load in `device-ui-store.ts` if not already persisted:
- `userId`: ULID, stable per browser profile (localStorage)
- `userName`: Random "Adjective Animal" from `utils/generate-user-profile.ts` (15 adjectives × 15 animals)
- `userColor`: Random hex from 16-color high-contrast palette

Accessors:
- `getUserId()`: Returns `userId` — used by tools for `ownerId`, by undo manager for origin tracking, by presence-store for self-filtering
- `getUserProfile()`: Returns `{userId, name, color}` — used by `sendFullState()` for the awareness wire format
