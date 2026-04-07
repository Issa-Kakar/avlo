# Presence/Awareness System

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `runtime/presence/presence.ts` | ~357 | All awareness logic: lifecycle, send (throttle + backpressure), receive (mutable Map), store sync |
| `stores/presence-store.ts` | ~41 | Zustand store: `peerIdentities`, `peerCount` (identity-only, self-filtered) |
| `renderer/animation/CursorAnimationJob.ts` | ~100 | AnimationJob: exponential smoothing + viewport cull + `drawImage` |
| `renderer/animation/cursor-bitmap.ts` | ~115 | `OffscreenCanvas` → `ImageBitmap` per `color:name` key |

---

## Architecture

### Three-Layer Split

**1. Network Layer** (`presence.ts`): Module-level mutable state. Owns the `peerCursors` map (`Map<clientId, PeerCursorState>`), send throttling, receive processing, and store sync. All awareness wiring happens here.

**2. Identity Layer** (`presence-store.ts`): Zustand store for React. Contains `peerIdentities` (`Map<userId, PeerIdentity>`) and `peerCount`. Updated only when peers join/leave/change identity (rare). `setPeers()` filters out the local user via `getUserId()` before storing.

**3. Rendering Layer** (`CursorAnimationJob.ts` + `cursor-bitmap.ts`): AnimationJob registered on `OverlayRenderLoop.start()`. Reads `getPeerCursors()` directly — zero Zustand overhead per frame. Exponential smoothing of display positions, viewport culling, bitmap-cached `drawImage`.

### Why the Split

Cursor positions change at 20Hz per peer and are read at 60fps+ by the animation job. Putting them in Zustand would trigger selector re-evaluation every frame for zero benefit (no React component renders cursors). The mutable map gives the render path raw `Map.values()` iteration with no middleware.

Identity changes (peer join/leave/rename) are rare and need to drive React re-renders (`UserAvatarCluster`). Zustand is correct here.

### ClientId vs UserId

- **userId:** Stable per browser profile. Persisted in `device-ui-store` via localStorage. Accessed via `getUserId()`. Same across tabs for the same user.
- **clientId:** `Y.Doc.clientID` — unique per tab. Two tabs of the same user have different clientIds but the same userId.

This distinction drives two different filtering strategies:

| Path | Keyed by | Why |
|------|----------|-----|
| `peerCursors` map | clientId | Same user in 2 tabs → 2 cursor entries. Each tab sees the other's cursor. |
| `peerIdentities` store | userId | Same user in 2 tabs → 1 identity entry. Avatar cluster shows unique people. |
| Send optimization (`peerCursors.size === 0`) | clientId | "Is anyone listening for my cursor?" Correct for multi-tab: tab A sees tab B as a peer. |
| `peerCount` | userId (self-filtered) | "Are other people here?" The "ME" avatar always renders regardless. |

### Provider-Owned Awareness

Awareness is **not** created separately. `YProvider` creates it in its constructor (`awareness = new Awareness(doc)`). The presence module attaches to it via `attach(provider)` and accesses `provider.awareness`.

- Provider wires `awareness.on('change', ...)` for broadcasting state changes over the wire
- Provider clears `awareness._checkInterval` (disables 15s heartbeat, preserves DO hibernation)
- On `doc.destroy()`, y-protocols auto-destroys awareness via `doc.on('destroy')` listener

---

## PeerCursorState

```typescript
interface PeerCursorState {
  userId: string;
  name: string;
  color: string;
  target: [number, number];   // From network (integer quantized)
  display: [number, number];  // Written by CursorAnimationJob each frame
  hasCursor: boolean;         // false when cursor cleared or peer has no cursor state
  isSettled: boolean;         // true when |display - target| < 0.5px in canvas space
}
```

Mutated in-place by two paths:
1. **Receive** (`processUpsert`): writes `target`, `hasCursor`, identity fields
2. **Render** (`CursorAnimationJob.frame`): writes `display`, `isSettled`

---

## Send Path

```
CanvasRuntime.handlePointerMove(e)
  → screenToWorld(e.clientX, e.clientY)
  → updateCursor(worldX, worldY)

CanvasRuntime.handlePointerLeave(_e)
  → clearCursor()
```

### updateCursor(worldX, worldY)

1. **Null guard:** Returns if `currentAwareness` is null (tab restore safety)
2. **Quantize:** `Math.round(worldX)`, `Math.round(worldY)` → integer world units
3. **Equality check:** Skip if same as `localCursor` tuple
4. **Alone optimization:** If `peerCursors.size === 0`, stores locally but doesn't schedule send. No Zustand `getState()` — direct module-local map size check.
5. **Dirty + schedule:** Sets `dirty = true`, calls `scheduleSend()`

### clearCursor()

1. Returns early if `localCursor` already undefined
2. Sets `localCursor = undefined`, `dirty = true`
3. Calls `scheduleSend()`

### scheduleSend() → flush()

- **Throttle:** Deterministic 50ms `setTimeout` (20Hz). Not RAF, not monitor-dependent.
- **De-duplication:** `flush()` checks if cursor === lastSentCursor AND `identitySent` — skips if nothing changed.
- **Backpressure:** Reads `provider.ws.bufferedAmount`:
  - `> 512KB` → reschedule at 200ms (5Hz)
  - `> 128KB` → reschedule at 100ms (10Hz)
  - Normal → proceed
- **Mobile:** `isMobile()` from camera-store → sends `undefined` cursor (no cursor visual on touch devices)
- **Sends:** `currentAwareness.setLocalStateField('cursor', {x, y})` — only cursor field, y-protocols merges with existing local state internally

### sendFullState()

Called on WS connect/reconnect. Sends the full identity + cursor via `awareness.setLocalState({userId, name, color, cursor})`. Needed because the DO may have hibernated and lost awareness state.

---

## Receive Path

### Event: `'update'` not `'change'`

- `'update'` fires on every incoming awareness protocol message, regardless of deep-equality
- `'change'` only fires when `equalityDeep` detects actual state differences
- Using `'update'` ensures peers always appear in `peerCursors` on reconnect, even when the server relays identical state (fixes intermittent cursor-not-rendering on refresh)
- The heartbeat interval is already cleared in our provider fork — no spurious timer-driven events
- The provider broadcasts on `'change'` (only actual state changes hit the wire). Our handler processing `'update'` is receive-side only.
- Processing identical cursor data is harmless (same target = no visual change)

### processBatch(added, updated, removed, getState)

For each clientId (excluding `cachedLocalClientId`):
- **added/updated:** `processUpsert(clientId, state)` — upserts into `peerCursors`
- **removed:** deletes from `peerCursors`
- If any identity changed → `rebuildStore()`

### processUpsert(clientId, state)

- Extracts `userId`, `name`, `color`, `cursor` from awareness state
- **New peer:** Creates entry with `display = target` (snap, no smoothing on first sample)
- **Existing peer, cursor arrives after having none:** Snaps `display` to `target` (prevents smoothing from stale position)
- **Existing peer, cursor update:** Sets `target`, marks `isSettled = false` (CursorAnimationJob smooths toward new target)
- Returns `true` if identity (name/color/userId) changed → triggers store rebuild

### rebuildStore()

Builds `Map<userId, PeerIdentity>` from all `peerCursors` values, calls `usePresenceStore.getState().setPeers(identities)`. The store's `setPeers()` filters out the local user.

### Overlay Invalidation Guard

```typescript
const hadPeers = peerCursors.size > 0;
processBatch(...);
if (peerCursors.size > 0 || hadPeers) invalidateOverlay();
```

The `hadPeers` check ensures one final frame when the last peer disconnects — clears their cursor visual. `invalidateOverlay()` is idempotent within a RAF frame.

---

## Render Path

### Registration

```
OverlayRenderLoop.start()
  → controller.register(new CursorAnimationJob())
  → controller.setInvalidator(() => this.invalidateAll())
```

### Frame Execution

```
OverlayRenderLoop.frame()
  → full clear
  → world-space: drawToolPreview()
  → screen-space: getAnimationController().run(ctx, now)
    → CursorAnimationJob.frame(ctx, now, dt)
```

### CursorAnimationJob.frame(ctx, now, dt)

1. `getPeerCursors()` — reads mutable map. Returns `false` immediately if empty (no work).
2. Sets `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` — screen-space rendering.
3. For each peer with `hasCursor`:
   - **Exponential smoothing:** `display += (target - display) * (1 - exp(-clampedDt / TAU))`
     - `TAU = 60ms`. At 60fps each step moves ~24% of remaining distance, at 144fps ~11%.
     - `dt` clamped to 200ms max (prevents snap on tab-switch resume).
   - **Settle check:** `|displayCanvas - targetCanvas| < 0.5px` for both axes → snap display to target, set `isSettled = true`.
   - **Viewport cull:** 100wu margin around visible bounds. Off-screen peers skip rendering but track activity (for RAF scheduling).
   - **Draw:** `ctx.drawImage(getCursorBitmap(color, name), cx - offsetX, cy - offsetY)` — single bitmap blit per peer.
4. Returns `true` if any peer still animating → controller self-invalidates → next RAF scheduled.

When all peers settle, `frame()` returns `false` → AnimationController stops requesting frames. Next awareness update calls `invalidateOverlay()` to restart the loop.

### Cursor Bitmap

- Rendered on `OffscreenCanvas` at 2x scale for retina
- **Pointer shape:** Figma-style tail-less cursor, ~18px tall, filled with user color, dark outline. Tip offset at (1, 1).
- **Label pill:** `roundRect` with user color fill, luminance-based text color (WCAG), Inter 12px 500 weight. 6px horizontal gap, 16px vertical gap from pointer tip.
- **Cache key:** `${color}:${name}`. On miss: renders synchronously (cheap single offscreen canvas draw).
- **Fonts:** Always loaded before canvas exists (`main.tsx` awaits `ensureFontsLoaded()`).
- `clearBitmapCache()` called on room disconnect via `detach()`.

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
      → awareness.on('update', updateHandler)
      → provider.on('status', statusHandler)
```

### Status: Connected

```
statusHandler({status: 'connected'})
  → peerCursors.clear()              // Clear stale peers from previous connection
  → rebuildStore()                    // Empty store
  → connected = true
  → sendFullState()                   // Full identity + cursor for DO hibernation recovery
  → if dirty: scheduleSend()          // Catch up pending cursor
  → onStatusChange(true)              // RoomDocManager: wsConnected = true
```

### Status: Disconnected

```
statusHandler({status: 'disconnected'})
  → connected = false
  → Clear: localCursor, lastSentCursor, identitySent, timer, dirty
  → peerCursors.clear()
  → rebuildStore()                    // Empty store
  → awareness.setLocalState(null)     // Signal departure
  → onStatusChange(false)             // RoomDocManager: wsConnected = false, wsRepacked = false
```

### Teardown

```
RoomDocManager.destroy()
  → detach()
    1. Stop timer (prevent flush during teardown)
    2. awareness.setLocalState(null)    // Signal departure while WS still open
    3. awareness.off('update', updateHandler)
    4. provider.off('status', statusHandler)
    5. Reset all send state
    6. peerCursors.clear() + rebuildStore()
    7. clearBitmapCache()
    8. Null out currentAwareness, currentProvider
  → provider.disconnect()              // Closes WebSocket
  → provider.destroy()
  → ydoc.destroy()                     // y-protocols auto-destroys awareness
```

**Key ordering:** `detach()` before `provider.disconnect()` so the departure signal (`setLocalState(null)`) broadcasts while the WebSocket is still open. Timer stops first in `detach()` to prevent `flush()` from firing during teardown.

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

`setLocalStateField` only sends the cursor field — y-protocols internally merges with the existing local state. This avoids re-broadcasting identity on every mouse move.

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
