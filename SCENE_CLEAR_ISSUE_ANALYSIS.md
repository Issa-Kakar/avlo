# Scene Clear Issue Analysis - Avlo Whiteboard

Verdict on the agent’s analysis

The diagnosis—missing full-canvas invalidation when scene changes—is correct and matches both your logs and the renderer contract. Your logs show the data layer is filtering strokes to the new scene, yet stale pixels remain visible, which can only happen if the renderer didn’t wipe the surface.

The proposed fix—track lastRenderedScene and force a full clear—is the right change and belongs in the render loop (not only in React or the canvas wrapper).

Alignment with OVERVIEW.MD / IMPLEMENTATION.MD

Scene derivation & filtering: Snapshot must derive scene from meta.scene_ticks.length and filter strokes/text to the current scene. Your logs show exactly that, and the spec requires it.

Canvas/dirty-rect rule: Dirty-rect culling is allowed only when the transform is unchanged; a global visibility change (like a scene jump) should behave like a transform change—i.e., full clear first. The agent’s plan matches this rule.

svKey purpose: The snapshot must include an svKey derived from the Yjs state vector for diagnostics only. In Phase 6 it is not used to gate publishing or long-running tasks. IMPLEMENTATION.MD repeats this: remove svKey gating from the rAF publish loop; any doc-dirty event triggers a publish unconditionally.

Bottom line: the agent’s approach is consistent with the spec on all three fronts.

What to do with svKey in Canvas

Given the spec, you should not use svKey to decide when/what to render:

Keep svKey in the Snapshot (diagnostics, logging, tooling). That’s required by the snapshot contract.

You already removed svKey gating from the rAF publish loop (good and required).

In Canvas/RenderLoop, stop keying invalidation off svKey. Treat any new snapshot as “content may have changed,” and then:

If scene changed → set mustFullClear = true and drop scene-scoped caches.

Else if transform changed → full clear (existing rule).

Else → use dirty-rects for incremental redraw.

This keeps svKey where the spec wants it (diagnostics) and removes it from places the spec forbids (change gating).

Concrete, surgical changes

In your render loop (not just React wrapper), track and react to scene flips:

// Pseudocode inside RenderLoop
let lastRenderedScene = -1;
let mustFullClear = false;

function render(snapshot: Snapshot, ctx: CanvasRenderingContext2D, dpr: number) {
  if (snapshot.scene !== lastRenderedScene) {
    lastRenderedScene = snapshot.scene;
    mustFullClear = true;            // scene is a global visibility change
    dirtyRectTracker.invalidateAll(); // clear any accumulated rects
    strokeCache.clear?.();            // if you keep one around
  }

  if (transformChanged || mustFullClear) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    mustFullClear = false;
  }

  // …draw using dirty-rects only when neither scene nor transform changed
}


This matches the agent’s patch, just making the full clear an explicit, single responsibility of the render loop.

In your React Canvas.tsx, remove any useEffect that calls invalidateAll() based on snapshot.svKey changes. Instead, let the render loop handle scene/transform logic deterministically. (If you want a belt-and-suspenders, you may call invalidateAll('scene-change') when you detect snapshot.scene changed, but the render loop still performs the actual wipe.)

Ensure DirtyRectTracker.invalidateAll() distinguishes “must full clear once” from “entire surface marked dirty.” If invalidateAll() currently just adds one giant rect, you’ll still re-enter the incremental path; set a separate flag (mustFullClear) so you unconditionally call clearRect(...) at the top of the next frame.

Why this resolves the intermittent-then-bad phase

Your logs show: scene increments, snapshot filters to zero visible strokes, but old pixels remain; only after drawing do pieces disappear (the “eraser” look). That can only happen if the renderer skipped a full wipe on scene change. Adding the explicit scene-flip → full-clear closes that hole.

“svKey in canvas — keep or remove?” Keep svKey in the snapshot for diagnostics, but do not use it to gate rendering or invalidation in Canvas/RenderLoop. Use scene and transform for full clears, and otherwise rely on your normal dirty-rect flow. That’s exactly what OVERVIEW/IMPLEMENTATION specify for Phase 6.



## Executive Summary

After thorough investigation of the Avlo whiteboard implementation (Phases 2-6), we've identified the root cause of the "eraser effect" bug where cleared content remains visible until drawn over. The issue stems from a missing full canvas invalidation when scene changes occur, despite the data layer working correctly.

## The Problem

### Observed Behavior
1. Drawing and clearing works initially
2. After chaotic refreshing and clearing, old strokes remain visible after "Clear Board"
3. Drawing over old strokes creates an "eraser effect" - old pixels disappear only where new strokes are drawn
4. The issue becomes more apparent after multiple refreshes between clears

### Expected Behavior
When "Clear Board" is clicked, the canvas should immediately show a blank slate as the scene increments and filters out all previous strokes.

## Root Cause Analysis

### ✅ What's Working Correctly

1. **Data Layer (RoomDocManager)**
   - Scene ticks properly append to `meta.scene_ticks` array
   - `currentScene` correctly calculated as `sceneTicks.length`
   - Strokes properly filtered by `scene === currentScene` in `buildSnapshot()`
   - Extensive logging confirms correct filtering behavior

2. **Clear Board Implementation**
   - Button correctly increments scene by pushing timestamp to scene_ticks
   - Y.Doc updates trigger snapshot rebuild
   - New snapshots have correct scene number and filtered strokes

3. **Stroke Assignment**
   - Strokes get scene assigned at commit time (not gesture start)
   - Scene isolation working as designed

4. **WebSocket Issues (Separate)**
   - Configuration is correct but server was crashing due to corrupted Redis data
   - Fixed by flushing Redis (`redis-cli FLUSHALL`)

### ❌ What's Missing: Canvas Scene Change Handling

**The RenderLoop does NOT detect or handle scene changes for canvas clearing.**

Current full clear triggers:
- Transform changes (pan/zoom)
- Canvas resize
- Invalid transform state
- Manual `invalidateAll()` calls

Missing trigger:
- **Scene number changes**

### Why It Manifests Intermittently

The bug is masked initially by incidental full clears:
1. **Initial mount/resize**: Canvas dimension changes trigger full clears
2. **Transform settling**: Early frames often have transform changes
3. **Layout jitter**: CSS/container changes cause recomputation

After multiple refreshes:
- Canvas dimensions stabilize
- Transforms are already set
- No incidental full clears occur
- Bug becomes visible when only scene changes

## Technical Details

### Current Implementation Gaps

#### RenderLoop.ts (client/src/renderer/RenderLoop.ts)
- No `lastRenderedScene` tracking
- No scene change detection in snapshot updates
- Dirty rectangle optimization continues across scene boundaries

#### Canvas.tsx (client/src/canvas/Canvas.tsx)
- Invalidates on `svKey` changes but uses `invalidateAll('content-change')`
- This should trigger full clear but doesn't when scene is the only change

#### strokes.ts (client/src/renderer/layers/strokes.ts)
```typescript
// Only clears cache, not canvas pixels
if (snapshot.scene !== lastScene) {
  strokeCache.clear();
  lastScene = snapshot.scene;
}
```

### Data Flow on Clear Board

1. User clicks "Clear" → `handleClearCanvas()`
2. Scene tick pushed → `sceneTicks.push([timestamp])`
3. Y.Doc update → `handleYDocUpdate()` sets `isDirty = true`
4. RAF loop → `buildSnapshot()` with new `currentScene`
5. Filtering → Strokes with old scene excluded from snapshot
6. Canvas update → **PROBLEM: Only dirty rectangles cleared, old pixels remain**

## Solution

### Immediate Fix Required

Add scene change detection to RenderLoop:

```typescript
// In RenderLoop.ts
private lastRenderedScene = -1;

// In render method
if (snapshot.scene !== this.lastRenderedScene) {
  this.dirtyRectTracker.invalidateAll();
  this.strokeCache?.clear();
  this.lastRenderedScene = snapshot.scene;
  
  // Force full clear
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
```

### Implementation Locations

1. **client/src/renderer/RenderLoop.ts**
   - Add `lastRenderedScene` tracking
   - Detect scene changes in render loop
   - Force full clear on scene change

2. **client/src/renderer/DirtyRectTracker.ts**
   - Ensure `invalidateAll()` is called on scene changes
   - Clear dirty rect accumulation

3. **client/src/canvas/Canvas.tsx** (Optional)
   - Could explicitly detect scene changes and call `invalidateAll()`
   - Belt-and-suspenders approach

## Validation Strategy

### Quick Test
1. Draw strokes
2. Click "Clear"
3. Canvas should immediately be blank (no ghost strokes)
4. Drawing should work normally (no eraser effect)

### Regression Test
1. Draw → Clear → Refresh → Draw → Clear
2. Repeat chaotically
3. Should never see old strokes after clear

### Automated Test
Add Playwright test:
- Draw stroke at position A
- Clear board
- Sample pixels at position A (should be white)
- Draw at position B (position A should remain white)

## Additional Findings

### WebSocket Connection Resolution
- Server was crashing on corrupted Redis gzip data
- Fixed by running `redis-cli FLUSHALL`
- WebSocket configuration itself is correct
- Vite proxy properly forwards to server on port 3001

### Performance Considerations
- svKey no longer used for deduplication (performance improvement)
- RAF loop publishes immediately when dirty
- Dirty rectangle optimization works well except for scene changes

## Recommendations

### Immediate Actions
1. **Fix RenderLoop scene tracking** - Add scene change detection and full clear
2. **Add explicit logging** - Log when scene changes trigger full clears
3. **Test thoroughly** - Verify fix with chaotic refresh/clear sequences

### Future Improvements
1. **Error handling** - Add try/catch around Redis decompression
2. **Data validation** - Validate gzip headers before decompression
3. **Scene change events** - Consider explicit scene change events for cleaner architecture
4. **Visual feedback** - Add animation or flash when clearing board

## Conclusion

The clear board functionality is correctly implemented at the data layer - scene ticks increment, strokes filter properly, and snapshots rebuild correctly. The issue is purely a rendering concern where the canvas retains old pixels because the render loop doesn't recognize scene changes as requiring full canvas invalidation.

The fix is straightforward: track scene changes in the render loop and force full canvas clear when detected. This aligns with the architectural principle that global visibility changes (like scene transitions) should invalidate the entire canvas, not just dirty rectangles.

**Status**: Ready for implementation of scene change detection in RenderLoop.ts