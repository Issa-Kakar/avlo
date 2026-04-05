# Presence/Awareness System — Architecture

**Last updated:** 2026-04-05
**Status:** Typechecks clean. Bugs remain (see Known Issues).

---

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `lib/presence.ts` | ~370 | All awareness logic: lifecycle, send (50ms throttle + backpressure), receive (mutable Map), store sync |
| `stores/presence-store.ts` | ~52 | Zustand store: `peerIdentities`, `peerCount`, `isAlone`, `localUserId` |
| `canvas/animation/CursorAnimationJob.ts` | ~100 | AnimationJob: exponential smoothing + viewport cull + `drawImage` |
| `canvas/animation/cursor-bitmap.ts` | ~115 | `OffscreenCanvas` → `ImageBitmap` per `color:name`, no font-generation tracking |

### Integration Points (other files)

| File | What it does |
|------|--------------|
| `lib/room-doc-manager.ts` | Creates awareness in constructor, calls `attachListeners()` in `initializeWebSocketProvider()`, calls `detachAndDestroy()` in `destroy()` |
| `canvas/CanvasRuntime.ts` | Calls `updateCursor(worldX, worldY)` on pointer move, `clearCursor()` on pointer leave |
| `renderer/OverlayRenderLoop.ts` | Registers `CursorAnimationJob` as an animation job in `start()` |
| `components/UserAvatarCluster.tsx` | Reads `usePresenceStore` directly for peer avatars |

---

## Architecture

### Three Data Paths

```
SEND:
  CanvasRuntime.handlePointerMove
    → presence.updateCursor(worldX, worldY)
    → Math.round() quantize to integers
    → equality check against localCursor tuple
    → if isAlone (from presence store) → store locally, don't send
    → dirty flag → 50ms setTimeout → flush()
    → awareness.setLocalStateField('cursor', {x, y})

RECEIVE:
  awareness.on('change', handler)                [presence.ts]
    → for each changed clientId (excluding cachedLocalClientId):
      presence.processBatch()
        → processUpsert(): upsert into mutable peerCursors Map
        → if identity changed → rebuildStore() → usePresenceStore.setPeers()
    → invalidateOverlay()                        [kicks CursorAnimationJob]

RENDER:
  OverlayRenderLoop.frame()
    → AnimationController.run()
      → CursorAnimationJob.frame(ctx, now, dt)
        → fast exit if isAlone (from presence store)
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
                     │ createAwareness()       │  ← called in RoomDocManager constructor
                     │ attachListeners()       │  ← called in initializeWebSocketProvider()
                     │ detachAndDestroy()      │  ← called in RoomDocManager.destroy()
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
                         │ isAlone          │          ▲ reads
                         │ localUserId      │          │
                         └────────┬─────────┘  ┌──────┴──────────────────┐
                                  │            │ CursorAnimationJob.ts   │
                                  │ reads      │ frame(ctx, now, dt)     │
                                  ▼            └─────────────────────────┘
                     ┌────────────────────────┐
                     │ UserAvatarCluster.tsx   │
                     │ reads peerIdentities,  │
                     │ isAlone                │
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
- Contains: `peerIdentities: Map<userId, {name, color}>`, `peerCount`, `isAlone`, `localUserId`
- Updated via `setPeers()` only when identities change (peer add/remove/name change — rare)
- **`setPeers()` filters out localUserId:** entries where `userId === localUserId` are excluded before storing
- `isAlone` and `peerCount` are computed from the **filtered** map (unique userIds, excluding self)
- Read by React components (UserAvatarCluster) and by send/render paths (isAlone optimization)

### PeerCursorState Shape

```typescript
interface PeerCursorState {
  userId: string;
  name: string;
  color: string;
  target: [number, number];   // from network (integer quantized)
  display: [number, number];  // written by CursorAnimationJob each frame
  hasCursor: boolean;          // false when cursor cleared or peer has no cursor
  isSettled: boolean;          // true when |display - target| < 0.5px in canvas space
}
```

### Identity & ClientId

- **userId:** Stable per-user (stored in localStorage via `userProfileManager`). Same across tabs for the same browser profile.
- **clientId:** `Y.Doc.clientID` — unique per Y.Doc instance, meaning unique per tab. Two tabs of the same user have different clientIds but the same userId.
- `cachedLocalClientId` is set once in `attachListeners()` from `awareness.clientID`. Used to filter self in `processBatch()`.

### How `isAlone` is Computed

1. `processBatch()` processes awareness changes, adding/removing entries in `peerCursors` (keyed by **clientId**)
2. On identity changes, `rebuildStore()` builds a `Map<userId, PeerIdentity>` from all peerCursors entries — this dedupes by userId (latest values win)
3. `setPeers()` in the store filters out entries where `userId === localUserId`
4. `isAlone = filtered.size === 0` — true when no **other users** are present

**Current bug:** `isAlone` is based on unique *userIds* (excluding self). But `isAlone` is used in two places:
- **Send path** (`updateCursor`): if `isAlone`, don't schedule send → but same-user-other-tab has a different clientId that might want to see the cursor, and isAlone=true means we won't send to it
- **Render path** (`CursorAnimationJob.frame`): if `isAlone`, fast exit → but peerCursors map may have entries for same-user-other-tab clientIds, which we'd want to draw

The **clientId count** (peerCursors.size) is what actually determines if we need to send/draw. The **userId count** (filtered store) is what the avatar UI should use. Currently both paths use the userId-based `isAlone`, which is incorrect for the send/draw optimization. See Known Issues.

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

- Rendered on `OffscreenCanvas` at 2× scale for retina
- Pointer shape: Figma-style tail-less cursor, ~18px tall, filled with user color, dark outline
- Pointer tip offset at (1, 1) for slight left bias
- Label: pill-shaped `roundRect` with user color fill, luminance-based text color (dark or white)
- Label gap: 6px horizontal, 16px vertical from pointer tip
- Font: Inter 12px 500 weight (fonts always loaded before canvas — `main.tsx` awaits `ensureFontsLoaded()`)
- Cache key: `${color}:${name}` — no font-generation tracking
- On cache miss: renders bitmap synchronously (cheap — single offscreen canvas draw)
- `clearBitmapCache()` called on room disconnect via `detachAndDestroy()`

### Send Module Details

- **Quantization:** `Math.round(worldX)` — integer world units
- **Throttle:** Deterministic 50ms `setTimeout` (20Hz). No RAF, no jitter, no monitor dependency.
- **isAlone optimization:** If `usePresenceStore.getState().isAlone`, stores cursor locally but doesn't schedule send (see bug in Known Issues)
- **Backpressure:** Reads `provider.ws.bufferedAmount` in `flush()`:
  - `> 512KB` → reschedule at 200ms (5Hz)
  - `> 128KB` → reschedule at 100ms (10Hz)
  - Normal → 50ms (20Hz)
- **`setLocalStateField('cursor', cursor)`:** Sends only cursor field, not full state. y-protocols internally merges with existing local state.
- **`sendFullState()`:** Called on WS connect/reconnect. Sends `setLocalState({userId, name, color, cursor})` — full state for DO hibernation recovery.
- **Mobile detection:** Uses `isMobile()` from camera-store (cached result). On mobile, sends `undefined` cursor.
- **Null guard:** `updateCursor()` and `clearCursor()` return early if `currentAwareness` is null (safety for tab restore).

### Receive Module Details

- **`processBatch(added, updated, removed, getState)`:** Called from the `'change'` event handler. Filters `cachedLocalClientId` (self).
- **`processUpsert(clientId, state)`:** Upserts into `peerCursors` map. On first cursor sample after having none, snaps display to target (no smoothing). Returns `true` if identity (name/color/userId) changed.
- **`rebuildStore()`:** Builds `Map<userId, PeerIdentity>` from all peerCursors entries. Passes to `usePresenceStore.setPeers()` which filters out `localUserId`.
- **Stale cursor clear:** On WS `'connected'` status, clears `peerCursors` and rebuilds store before `sendFullState()`. Awareness sync from DO repopulates current peers.

### Status Handler

Single `provider.on('status', statusHandler)` in `attachListeners()` handles both:
1. **Presence module internals:** `connected` flag, `sendFullState()` on connect, state reset on disconnect, `awareness.setLocalState(null)` to signal departure
2. **RoomDocManager callback:** `onStatusChange?.(boolean)` sets `wsConnected` and resets `wsRepacked` on disconnect

### Awareness Event: `'change'` not `'update'`

- `'change'` only fires when `equalityDeep` in y-protocols detects actual state differences
- `'update'` fires unconditionally on every awareness protocol message
- Using `'change'` gives free dedup — no wasted processBatch calls for unchanged state
- Verified in y-protocols source: `applyAwarenessUpdate` builds `filteredUpdated` list using `equalityDeep`, only emits `'change'` if `added.length > 0 || filteredUpdated.length > 0 || removed.length > 0`

### Lifecycle

```
RoomDocManagerImpl constructor
  → createAwareness(ydoc)                    // creates YAwareness, sets localUserId in store
  → ... async init() ...
  → initializeWebSocketProvider()
    → new YProvider(..., { awareness })       // provider gets awareness reference
    → attachListeners(awareness, provider, onStatusChange)
      → caches localClientId
      → wires awareness.on('change', handler)
      → wires provider.on('status', handler)

RoomDocManager.destroy()
  → detachAndDestroy(awareness, provider)
    → awareness.setLocalState(null)           // signal departure
    → awareness.off('change', handler)
    → provider.off('status', handler)
    → awareness.destroy()
    → clears send state (timer, dirty, cursors)
    → clears peerCursors map + rebuilds store
    → clearBitmapCache()
```

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
      → ctx.setTransform(dpr, 0, 0, dpr, 0, 0)  // screen-space
      → ... smoothing + drawImage per peer ...
      → returns true if any peer animating → controller self-invalidates
```

### UserAvatarCluster

- Reads `peerIdentities` and `isAlone` from `usePresenceStore` directly (no hook wrapper)
- Returns `null` when `isAlone` is true
- Renders peer avatars (up to 4) + "ME" badge + overflow count
- **Bug:** Returns `null` when alone, but the "ME" avatar should always be present regardless of peer count. See Known Issues.

---

## Known Issues

### 1. `isAlone` Conflates ClientId Count with UserId Count

**The problem:**
`isAlone` is computed from unique *userIds* excluding self. It's used in:
- **Send path** (presence.ts:199): `if (isAlone) return` — skips scheduling cursor send
- **Render path** (CursorAnimationJob.ts:30): `if (isAlone) return false` — skips rendering entirely

But `peerCursors` is keyed by **clientId**. Same user with 2 tabs = 2 clientIds, 1 userId. After userId dedup + self-filter, `isAlone = true`. So:
- **Send:** We don't send cursor updates to our own other tab (which does want to draw them)
- **Render:** We don't draw cursors from our own other tab (they're in peerCursors but CursorAnimationJob fast-exits)

**What it should be:**
Two separate concepts:
- `isAlone` (userId-based, self-filtered) → for avatar UI: "are there other people here?"
- `hasRemoteClients` or similar (clientId-based: `peerCursors.size > 0`) → for send/render optimization: "does anyone need my cursor data?"

The component should use userId-based count. The send and render paths should use clientId-based count.

### 2. UserAvatarCluster Returns `null` When Alone

The component returns `null` when `isAlone`, hiding the entire cluster including the "ME" avatar. The "ME" avatar should always be present — only the peer avatars should be conditional on having peers.

### 3. `isAlone` Used Before SetPeers on Tab With Only Self

When the store has `isAlone: true` (initial state) and the only other awareness client is the same user on another tab, `rebuildStore()` → `setPeers()` filters out localUserId → `isAlone` stays `true`. This means `updateCursor()` never sends, and `CursorAnimationJob.frame()` never renders, creating a chicken-and-egg: cursor data exists in peerCursors but is never drawn.

### 4. ESLint Warnings (Pragmatic `any` Casts)

```
presence.ts:
  Line 151: (provider as any).off?.(...)     — provider type doesn't expose .off()
  Line 160: (awareness as any).destroy()     — awareness type doesn't expose .destroy()
  Line 161: (awareness as any).destroy       — typeof check
  Line 248: (currentProvider as any)?.ws      — provider.ws is internal
```

### 5. Cursor-Not-Rendering on Idle Tab (Intermittent)

User reports: two monitors, both tabs visible, cursor moves on tab A but doesn't render on tab B until user moves cursor on tab B. Y.Doc updates work fine, so WS is connected.

**Why moving cursor on tab B "fixes" it:** `updateCursor()` → `setLocalStateField()` → emits local `'change'` event → changeHandler fires → `invalidateOverlay()` → overlay frame renders → CursorAnimationJob reads peerCursors (which has accumulated updates) → renders.

**Root cause candidates:**
1. The `isAlone` fast-exit (bug #1 above) — most likely
2. DO hibernation not forwarding awareness updates while Y.Doc sync works
3. y-partyserver provider awareness sync issue

### 6. Stale Cursors on Room Leave / Refresh

When a peer refreshes, their old awareness state lingers on other clients until y-protocols' 30-second timeout. The `peerCursors.clear()` on reconnect (status 'connected') helps for the reconnecting client but doesn't help other clients that still see the stale state.

### 7. Room Undefined Error on Ctrl+Shift+T

On tab restore, code may execute before `connectRoom()` runs from route `beforeLoad`. `updateCursor()` has a null guard (`if (!currentAwareness) return`) but other code paths (e.g., tools, render loops calling into room-runtime) may throw `getActiveRoom(): no active room`.

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

## Color Palette

`lib/user-identity.ts` defines 16 high-contrast colors:

```
#E8915A warm orange     #5B8DEF blue          #E05D6F rose          #4CAF7D green
#C77DDB purple          #D4A843 gold          #47B5B5 teal          #E57BA1 pink
#7E8CE0 indigo          #6BBF6B lime          #C96B4F terra cotta   #5DADE2 sky blue
#B5854E bronze          #8FBC5A olive         #DB7093 hot pink      #7DAFCB steel blue
```

Existing users keep their stored color (localStorage). New users get a random color from this palette.
