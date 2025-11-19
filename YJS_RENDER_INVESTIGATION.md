# Y.Map Rendering System - Deep Investigation Report

## Executive Summary
After deep investigation of the Y.Map migration rendering system, I've identified critical architectural flaws causing complete rendering failure on first load, broken dirty rect clipping, missing shape rendering, and severe technical debt from incomplete migration.

## Critical Issues Found

### 1. **FATAL: First Load Renders Nothing**
**Root Cause**: Race condition in two-epoch model initialization

**The Bug**:
```typescript
// In buildSnapshot():
if (this.needsSpatialRebuild) {
  this.hydrateObjectsFromY();  // Objects map is EMPTY on first load!
  this.needsSpatialRebuild = false;  // Now it's false forever
}

// In setupObjectsObserver():
this.objectsObserver = (events, tx) => {
  if (this.needsSpatialRebuild) return;  // IGNORES all incoming objects!
  // ... objects never get processed
}
```

**What Happens**:
1. App starts, `needsSpatialRebuild = true` (initial state)
2. `buildSnapshot()` runs BEFORE any objects exist
3. `hydrateObjectsFromY()` reads empty objects map, creates empty Maps
4. Sets `needsSpatialRebuild = false`
5. Later when objects are added (from IDB/WS), observer IGNORES them because `needsSpatialRebuild` was true when they arrived
6. Objects never make it into `objectsById` Map
7. Nothing renders

### 2. **Dirty Rect Clipping Completely Broken**

**Multiple Issues**:
- Clip regions are converted wrong from device → CSS → world coordinates
- The clipping path is created but viewport augmentation doesn't pass `clipRegion` correctly
- World rect conversion in RenderLoop lines 374-390 has inverted logic

**Broken Code**:
```typescript
// RenderLoop.ts line 374-390 - WRONG CONVERSION
const [worldX1, worldY1] = view.canvasToWorld(cssX, cssY);
const [worldX2, worldY2] = view.canvasToWorld(cssX + cssW, cssY + cssH);
// This produces wrong bounds when scale != 1
```

### 3. **Objects Not Rendering Due to Cache Failures**

**In object-cache.ts**:
```typescript
case 'stroke': {
  const points = y.get('points') as [number, number][];  // Expects tuples
  const width = y.get('width') as number;  // Field exists

  // BUT getStroke() from perfect-freehand expects Array<[x,y]>
  // If points is undefined or wrong format, returns empty Path2D
}

case 'shape': {
  const shapeType = y.get('shapeType') as string;  // THIS DOESN'T EXIST!
  const frame = y.get('frame') as [number, number, number, number];  // DOESN'T EXIST!
  // Strokes don't have shapeType or frame fields
}
```

**The Problem**:
- Cache builder expects fields that don't exist
- Strokes are stored with `kind: 'stroke'` but no `shapeType`
- Shapes aren't implemented yet but cache expects them

### 4. **Spatial Index Never Gets Objects**

**Issue Chain**:
1. `spatialIndex.bulkLoad(handles)` called with empty array on first load
2. Later objects added via observer but observer is muted
3. Spatial index remains empty
4. Query returns no results
5. Nothing renders

### 5. **Coordinate Transform Confusion**

**Three Different Transform Chains**:
```typescript
// Old strokes.ts:
const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);

// New objects.ts (line 280):
function getVisibleWorldBounds(viewTransform, viewport) {
  const [minX, minY] = viewTransform.canvasToWorld(0, 0);
  // Different implementation!
}

// RenderLoop.ts uses ANOTHER one:
import { getVisibleWorldBounds } from '../canvas/internal/transforms';
```

### 6. **ViewportInfo Inconsistency**

**Old Legacy Code Expected**:
```typescript
interface ViewportInfo {
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  clipRegion?: DirtyClipRegion;  // Optional
}
```

**But drawObjects() tries**:
```typescript
if (viewport.clipRegion?.worldRects) {  // May not exist
  // Query logic
}
```

## Data Flow Analysis

### Current (Broken) Flow:
```
1. Y.Doc creates empty 'objects' map
2. buildSnapshot() runs immediately
3. hydrateObjectsFromY() reads empty map
4. spatialIndex gets no data
5. needsSpatialRebuild = false (CRITICAL ERROR)
6. Objects arrive from IDB/network
7. Observer IGNORES them (needsSpatialRebuild was true)
8. objectsById Map stays empty
9. Render queries empty spatial index
10. Nothing draws
```

### Expected Flow:
```
1. Y.Doc creates empty 'objects' map
2. Objects arrive from IDB/network
3. Observer processes them into objectsById
4. Spatial index gets updated
5. buildSnapshot() packages current state
6. Render queries spatial index
7. Objects render
```

## Architecture Problems

### 1. **Two-Epoch Model is Backwards**
- `needsSpatialRebuild` starts `true` but should start `false`
- Hydration should only happen when objects actually exist
- Observer shouldn't be muted during initial load

### 2. **No Clear Separation of Concerns**
```
RoomDocManager does TOO MUCH:
- Y.Doc management
- Spatial indexing
- Dirty tracking
- Cache eviction
- Coordinate transforms
- Presence interpolation
- Gates management
```

### 3. **Mixed Paradigms**
- Old: Y.Array with StrokeView/TextView clones
- New: Y.Map with direct references
- Reality: Half-migrated mess with both patterns

### 4. **Caching is Confused**
- Cache expects shapes with `shapeType` field
- Strokes don't have shape fields
- Perfect shapes aren't implemented
- Cache builds empty Path2D on error (silent failure)

### 5. **Rendering Layers are Misaligned**
```typescript
// RenderLoop calls:
drawObjects(ctx, snapshot, view, viewport);  // New unified
drawText(ctx, snapshot, view, viewport);     // Stub that does nothing

// But drawObjects handles text internally!
```

## Unused Code (Technical Debt)

### Variables Never Used:
- `RenderLoop.ts`: `boxesIntersect` function (line 24)
- `objects.ts`: `renderedCount`, `culledCount` variables
- Multiple unused imports across files

### Dead Code Paths:
- `drawText()` in layers/index.ts - empty stub
- `drawShapes()` - placeholder never called
- Old spatial index references

## Root Cause: Incomplete Migration

The migration from Y.Array to Y.Map was done hastily without understanding:
1. **Initialization sequence** - when data actually arrives
2. **Observer lifecycle** - when to mute/unmute
3. **Coordinate systems** - which space each operation works in
4. **Cache requirements** - what fields objects actually have
5. **Render pipeline** - how layers compose

## Proposed Solution Architecture

### Phase 1: Fix Critical Rendering
```typescript
// 1. Fix two-epoch model
private needsSpatialRebuild = false;  // Start FALSE, not true

// 2. Only hydrate when needed
if (objects.size > 0 && this.objectsById.size === 0) {
  this.hydrateObjectsFromY();
}

// 3. Never mute observer on first load
if (this.initialized && this.needsSpatialRebuild) return;
```

### Phase 2: Separate Concerns
```
ObjectStore:
  - Manages objectsById Map
  - Handles Y.Map observers
  - Computes bboxes

SpatialIndex:
  - Pure spatial queries
  - Bulk load / incremental updates

DirtyTracker:
  - World bounds → device rects
  - Coalescing logic

RenderCache:
  - Path2D generation
  - Eviction by ID
```

### Phase 3: Clean Architecture
```typescript
interface RenderObject {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  path?: Path2D;  // Optional, built on demand
  bbox: [number, number, number, number];
  style: RenderStyle;
}

class ObjectRenderer {
  render(ctx: Context, objects: RenderObject[], viewport: Viewport): void {
    // Single, clean render path
  }
}
```

## Immediate Fixes Required

### 1. **Fix First Load** (CRITICAL)
```typescript
// In RoomDocManager constructor:
this.needsSpatialRebuild = false;  // Start false

// In setupObjectsObserver:
this.objectsObserver = (events, tx) => {
  // Remove the needsSpatialRebuild check entirely
  // Process ALL events always
}

// In buildSnapshot:
if (this.objectsById.size === 0 && objects.size > 0) {
  // Only hydrate if we have data but haven't processed it
  this.hydrateObjectsFromY();
}
```

### 2. **Fix Cache Path2D Generation**
```typescript
case 'stroke': {
  const points = y.get('points');
  if (!points || !Array.isArray(points)) return new Path2D();

  // Ensure we handle tuple format correctly
  const tuples = points as [number, number][];
  const width = y.get('width') ?? y.get('size') ?? 1;  // Fallback

  // ... rest of PF generation
}
```

### 3. **Fix Dirty Rect Clipping**
```typescript
// Correct world rect calculation
const worldRects = clearInstructions.rects.map(deviceRect => {
  // Device → CSS
  const css = {
    x: deviceRect.x / viewport.dpr,
    y: deviceRect.y / viewport.dpr,
    w: deviceRect.width / viewport.dpr,
    h: deviceRect.height / viewport.dpr
  };

  // CSS → World (using correct transform)
  const [x1, y1] = view.canvasToWorld(css.x, css.y);
  const [x2, y2] = view.canvasToWorld(css.x + css.w, css.y + css.h);

  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2)
  };
});
```

### 4. **Remove Dead Code**
- Delete empty `drawText()` stub
- Remove unused `boxesIntersect`
- Clean up legacy imports
- Remove `drawShapes` placeholder

## Testing Strategy

### Test Cases Needed:
1. **Cold start**: Clear IDB, no server data → should show empty canvas
2. **Hot reload**: Existing data in IDB → should render immediately
3. **Add stroke**: Draw → should appear instantly
4. **Refresh**: F5 → should maintain all strokes
5. **Dirty rect**: Modify one stroke → only that region repaints
6. **Pan/zoom**: Transform → proper coordinate mapping

## Performance Considerations

### Current Issues:
- Full hydration on every `needsSpatialRebuild`
- No incremental spatial index updates working
- Cache evicts too aggressively
- Dirty rects never coalesce properly

### Optimizations Needed:
1. Incremental spatial updates only
2. Lazy Path2D generation
3. Smarter cache eviction (by bbox, not ID)
4. Proper dirty rect coalescing

## Conclusion

The Y.Map migration introduced a fundamentally broken initialization sequence that prevents any rendering on first load. The two-epoch model is inverted, the observer muting happens at the wrong time, and the cache expects fields that don't exist.

This is not a minor bug - it's an architectural failure requiring immediate redesign of the initialization flow, separation of concerns, and proper testing of the render pipeline.

## Next Steps

1. **Emergency Fix**: Flip `needsSpatialRebuild` initial value and remove observer muting
2. **Test**: Verify objects actually render after fix
3. **Refactor**: Separate ObjectStore from RoomDocManager
4. **Clean**: Remove all dead code and legacy patterns
5. **Document**: Write clear initialization sequence docs
6. **Test Suite**: Add comprehensive render pipeline tests