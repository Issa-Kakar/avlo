# Presence/Awareness System — Architecture

**Last updated:** 2026-04-05
**Status:** Typechecks clean. Provider-owned awareness, clientId-based optimizations.

---

## File Inventory

| File                                     | Lines | Purpose                                                                                                                    |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `lib/presence.ts`                        | ~355  | All awareness logic: lifecycle (`attach`/`detach`), send (50ms throttle + backpressure), receive (mutable Map), store sync |
| `stores/presence-store.ts`               | ~50   | Zustand store: `peerIdentities`, `peerCount`, `localUserId`                                                                |
| `canvas/animation/CursorAnimationJob.ts` | ~98   | AnimationJob: exponential smoothing + viewport cull + `drawImage`                                                          |
| `canvas/animation/cursor-bitmap.ts`      | ~115  | `OffscreenCanvas` → `ImageBitmap` per `color:name`                                                                         |

### Integration Points (other files)

| File                               | What it does                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/room-doc-manager.ts`          | Calls `initPresenceIdentity()` in constructor, calls `attach(provider, cb)` in `initializeWebSocketProvider()`, calls `detach()` in `destroy()` |
| `canvas/CanvasRuntime.ts`          | Calls `updateCursor(worldX, worldY)` on pointer move, `clearCursor()` on pointer leave                                                          |
| `renderer/OverlayRenderLoop.ts`    | Registers `CursorAnimationJob` as an animation job in `start()`                                                                                 |
| `components/UserAvatarCluster.tsx` | Reads `usePresenceStore` directly for peer avatars, always renders "ME"                                                                         |

---

## Architecture

### Provider-Owned Awareness

Awareness is **not** created separately — the YProvider creates it automatically via its default constructor parameter (`awareness = new awarenessProtocol.Awareness(doc)`). The presence module attaches to it via `attach(provider)` and accesses `provider.awareness`.

This couples awareness lifecycle to the provider:

- Provider creates awareness in its constructor → `this.awareness = awareness`
- Provider wires `awareness.on('change', ...)` for broadcasting state changes
- Provider clears `awareness._checkInterval` (disables 15s heartbeat, preserves DO hibernation)
- On `doc.destroy()`, y-protocols auto-destroys awareness via `doc.on('destroy')` listener wired in the Awareness constructor

### Three Data Paths

```
SEND:
  CanvasRuntime.handlePointerMove
    → presence.updateCursor(worldX, worldY)
    → Math.round() quantize to integers
    → equality check against localCursor tuple
    → if peerCursors.size === 0 → store locally, don't send (clientId-based)
    → dirty flag → 50ms setTimeout → flush()
    → awareness.setLocalStateField('cursor', {x, y})

RECEIVE:
  awareness.on('update', handler)                [presence.ts]
    → for each changed clientId (excluding cachedLocalClientId):
      presence.processBatch()
        → processUpsert(): upsert into mutable peerCursors Map
        → if identity changed → rebuildStore() → usePresenceStore.setPeers()
    → if peerCursors.size > 0 || hadPeers:
      invalidateOverlay()                        [kicks CursorAnimationJob]

RENDER:
  OverlayRenderLoop.frame()
    → AnimationController.run()
      → CursorAnimationJob.frame(ctx, now, dt)
        → if peers.size === 0 → return false (clientId-based)
        → for each peer with hasCursor:
          → exponential smoothing: display += (target - display) * (1 - exp(-dt/TAU))
          → viewport bounds check (100wu margin)
          → ctx.drawImage(getCursorBitmap(color, name), cx - offsetX, cy - offsetY)
        → return true if any peer still animating
```

### Module Dependency Graph

```
                     ┌────────────────────────┐
                     │   lib/presence.ts       │
                     │ initPresenceIdentity()  │  ← called in RoomDocManager constructor
                     │ attach(provider, cb)    │  ← called in initializeWebSocketProvider()
                     │ detach()                │  ← called in RoomDocManager.destroy()
                     │ updateCursor()          │  ← called by CanvasRuntime.handlePointerMove
                     │ clearCursor()           │  ← called by CanvasRuntime.handlePointerLeave
                     │ getPeerCursors()        │  ← called by CursorAnimationJob.frame()
                     └──────────┬──────────────┘
                                │
               ┌────────────────┼────────────────┐
               │ reads          │ writes          │ reads
               ▼                ▼                 ▼
  ┌─────────────────┐   ┌──────────────────┐  ┌─────────────────────────┐
  │  camera-store   │   │ presence-store   │  │ cursor-bitmap.ts        │
  │ isMobile()      │   │ (Zustand)        │  │ getCursorBitmap(color,  │
  └─────────────────┘   │ peerIdentities   │  │   name) → ImageBitmap   │
                         │ peerCount        │  └─────────────────────────┘
                         │ localUserId      │          ▲ reads
                         └────────┬─────────┘          │
                                  │            ┌──────┴──────────────────┐
                                  │ reads      │ CursorAnimationJob.ts   │
                                  ▼            │ frame(ctx, now, dt)     │
                     ┌────────────────────────┐└─────────────────────────┘
                     │ UserAvatarCluster.tsx   │
                     │ reads peerIdentities   │
                     │ always renders "ME"    │
                     └────────────────────────┘
```

### Store vs Mutable Map — The Split

**Mutable Map** (`peerCursors` in `lib/presence.ts`):

- `Map<number, PeerCursorState>` keyed by awareness clientId
- Contains: `target: [x, y]` (from network), `display: [x, y]` (written by CursorAnimationJob), `isSettled`, `hasCursor`, `userId`, `name`, `color`
- Mutated in-place every awareness event and every animation frame
- Read directly by CursorAnimationJob via `getPeerCursors()` — zero Zustand overhead per frame
- **Keyed by clientId:** same user with multiple tabs = multiple entries (different clientIds, same userId)

**Zustand Store** (`usePresenceStore`):

- Contains: `peerIdentities: Map<userId, {name, color}>`, `peerCount`, `localUserId`
- Updated via `setPeers()` only when identities change (peer add/remove/name change — rare)
- **`setPeers()` filters out localUserId:** entries where `userId === localUserId` are excluded before storing
- `peerCount` computed from the **filtered** map (unique userIds, excluding self)
- Read by React components (UserAvatarCluster)

### ClientId vs UserId — Two Separate Concepts

- **userId:** Stable per-user (stored in localStorage via `userProfileManager`). Same across tabs for the same browser profile.
- **clientId:** `Y.Doc.clientID` — unique per Y.Doc instance, meaning unique per tab. Two tabs of the same user have different clientIds but the same userId.
- `cachedLocalClientId` is set once in `attach()` from `provider.awareness.clientID`. Used to filter self in `processBatch()`.

**Send/render path** uses `peerCursors.size` (clientId-based) — "does anyone need my cursor data?" This correctly handles same-user multi-tab: two tabs of the same user have different clientIds, so each appears in the other's `peerCursors` map.

**Avatar UI** uses `peerCount` from store (userId-based, self-filtered) — "are there other people here?" The "ME" avatar always renders regardless.

### PeerCursorState Shape

```typescript
interface PeerCursorState {
  userId: string;
  name: string;
  color: string;
  target: [number, number]; // from network (integer quantized)
  display: [number, number]; // written by CursorAnimationJob each frame
  hasCursor: boolean; // false when cursor cleared or peer has no cursor
  isSettled: boolean; // true when |display - target| < 0.5px in canvas space
}
```

### Exponential Smoothing

```
display += (target - display) * (1 - exp(-dt / TAU))
TAU = 60ms
```

- Frame-rate independent: at 60fps each step moves ~24% of remaining distance, at 144fps ~11%, same perceptual rate
- `dt` clamped to 200ms max (prevents snap on tab-switch resume)
- Settle: `|displayCanvas - targetCanvas| < 0.5px` for both axes → `isSettled = true`, stops smoothing
- When all peers settle, `frame()` returns `false` → AnimationController stops requesting frames

### Cursor Bitmap

- Rendered on `OffscreenCanvas` at 2x scale for retina
- Pointer shape: Figma-style tail-less cursor, ~18px tall, filled with user color, dark outline
- Pointer tip offset at (1, 1) for slight left bias
- Label: pill-shaped `roundRect` with user color fill, luminance-based text color (dark or white)
- Label gap: 6px horizontal, 16px vertical from pointer tip
- Font: Inter 12px 500 weight (fonts always loaded before canvas — `main.tsx` awaits `ensureFontsLoaded()`)
- Cache key: `${color}:${name}`
- On cache miss: renders bitmap synchronously (cheap — single offscreen canvas draw)
- `clearBitmapCache()` called on room disconnect via `detach()`

### Send Module Details

- **Quantization:** `Math.round(worldX)` — integer world units
- **Throttle:** Deterministic 50ms `setTimeout` (20Hz). No RAF, no jitter, no monitor dependency.
- **ClientId-based optimization:** If `peerCursors.size === 0`, stores cursor locally but doesn't schedule send. Direct module-local access, no Zustand `getState()` overhead.
- **Backpressure:** Reads `provider.ws.bufferedAmount` in `flush()`:
  - `> 512KB` → reschedule at 200ms (5Hz)
  - `> 128KB` → reschedule at 100ms (10Hz)
  - Normal → 50ms (20Hz)
- **`setLocalStateField('cursor', cursor)`:** Sends only cursor field, not full state. y-protocols internally merges with existing local state.
- **`sendFullState()`:** Called on WS connect/reconnect. Sends `setLocalState({userId, name, color, cursor})` — full state for DO hibernation recovery.
- **Mobile detection:** Uses `isMobile()` from camera-store (cached result). On mobile, sends `undefined` cursor.
- **Null guard:** `updateCursor()` and `clearCursor()` return early if `currentAwareness` is null (safety for tab restore).

### Receive Module Details

- **`processBatch(added, updated, removed, getState)`:** Called from the `'update'` event handler. Filters `cachedLocalClientId` (self).
- **`processUpsert(clientId, state)`:** Upserts into `peerCursors` map. On first cursor sample after having none, snaps display to target (no smoothing). Returns `true` if identity (name/color/userId) changed.
- **`rebuildStore()`:** Builds `Map<userId, PeerIdentity>` from all peerCursors entries. Passes to `usePresenceStore.setPeers()` which filters out `localUserId`.
- **Stale cursor clear:** On WS `'connected'` status, clears `peerCursors` and rebuilds store before `sendFullState()`. Awareness sync from DO repopulates current peers.
- **Overlay invalidation guard:** Only calls `invalidateOverlay()` if there are (or were) remote cursors. The `hadPeers` check ensures one final frame when the last peer disconnects (to clear their cursor visual).

### Status Handler

Single `provider.on('status', statusHandler)` in `attach()` handles both:

1. **Presence module internals:** `connected` flag, `sendFullState()` on connect, state reset + `peerCursors.clear()` on disconnect, `awareness.setLocalState(null)` to signal departure
2. **RoomDocManager callback:** `onStatusChange?.(boolean)` sets `wsConnected` and resets `wsRepacked` on disconnect

### Awareness Event: `'update'` not `'change'`

- `'update'` fires on every incoming awareness protocol message, regardless of deep-equality
- `'change'` only fires when `equalityDeep` detects actual state differences
- Using `'update'` ensures peers are always added to `peerCursors` on reconnect, even when the server relays identical state (fixes intermittent cursor-not-rendering on refresh)
- The heartbeat interval is already cleared in our provider fork (`clearInterval(awareness._checkInterval)`), so no spurious timer-driven `'update'` events
- The provider broadcasts on `'change'` (only actual state changes hit the wire — preserving DO hibernation). Our handler processing `'update'` is receive-side only.
- Self-filter via `cachedLocalClientId` prevents processing own state
- Processing identical cursor data is harmless (same target = no visual change)
- `invalidateOverlay()` is idempotent within a RAF frame

### Lifecycle

```
RoomDocManagerImpl constructor
  → initPresenceIdentity()                       // sets localUserId in store, no awareness
  → ... async init() ...
  → initializeWebSocketProvider()
    → new YProvider(host, room, ydoc, opts)       // provider auto-creates awareness (no awareness option passed)
    → attach(provider, onStatusChange)
      → currentAwareness = provider.awareness
      → caches localClientId
      → wires awareness.on('update', handler)
      → wires provider.on('status', handler)

RoomDocManager.destroy()
  → detach()
    → stops timer (prevent flush during teardown)
    → awareness.setLocalState(null)               // signal departure (WS still open)
    → awareness.off('update', handler)
    → provider.off('status', handler)
    → clears send state + peerCursors + bitmap cache
    → does NOT destroy awareness (provider owns it)
  → provider.disconnect()                         // closes WebSocket
  → provider.destroy()                            // removes provider's own 'change' listener
  → ydoc.destroy()                                // triggers awareness auto-destroy via doc.on('destroy')
```

Key ordering: `detach()` runs before `provider.disconnect()` so the departure signal broadcasts while the WebSocket is still open. Timer stops first in `detach()` to prevent `flush()` from firing during teardown.

### Animation Registration

```
OverlayRenderLoop.start()
  → controller.register(new CursorAnimationJob())
  → controller.setInvalidator(() => this.invalidateAll())

OverlayRenderLoop.frame()
  → full clear
  → world transform → drawToolPreview()
  → restore
  → controller.run(ctx, now)                  // screen-space, each job does own transform
    → CursorAnimationJob.frame(ctx, now, dt)
      → peers = getPeerCursors()
      → if peers.size === 0 → return false    // clientId-based, correct for multi-tab
      → ctx.setTransform(dpr, 0, 0, dpr, 0, 0)  // screen-space
      → ... smoothing + drawImage per peer ...
      → returns true if any peer animating → controller self-invalidates
```

### UserAvatarCluster

- Reads `peerIdentities` from `usePresenceStore` directly (no hook wrapper)
- Always renders "ME" avatar
- Renders peer avatars (up to 4) + "ME" badge + overflow count
- Peer avatars naturally empty when alone (no explicit alone check)

---

## Wire Format

Awareness state sent via y-protocols:

```typescript
{
  userId: string,       // ULID, stable per browser profile (localStorage)
  name: string,         // e.g. "Witty Penguin"
  color: string,        // e.g. "#5B8DEF"
  cursor?: {
    x: number,          // integer world coordinates
    y: number
  }
}
```

- `setLocalState(fullState)` — on connect/reconnect (identity + cursor)
- `setLocalStateField('cursor', cursor)` — on cursor move (only cursor field, y-protocols merges internally)
- `setLocalState(null)` — on disconnect (signals departure)

---

## WebSocket Protocol (ws vs wss)

YProvider auto-selects the protocol based on the host:

- `ws` for localhost, 127.0.0.1, private IPs (192.168.x, 10.x, 172.16-31.x) — local dev
- `wss` for all other hosts — production

The host is `window.location.host`. No explicit `protocol` option is passed — the auto-detection handles dev and production correctly.

---

## Color Palette

`lib/user-identity.ts` defines 16 high-contrast colors:

```
#E8915A warm orange     #5B8DEF blue          #E05D6F rose          #4CAF7D green
#C77DDB purple          #D4A843 gold          #47B5B5 teal          #E57BA1 pink
#7E8CE0 indigo          #6BBF6B lime          #C96B4F terra cotta   #5DADE2 sky blue
#B5854E bronze          #8FBC5A olive         #DB7093 hot pink      #7DAFCB steel blue
```

Existing users keep their stored color (localStorage). New users get a random color from this palette.
