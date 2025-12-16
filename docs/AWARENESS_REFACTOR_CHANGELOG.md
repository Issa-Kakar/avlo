# Awareness Manager Refactor - Changelog

**Date:** 2025-12-15
**Status:** FOUNDATIONAL SLICES COMPLETE - Ready for Integration
**Branch:** `cleanup/legacy-renderer-cleanup`

---

## Summary

This changelog documents the first phase of the AwarenessManager refactor. The foundational classes have been created and the codebase compiles cleanly. The next agent needs to integrate these new classes into RoomDocManager and OverlayRenderLoop.

---

## Files Created

### 1. `client/src/lib/awareness-manager.ts` (~400 lines)

**Purpose:** Dedicated class for awareness state management, extracted from RoomDocManager.

**Key Features:**
- Local cursor position and activity state management
- Awareness sending with backpressure handling (via callback pattern)
- Peer cursor tracking (raw data, no interpolation)
- Subscription mechanism for peer cursor changes
- Uses lodash/throttle for rate limiting (replaces custom throttle)

**Public API:**
```typescript
class AwarenessManager {
  readonly clientId: number;

  // Local state updates
  updateCursor(worldX: number | undefined, worldY: number | undefined): void;
  updateActivity(activity: 'idle' | 'drawing' | 'typing'): void;
  updateProfile(profile: { name: string; color: string }): void;

  // Peer access
  getPeerCursors(): ReadonlyMap<number, PeerCursor>;
  subscribe(cb: PeerCursorsSubscriber): () => void;

  // Gate lifecycle (called by RoomDocManager)
  onGateOpen(): void;   // When awarenessReady gate opens
  onGateClose(): void;  // When awarenessReady gate closes

  // Cleanup
  destroy(): void;
}
```

**Constructor requires:**
```typescript
interface AwarenessManagerOptions {
  userId: string;
  userProfile: { name: string; color: string };
  yAwareness: YAwareness;
  checkBackpressure: BackpressureChecker;  // Callback to check WS buffer
  isGateOpen: () => boolean;               // Callback to check awarenessReady gate
}
```

---

### 2. `client/src/renderer/presence-interpolator.ts` (~160 lines)

**Purpose:** Render-time cursor interpolation, replacing the interpolation logic in RoomDocManager.

**Key Features:**
- Per-peer smoothing state management
- Seq-based gap detection (snap vs lerp)
- 66ms interpolation window for responsiveness
- Designed for future AnimationController integration

**Public API:**
```typescript
class PresenceInterpolator {
  // Called when peer data changes (from AwarenessManager subscription)
  onPeersChanged(peers: ReadonlyMap<number, PeerCursor>, now: number): void;

  // Called at render time to get smoothed positions
  getInterpolatedCursors(peers: ReadonlyMap<number, PeerCursor>, now: number): InterpolatedCursor[];

  // For render loop invalidation decisions
  isAnimating(now: number): boolean;
  needsOverlayInvalidation(): boolean;

  // Cleanup
  clear(): void;
}
```

---

## Files Modified

### 1. `client/src/renderer/layers/presence-cursors.ts`

**Changes:** Simplified from ~356 lines to ~140 lines

**Removed:**
- All cursor trail code (~280 lines)
- CursorTrail interface and state
- TrailProfile configuration
- Catmull-Rom resampling
- Trail lifecycle management
- Decay/fade logic

**Kept:**
- `drawCursorPointer()` - Arrow cursor glyph
- `drawNameLabel()` - Name pill rendering
- `clearCursorTrails()` - Now a no-op stub for backward compatibility

**New APIs:**
```typescript
// Legacy API (current OverlayRenderLoop uses this)
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  presence: PresenceView,          // From snapshot
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean; firstSnapshot: boolean }
): void;

// New API (for future integration with PresenceInterpolator)
export function drawCursorsFromInterpolator(
  ctx: CanvasRenderingContext2D,
  cursors: InterpolatedCursor[],   // From PresenceInterpolator
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean }  // Only needs awarenessReady
): void;
```

---

### 2. `client/package.json`

**Added dependency:** `@types/lodash` (devDependencies)

---

## What Remains (For Next Agent)

### Phase 1: Integrate AwarenessManager into RoomDocManager

**In `room-doc-manager.ts`:**

1. **Add imports:**
```typescript
import { AwarenessManager, BackpressureChecker } from './awareness-manager';
```

2. **Add field:**
```typescript
private awarenessManager: AwarenessManager | null = null;
```

3. **Create backpressure checker factory:**
```typescript
private createBackpressureChecker(): BackpressureChecker {
  return () => {
    try {
      const ws: WebSocket | undefined = (this.websocketProvider as any)?.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return { shouldSkip: false, shouldDegrade: false, shouldRecover: false };
      }
      const bufferedAmount = ws.bufferedAmount ?? 0;
      const high = bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_HIGH_BYTES;
      const critical = bufferedAmount > AWARENESS_CONFIG.WEBSOCKET_BUFFER_CRITICAL_BYTES;
      return {
        shouldSkip: high,
        shouldDegrade: critical,
        shouldRecover: !high,
      };
    } catch {
      return { shouldSkip: false, shouldDegrade: false, shouldRecover: false };
    }
  };
}
```

4. **Initialize in constructor (after yAwareness creation):**
```typescript
this.awarenessManager = new AwarenessManager({
  userId: this.userId,
  userProfile: this.userProfile,
  yAwareness: this.yAwareness,
  checkBackpressure: this.createBackpressureChecker(),
  isGateOpen: () => this.gates.awarenessReady,
});
```

5. **Replace public methods:**
```typescript
public updateCursor(worldX: number | undefined, worldY: number | undefined): void {
  this.awarenessManager?.updateCursor(worldX, worldY);
}

public updateActivity(activity: 'idle' | 'drawing' | 'typing'): void {
  this.awarenessManager?.updateActivity(activity);
}
```

6. **Add public accessor:**
```typescript
public getAwarenessManager(): AwarenessManager | null {
  return this.awarenessManager;
}
```

7. **Update gate handlers:**
```typescript
// In _onWebSocketStatus handler, when awarenessReady opens:
this.awarenessManager?.onGateOpen();

// When awarenessReady closes:
this.awarenessManager?.onGateClose();
```

8. **Update destroy():**
```typescript
this.awarenessManager?.destroy();
this.awarenessManager = null;
```

9. **DELETE from RoomDocManager** (after integration verified):
- Lines 168-187: Old awareness state fields (`localActivity`, `awarenessIsDirty`, `localCursor`, etc.)
- Lines 269-275: Old throttle setup
- Lines 370-440: `ingestAwareness()`, `getDisplayCursor()`
- Lines 491-606: Old `sendAwareness()` pipeline
- Lines 609-650: Old `updateCursor()`, `updateActivity()`
- Lines 814-851: Custom throttle implementation
- Lines 1394-1436: Old `_onAwarenessUpdate` handler (move to use AwarenessManager subscription)
- `peerSmoothers` Map and `presenceAnimDeadlineMs` (interpolation moved to PresenceInterpolator)

---

### Phase 2: Update OverlayRenderLoop

**In `OverlayRenderLoop.ts`:**

1. **Add imports:**
```typescript
import { PresenceInterpolator, InterpolatedCursor } from './presence-interpolator';
import { drawCursorsFromInterpolator } from './layers/presence-cursors';
```

2. **Add fields:**
```typescript
private presenceInterpolator = new PresenceInterpolator();
private awarenessUnsub: (() => void) | null = null;
private peerCursors: ReadonlyMap<number, PeerCursor> = new Map();
```

3. **In start(), subscribe to AwarenessManager:**
```typescript
const awarenessManager = getActiveRoomDoc()?.getAwarenessManager();
if (awarenessManager) {
  this.awarenessUnsub = awarenessManager.subscribe((peers) => {
    this.peerCursors = peers;
    this.presenceInterpolator.onPeersChanged(peers, performance.now());
    if (this.presenceInterpolator.needsOverlayInvalidation()) {
      this.invalidateAll();
    }
  });
}
```

4. **In frame(), replace presence drawing:**
```typescript
// Replace the current drawPresenceOverlays call with:
const gates = getGateStatus();
if (gates.awarenessReady && this.peerCursors.size > 0) {
  const now = performance.now();
  const cursors = this.presenceInterpolator.getInterpolatedCursors(this.peerCursors, now);
  ctx.save();
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  drawCursorsFromInterpolator(ctx, cursors, view, { awarenessReady: gates.awarenessReady });
  ctx.restore();

  // Keep animating if interpolation in progress
  if (this.presenceInterpolator.isAnimating(now)) {
    this.invalidateAll();
  }
}
```

5. **In stop()/destroy():**
```typescript
this.awarenessUnsub?.();
this.awarenessUnsub = null;
this.presenceInterpolator.clear();
```

---

### Phase 3: Remove Presence from Snapshot (Future)

Once the above integration is complete and verified:

1. Remove `presence: PresenceView` from `Snapshot` interface in `packages/shared/src/types/snapshot.ts`
2. Remove `presence` from `createEmptySnapshot()`
3. Remove `buildPresenceView()` from RoomDocManager
4. Remove `presence: this.buildPresenceView()` from `buildSnapshot()`
5. Remove `presenceSubscribers` and `subscribePresence()` if no longer needed
6. Update any code that reads `snapshot.presence` to use AwarenessManager subscription

---

### Phase 4: Gate System Simplification (Future)

Per user feedback, gates are primarily for **internal RoomDocManager use** (race condition handling), not UI. Consider:

1. Keep gates internal (no Zustand store needed)
2. Simplify `use-connection-gates.ts` to only expose what UI actually needs
3. Consider removing `firstSnapshot` gate (RenderLoop already renders on docVersion)

---

## Key Design Decisions

1. **Backpressure via callback** - AwarenessManager receives a `checkBackpressure` callback instead of accessing WebSocket internals directly. This keeps WebSocket management in RoomDocManager.

2. **Gate check via callback** - AwarenessManager receives an `isGateOpen` callback instead of importing gate state. This avoids circular dependencies.

3. **No interpolation in AwarenessManager** - Raw peer cursor data only. Interpolation is a render-time concern handled by PresenceInterpolator.

4. **Lodash throttle** - Replaces custom throttle implementation for battle-tested rate limiting.

5. **Mobile checks removed** - The arbitrary mobile restrictions in awareness sending have been removed from AwarenessManager.

6. **Backward compatible APIs** - presence-cursors.ts exports both old API (for current code) and new API (for integration).

---

## Verification

Run typecheck to verify everything compiles:
```bash
npm run typecheck
```

The codebase currently compiles cleanly with all foundational slices in place.

---

## Files to Review

| File | Status | Notes |
|------|--------|-------|
| `client/src/lib/awareness-manager.ts` | NEW | Complete, ready for integration |
| `client/src/renderer/presence-interpolator.ts` | NEW | Complete, ready for integration |
| `client/src/renderer/layers/presence-cursors.ts` | MODIFIED | Trails removed, dual API |
| `client/src/lib/room-doc-manager.ts` | NEEDS INTEGRATION | See Phase 1 above |
| `client/src/renderer/OverlayRenderLoop.ts` | NEEDS INTEGRATION | See Phase 2 above |

---

*Changelog created 2025-12-15*
