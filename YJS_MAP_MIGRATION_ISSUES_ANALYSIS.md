# Y.Map Migration Issues Analysis

## Executive Summary

The Y.Map migration has two critical rendering issues:
1. **Initial Load Blank Canvas**: Objects exist in Y.Doc but don't render until user interaction
2. **Off-Screen Mutation Performance**: Off-screen changes trigger unnecessary on-screen re-renders

Both issues stem from architectural gaps in the dirty rect system during the migration from Y.Array to Y.Map<Y.Map>.

---

## Issue 1: Initial Load Blank Canvas

### Root Cause

The canvas appears blank on initial load because the **first snapshot after hydration has `dirtyPatch: null`**, preventing any invalidation from reaching the RenderLoop.

### The Chain of Events

#### 1. Initialization Sequence

```typescript
// room-doc-manager.ts constructor (line 245-338)
constructor() {
  this._currentSnapshot = createEmptySnapshot(); // docVersion: 0
  this.needsSpatialRebuild = true; // Flag for initial hydration
  this.startPublishLoop(); // RAF loop starts immediately
}
```

#### 2. IDB Sync Triggers Update

```typescript
// room-doc-manager.ts (line 1363-1406)
handleYDocUpdate = (update, origin) => {
  this.docVersion++; // 0 → 1
  this.sawAnyDocUpdate = true;
  this.publishState.isDirty = true; // Triggers buildSnapshot
}
```

#### 3. Hydration Clears Dirty Rects

```typescript
// room-doc-manager.ts (line 1321-1351)
private hydrateObjectsFromY(): void {
  this.objectsById.clear();
  this.spatialIndex.clear();
  this.dirtyRects.length = 0; // ← PROBLEM: Cleared but never populated!

  // Build handles from Y.Doc
  objects.forEach((yObj, key) => {
    const handle = { id, kind, y: yObj, bbox };
    this.objectsById.set(id, handle);
    handles.push(handle);
  });

  this.spatialIndex.bulkLoad(handles);
  // ← No dirtyRects.push() for initial objects!
}
```

#### 4. Deep Observer Disabled During Hydration

```typescript
// room-doc-manager.ts (line 1182-1233)
this.objectsObserver = (events, tx) => {
  if (this.needsSpatialRebuild) return; // ← Exits early during hydration!
  // Normal path would call applyObjectChanges() which pushes dirty rects
};
```

#### 5. First Snapshot Has No Dirty Patch

```typescript
// room-doc-manager.ts (line 1815-1822)
let dirtyPatch: DirtyPatch | null = null;
if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
  // Never enters because dirtyRects is empty!
  dirtyPatch = { rects: [...], evictIds: [...] };
}
// Result: dirtyPatch = null
```

#### 6. Canvas Receives Snapshot Without Invalidation

```typescript
// Canvas.tsx (line 109-142)
if (newSnapshot.docVersion !== lastDocVersion) {
  if (newSnapshot.dirtyPatch) { // ← FALSE on initial load!
    // This never runs
    for (const bounds of rects) {
      renderLoopRef.current.invalidateWorld(bounds);
    }
  }
  // No fallback for dirtyPatch === null
}
```

#### 7. Race Condition with firstSnapshot Gate

```typescript
// Canvas.tsx (line 311-320)
const gateStatus = roomDoc.getGateStatus();
if (gateStatus.firstSnapshot) { // ← FALSE during effect setup!
  // This code doesn't run because the gate opens AFTER
  setTimeout(() => renderLoop.invalidateAll('content-change'), 0);
}
```

### Why User Interaction "Fixes" It

Any interaction (zoom, draw, pan) triggers:
- `invalidateAll('transform-change')` OR
- New dirty rects with `dirtyPatch !== null`

Either path forces a canvas clear, revealing all existing objects.

### Verified Timeline

```
T0: Constructor creates EmptySnapshot (docVersion: 0)
T1: RenderLoop useLayoutEffect runs (firstSnapshot gate = false)
T2: IDB syncs → handleYDocUpdate → docVersion = 1
T3: RAF → buildSnapshot():
    - needsSpatialRebuild = true
    - hydrateObjectsFromY() clears dirtyRects
    - Returns snapshot with dirtyPatch = null
    - Opens firstSnapshot gate (too late!)
T4: Canvas receives snapshot:
    - docVersion changed (0 → 1)
    - dirtyPatch = null → no invalidation
    - CANVAS REMAINS BLANK
```

---

## Issue 2: Off-Screen Mutation Performance

### Root Cause

The dirty rect system **lacks viewport filtering**, causing off-screen mutations to trigger canvas operations for on-screen content.

### The Problematic Flow

#### 1. Off-Screen Mutation Occurs

```typescript
// User draws stroke at world coordinates far outside viewport
// e.g., x: 10000, y: 10000 when viewport shows 0-1000
```

#### 2. RoomDocManager Adds Dirty Rect Unconditionally

```typescript
// room-doc-manager.ts (lines 1257, 1298, 1305-1306, 1310)
private applyObjectChanges() {
  // New object
  this.dirtyRects.push(bboxToBounds(newBBox)); // No viewport check!

  // Changed object
  if (bboxChanged) {
    this.dirtyRects.push(bboxToBounds(oldBBox)); // No viewport check!
    this.dirtyRects.push(bboxToBounds(newBBox)); // No viewport check!
  }
}
```

#### 3. Canvas Invalidates All Dirty Rects

```typescript
// Canvas.tsx (line 131-134)
for (const bounds of rects) {
  renderLoopRef.current.invalidateWorld(bounds); // No viewport filter!
}
```

#### 4. DirtyRectTracker Accepts All Rects

```typescript
// DirtyRectTracker.ts (line 37-62)
invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform) {
  const [minX, minY] = viewTransform.worldToCanvas(bounds.minX, bounds.minY);
  const [maxX, maxY] = viewTransform.worldToCanvas(bounds.maxX, bounds.maxY);

  this.invalidateCanvasPixels({ x: minX, y: minY, ... });
  // No check if rect is within viewport!
}
```

#### 5. Union Calculation Includes Off-Screen

```typescript
// DirtyRectTracker.ts (line 153-161)
// Union of all dirty rects (including off-screen ones)
// Can promote to full clear when union > 33% of canvas
```

#### 6. RenderLoop Clears Based on All Dirty Rects

```typescript
// RenderLoop.ts (line 328-351)
// Clears canvas regions for ALL dirty rects
// Even if they're completely off-screen
```

### Performance Impact

**Current State:**
- 1000 off-screen strokes → 1000 dirty rects tracked
- Union calculation includes all 1000 bboxes
- Often promotes to full canvas clear (33% threshold)
- Canvas clears and re-renders despite no visible changes

**After Fix:**
- 1000 off-screen strokes → 0 dirty rects tracked
- No canvas operations at all
- True zero-cost for off-screen changes

### Why This Matters

The **drawObjects()** function correctly culls off-screen objects from rendering:

```typescript
// objects.ts (line 16)
const visibleBounds = getVisibleWorldBounds(...);
const entries = spatialIndex.query(visibleBounds); // ✅ Correct
```

But the **invalidation system** doesn't filter, causing:
1. Unnecessary canvas clear operations
2. Wasted CPU cycles on transform calculations
3. Potential full-clear promotion from large unions
4. Re-rendering of on-screen content when nothing visible changed

---

## Solutions

### Fix 1: Initial Load Blank Canvas

**Option A: Populate dirtyRects During Hydration (Recommended)**

```typescript
// room-doc-manager.ts, line 1343 (after building handles)
private hydrateObjectsFromY(): void {
  // ... existing code ...

  // NEW: Mark all initial objects as dirty
  handles.forEach(handle => {
    this.dirtyRects.push(bboxToBounds(handle.bbox));
  });

  // ... spatial index bulk load ...
}
```

**Why this is correct:** Hydration IS a content change. The manager should communicate this through its standard dirty rect mechanism.

**Option B: Canvas.tsx Fallback**

```typescript
// Canvas.tsx, line 135 (after dirtyPatch check)
if (newSnapshot.dirtyPatch) {
  // ... existing invalidation ...
} else if (lastDocVersion === 0 || lastDocVersion === -1) {
  // Initial load without dirtyPatch
  renderLoopRef.current.invalidateAll('content-change');
}
```

**Option C: Subscribe to firstSnapshot Gate**

```typescript
// Canvas.tsx, new effect
useEffect(() => {
  const unsub = roomDoc.subscribeGates((gates) => {
    if (gates.firstSnapshot && !hasRenderedInitial.current) {
      renderLoopRef.current?.invalidateAll('content-change');
      hasRenderedInitial.current = true;
    }
  });
  return unsub;
}, [roomDoc]);
```

### Fix 2: Off-Screen Mutation Performance

**Recommended: Filter at Canvas.tsx (Option 2)**

```typescript
// Canvas.tsx, line 124-134
if (newSnapshot.dirtyPatch) {
  const { rects, evictIds } = newSnapshot.dirtyPatch;

  // Evict cache (always, even for off-screen)
  const cache = getObjectCacheInstance();
  cache.evictMany(evictIds);

  // Get viewport for filtering
  const size = canvasSizeRef.current;
  if (size) {
    const viewport = getVisibleWorldBounds(
      size.cssWidth,
      size.cssHeight,
      viewTransformRef.current.scale,
      viewTransformRef.current.pan
    );

    // Only invalidate visible dirty regions
    for (const bounds of rects) {
      if (boundsIntersect(bounds, viewport)) {
        renderLoopRef.current.invalidateWorld(bounds);
      }
    }
  } else {
    // Fallback if viewport unknown
    for (const bounds of rects) {
      renderLoopRef.current.invalidateWorld(bounds);
    }
  }
}
```

**Add helper function:**

```typescript
// canvas/internal/transforms.ts
export function boundsIntersect(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX ||
           a.maxY < b.minY || a.minY > b.maxY);
}
```

**Why Canvas.tsx is the right place:**
1. Has access to viewport bounds
2. Maintains architectural boundaries (manager doesn't know viewport)
3. Single point of filtering before expensive transformations
4. Easy to add margin for edge cases

---

## Code Locations

### Issue 1: Initial Load
- **Root cause**: `/client/src/lib/room-doc-manager.ts:1330` (dirtyRects cleared but not populated)
- **Observer disabled**: `/client/src/lib/room-doc-manager.ts:1189` (needsSpatialRebuild check)
- **No invalidation**: `/client/src/canvas/Canvas.tsx:124` (dirtyPatch null check)
- **Race condition**: `/client/src/canvas/Canvas.tsx:313` (firstSnapshot gate check)

### Issue 2: Viewport Culling
- **Unconditional dirty rects**: `/client/src/lib/room-doc-manager.ts:1257,1298,1305,1310`
- **No viewport filter**: `/client/src/canvas/Canvas.tsx:133`
- **No bounds check**: `/client/src/renderer/DirtyRectTracker.ts:37-62`
- **Correct culling**: `/client/src/renderer/layers/objects.ts:16` (only in rendering)

---

## Additional Findings

### Cache Eviction Semantics

The new architecture correctly handles cache eviction:
- **Geometry changes** (bbox change) → Evict cache
- **Style changes** (color/opacity) → Keep cache, mark dirty
- **Width changes** → Evict (because bbox includes width padding)

This is more efficient than the previous variant-based system.

### Spatial Index Lifecycle

The two-epoch model works well:
1. **Rebuild epoch** (`needsSpatialRebuild = true`): Full hydration
2. **Steady state** (`needsSpatialRebuild = false`): Incremental updates

The spatial index is created once and reused, which is efficient.

### Memory Considerations

The `dirtyRects` array accumulates until `buildSnapshot()` runs. With high-frequency mutations, this could grow large. Consider:
- Coalescing overlapping rects earlier
- Capping array size with promotion to full clear
- Using a Set to avoid duplicates

---

## Testing Recommendations

### Test Case 1: Initial Load
1. Clear browser storage
2. Load room with existing content
3. **Expected**: Content renders immediately
4. **Current**: Blank canvas until interaction

### Test Case 2: Off-Screen Drawing
1. Pan viewport to origin (0,0)
2. Have another user draw at (10000, 10000)
3. **Expected**: No canvas operations
4. **Current**: Full canvas re-render

### Test Case 3: Mass Off-Screen
1. Create 1000 strokes off-screen programmatically
2. Monitor performance metrics
3. **Expected**: Near-zero CPU usage
4. **Current**: High CPU, potential full clear

---

## Conclusion

Both issues stem from gaps in the dirty rect pipeline during the Y.Map migration:

1. **Initial hydration doesn't communicate content changes** through dirty rects
2. **Viewport filtering was never implemented** in the invalidation pipeline

The fixes are straightforward and maintain architectural boundaries. Implementing both will significantly improve perceived performance and initial load experience.