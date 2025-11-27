# SelectTool Implementation Progress

## Phase 2 Complete (Steps 10-11) - Integration + Cursor Handling

**Branch:** `feature/select-tool`
**Date:** 2025-01-26

---

### Modified Files This Phase

#### 1. `client/src/lib/tools/SelectTool.ts`
Added cursor handling:
- Extended `SelectToolOpts` interface with `applyCursor` and `setCursorOverride` callbacks
- Added `updateHoverCursor(worldX, worldY)` - detects handle hover and sets resize cursors
- Added `clearHover()` - clears cursor override on pointer leave
- Added cursor override in `move()` when entering scale phase (nwse-resize/nesw-resize)
- Added cursor cleanup in `end()` and `cancel()`

#### 2. `client/src/canvas/Canvas.tsx`
Full SelectTool integration:
- Added `SelectTool` import
- Added `SelectTool` to `PointerTool` type union
- Added `'select'` case in `applyCursor()` → `'default'` cursor
- Added SelectTool instantiation branch with cursor callbacks
- Added hover cursor update call in `handlePointerMove` for idle state

#### 3. `client/src/renderer/OverlayRenderLoop.ts`
Added selection preview rendering:
- Added `'selection'` case in preview dispatch
- Marquee rect: dashed stroke, light blue fill (0.08 alpha)
- Selection bounds: solid blue stroke (1.5px visual)
- Corner handles: white fill, blue stroke (8px visual, 4 corners)
- Handles hidden during active transform (`isTransforming`)

---

### What Works Now

✅ **SelectTool is fully wired up and testable**
✅ Clicking 'select' tool in toolbar activates SelectTool
✅ Click to select objects (geometry-aware, fill-aware)
✅ Marquee drag to select multiple objects (center-in-bounds logic)
✅ Selection box and handles render on overlay
✅ Resize cursors on handle hover (`nwse-resize`, `nesw-resize`)
✅ Resize cursor maintained during scale operation
✅ Default arrow cursor during translate (per user preference)
✅ Cursor clears on cancel/end/pointer leave
✅ TypeScript compiles (no SelectTool-related errors)

---

### What's NOT Done Yet (Transform doesn't persist)

⚠️ **Step 6 (Transform Commit)** - TODOs remain in `end()`:
- `translate` phase: `endTransform()` called but NO Y.Doc mutation
- `scale` phase: `endTransform()` called but NO Y.Doc mutation
- Objects don't actually move/scale - transforms are visual preview only

⚠️ **Step 9 (objects.ts WYSIWYG)** - NOT implemented:
- Base canvas doesn't apply transforms during render
- During drag, objects stay in place (no WYSIWYG preview)
- Selection box moves but objects don't

---

### 🚨 CRITICAL BUGS DISCOVERED (Must Fix Before Testing)

#### Bug 1: BBox Format Mismatch (Selection boxes way off to the right)

**Root Cause:** `handle.bbox` is `[minX, minY, maxX, maxY]` but code treats it as `[x, y, width, height]`

**Locations:**
- `SelectTool.ts` line 378 in `computeSelectionBounds()`:
  ```typescript
  // WRONG:
  const [bx, by, bw, bh] = handle.bbox;
  maxX = Math.max(maxX, bx + bw);  // Adds minX + maxX = way too far right!
  maxY = Math.max(maxY, by + bh);
  ```
- `SelectTool.ts` line 509 in `updateMarqueeSelection()`:
  ```typescript
  // WRONG:
  const [bx, by, bw, bh] = handle.bbox;
  const cx = bx + bw / 2;  // Computes (minX + maxX) / 2, not center!
  const cy = by + bh / 2;
  ```

**Fix:**
```typescript
// In computeSelectionBounds() - line 378:
const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
minX = Math.min(minX, bMinX);
minY = Math.min(minY, bMinY);
maxX = Math.max(maxX, bMaxX);
maxY = Math.max(maxY, bMaxY);

// In updateMarqueeSelection() - line 509:
const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
const cx = (bMinX + bMaxX) / 2;
const cy = (bMinY + bMaxY) / 2;
```

**Reference:** `packages/shared/src/utils/bbox.ts` confirms bbox format:
```typescript
// Line 96-102: bboxToBounds() shows the format
export function bboxToBounds(bbox: [number, number, number, number]): WorldBounds {
  return {
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3]
  };
}
```

---

#### Bug 2: Clicking Empty Space Doesn't Clear Selection (Blur issue)

**Root Cause:** Clicking empty space goes directly to `marquee` phase, bypassing `pendingClick` where `clearSelection()` lives.

**Location:** `SelectTool.ts` lines 112-119 in `begin()`:
```typescript
if (this.hitAtDown) {
  this.phase = 'pendingClick';
} else {
  // No hit - start marquee selection
  this.phase = 'marquee';  // <-- WRONG! Goes straight to marquee
  useSelectionStore.getState().beginMarquee([worldX, worldY]);
}
```

**Problem Flow:**
1. Click empty space → `hitAtDown = null`
2. Goes to `else` branch → `phase = 'marquee'`
3. On `end()`, `marquee` case runs → calls `endMarquee()` only
4. `clearSelection()` is in `pendingClick` case → **NEVER CALLED**

**Fix Option A (Recommended):** Change empty clicks to use `pendingClick`, transition to `marquee` only on drag:
```typescript
// In begin():
if (this.hitAtDown) {
  this.phase = 'pendingClick';
} else {
  // No hit - could be click-to-clear or drag-to-marquee
  this.phase = 'pendingClick';  // Don't start marquee yet
}

// In move() pendingClick case, add:
if (dist > MOVE_THRESHOLD_PX) {
  if (this.activeHandle) {
    // ... scale
  } else if (this.hitAtDown) {
    // ... translate
  } else {
    // No hit, start marquee NOW
    this.phase = 'marquee';
    useSelectionStore.getState().beginMarquee(this.downWorld!);
    useSelectionStore.getState().updateMarquee([worldX, worldY]);
  }
}

// In end() pendingClick case (line 216-218) - already correct:
} else {
  // Clicked on empty space - clear selection
  useSelectionStore.getState().clearSelection();
}
```

**Fix Option B (Simpler):** Add clearSelection to marquee end if nothing selected:
```typescript
// In end() marquee case:
case 'marquee': {
  useSelectionStore.getState().endMarquee();
  // Clear selection if marquee selected nothing
  if (useSelectionStore.getState().selectedIds.length === 0) {
    // Selection was already empty or marquee found nothing - ensure cleared
  }
  break;
}
```

---

#### Bug 3: Marquee Uses Center-in-Bounds Instead of Intersection

**Root Cause:** After spatial index returns intersecting objects, code filters to only those whose CENTER is inside marquee.

**Location:** `SelectTool.ts` lines 501-517 in `updateMarqueeSelection()`:
```typescript
const results = index.query(marqueeRect);  // Returns ALL intersecting objects

// Then filters to center-in-bounds (too restrictive):
const selectedIds: string[] = [];
for (const entry of results) {
  const handle = snapshot.objectsById.get(entry.id);
  if (!handle) continue;

  const [bx, by, bw, bh] = handle.bbox;  // Also has Bug 1!
  const cx = bx + bw / 2;
  const cy = by + bh / 2;

  if (cx >= marqueeRect.minX && cx <= marqueeRect.maxX &&
      cy >= marqueeRect.minY && cy <= marqueeRect.maxY) {
    selectedIds.push(entry.id);
  }
}
```

**User Expectation:** Any object that INTERSECTS the marquee should be selected (like Figma/other whiteboard apps).

**Fix:** Just use the spatial index results directly (they're already intersection-based):
```typescript
const results = index.query(marqueeRect);

// Use intersection results directly
const selectedIds = results.map(entry => entry.id);
```

Or if you want partial intersection behavior (object must have some overlap, not just bbox touch):
```typescript
const results = index.query(marqueeRect);
const selectedIds = results
  .filter(entry => {
    // Spatial index already ensures bbox intersection
    // Could add more precise geometry tests here if needed
    return true;
  })
  .map(entry => entry.id);
```

---

### Cursor Behavior Reference

| Handle | Cursor |
|--------|--------|
| `nw` (top-left) | `nwse-resize` |
| `se` (bottom-right) | `nwse-resize` |
| `ne` (top-right) | `nesw-resize` |
| `sw` (bottom-left) | `nesw-resize` |

| State | Cursor |
|-------|--------|
| Idle (no selection) | `default` |
| Idle (with selection, not on handle) | `default` |
| Hover on handle | Resize cursor per handle |
| Translating | `default` (no override) |
| Scaling | Resize cursor per active handle |

---

### Next Steps

#### Priority 1: Step 6 - Transform Commit to Y.Doc
Implement the actual persistence in `SelectTool.end()`:

```typescript
// In end() for translate phase:
case 'translate': {
  const store = useSelectionStore.getState();
  const { dx, dy } = store.transform as TranslateTransform;

  if (dx !== 0 || dy !== 0) {
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;

      for (const id of store.selectedIds) {
        const obj = objects.get(id);
        if (!obj) continue;

        const kind = obj.get('kind');
        if (kind === 'stroke' || kind === 'connector') {
          // Offset all points
          const points = obj.get('points') as [number, number][];
          const newPoints = points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
          obj.set('points', newPoints);
        } else {
          // Offset frame (shapes, text)
          const frame = obj.get('frame') as [number, number, number, number];
          obj.set('frame', [frame[0] + dx, frame[1] + dy, frame[2], frame[3]]);
        }
      }
    });
  }

  useSelectionStore.getState().endTransform();
  break;
}

// In end() for scale phase:
case 'scale': {
  const store = useSelectionStore.getState();
  const { origin, scaleX, scaleY } = store.transform as ScaleTransform;
  const [ox, oy] = origin;

  if (scaleX !== 1 || scaleY !== 1) {
    this.room.mutate((ydoc) => {
      // Scale geometry around origin, NOT stroke width
      // ...
    });
  }

  useSelectionStore.getState().endTransform();
  break;
}
```

#### Priority 2: Step 9 - objects.ts WYSIWYG Transform
For visual preview during drag (objects move as you drag):

```typescript
// In renderer/layers/objects.ts:
import { useSelectionStore } from '@/stores/selection-store';

// In drawObjects():
const selection = useSelectionStore.getState();
const selectedSet = new Set(selection.selectedIds);

for (const entry of sortedCandidates) {
  const isSelected = selectedSet.has(entry.id);
  const needsTransform = selection.transform.kind !== 'none' && isSelected;

  if (needsTransform) {
    ctx.save();
    applySelectionTransform(ctx, selection.transform);
    drawObject(ctx, handle);
    ctx.restore();
  } else {
    drawObject(ctx, handle);
  }
}
```

---

## Phase 1 Complete (Steps 1-4) - Foundation

**Branch:** `feature/select-tool`
**Date:** 2025-01-26

---

### Created Files

#### 1. `client/src/stores/selection-store.ts`
Transient Zustand store (NOT persisted) for selection state.

**State:**
- `selectedIds: string[]` - Currently selected object IDs
- `mode: 'none' | 'single' | 'multi'` - Selection mode
- `transform: TransformState` - Active transform (`none` | `translate` | `scale`)
- `marquee: MarqueeState` - Active marquee selection box

**Actions:**
- `setSelection(ids)` / `clearSelection()` - Manage selection
- `beginTranslate/updateTranslate/endTransform/cancelTransform` - Translation lifecycle
- `beginScale/updateScale/endTransform/cancelTransform` - Scale lifecycle
- `beginMarquee/updateMarquee/endMarquee/cancelMarquee` - Marquee lifecycle

#### 2. `client/src/lib/tools/SelectTool.ts`
Full SelectTool implementation with:

**PointerTool Interface:**
- `canBegin()`, `begin()`, `move()`, `end()`, `cancel()`
- `isActive()`, `getPointerId()`, `getPreview()`, `destroy()`
- `onViewChange()` - Re-invalidate on view changes

**State Machine Phases:**
- `idle` - No active gesture
- `pendingClick` - Pointer down, waiting to distinguish click vs drag
- `marquee` - Drawing marquee selection rectangle
- `translate` - Dragging to translate selected objects
- `scale` - Dragging handle to scale selected objects

**Hit-Testing (Geometry Utilities):**
- `hitTestObjects()` - Main entry, queries spatial index
- `hitTestHandle()` - Tests resize handle hit
- `strokeHitTest()` - Polyline distance test
- `pointToSegmentDistance()` - Core geometry
- `pointInRect()`, `pointInDiamond()` - Point-in-shape tests
- `shapeHitTestForSelection()` - Shape-specific with interior detection
- `shapeEdgeHitTest()` - Edge distance for shapes
- `pointInsideShape()` - Interior test for rect/ellipse/diamond

**Selection Priority Logic (`pickBestCandidate`):**
1. Prefer objects where cursor is inside interior
2. Kind priority: text > stroke/connector > shape
3. Smaller area wins (nested shapes)
4. ULID tie-breaker (topmost = newest)

**Key Difference from Eraser:**
Unfilled shapes ARE selectable by clicking inside (Figma-style), unlike eraser which only hits stroke edges.

**Dirty Rect Tracking:**
- `prevPreviewBounds: WorldRect | null` - Tracks previous transformed bounds
- `invalidateTransformPreview()` - Unions prev + current for minimal dirty rect

---

### Modified Files

#### `client/src/lib/tools/types.ts`
Added:
- `WorldRect` interface - Bounding box in world coordinates
- `HandleId` type - `'nw' | 'ne' | 'se' | 'sw'`
- `SelectionPreview` interface - Preview data for overlay rendering
- Updated `PreviewData` union to include `SelectionPreview`

---

### What Works

✅ Selection store with full state management
✅ SelectTool skeleton implementing PointerTool interface
✅ Complete state machine (idle → pendingClick → marquee/translate/scale)
✅ Hit-testing for all object types (stroke, shape, text, connector)
✅ Fill-aware, interior-click selection for shapes
✅ Priority selection for overlapping objects
✅ Handle hit-testing for scale operations
✅ Bounds computation (`computeSelectionBounds`)
✅ Transform application to bounds (`applyTransformToBounds`)
✅ Dirty rect optimization (`prevPreviewBounds` tracking)
✅ Preview generation (`getPreview()`)
✅ Marquee selection with center-in-bounds logic
✅ TypeScript compiles with no errors

---

### What's Stubbed (TODO markers)

1. **Transform Commit (Step 6)** - `end()` method has TODOs:
   - Translate: needs to offset points/frames in Y.Doc
   - Scale: needs to scale geometry around origin in Y.Doc

---

### Next Steps (Phase 2: Steps 5-8)

#### Step 5: State Machine Refinement
The state machine is implemented but may need:
- Shift-key uniform scaling support
- Cursor style changes during different phases

#### Step 6: Transform Commit to Y.Doc
**Critical Implementation:**
```typescript
// In end() for translate:
this.room.mutate((ydoc) => {
  const objects = ydoc.getMap('root').get('objects');
  for (const id of selectedIds) {
    const obj = objects.get(id);
    if (obj.get('kind') === 'stroke' || obj.get('kind') === 'connector') {
      // Offset all points
      const points = obj.get('points');
      const newPoints = points.map(([x, y]) => [x + dx, y + dy]);
      obj.set('points', newPoints);
    } else {
      // Offset frame
      const frame = obj.get('frame');
      obj.set('frame', [frame[0] + dx, frame[1] + dy, frame[2], frame[3]]);
    }
  }
});

// For scale: scale geometry around origin, NOT stroke width
```

#### Step 7: Bounds Helpers
Already implemented: `computeSelectionBounds`, `applyTransformToBounds`, `computeHandles`

#### Step 8: Preview Enhancement
`getPreview()` is implemented but may need polish for edge cases.

---

### Pending Integration (Phase 3: Steps 9-12)

#### Step 9: `renderer/layers/objects.ts` Modification
Import selection store and apply transforms during render:
```typescript
import { useSelectionStore } from '@/stores/selection-store';

// In drawObjects():
const selection = useSelectionStore.getState();
const selectedSet = new Set(selection.selectedIds);

for (const entry of sortedCandidates) {
  const isSelected = selectedSet.has(entry.id);
  const needsTransform = selection.transform.kind !== 'none' && isSelected;

  if (needsTransform) {
    ctx.save();
    applySelectionTransform(ctx, selection.transform);
    drawObject(ctx, handle);
    ctx.restore();
  } else {
    drawObject(ctx, handle);
  }
}
```

#### Step 10: `renderer/OverlayRenderLoop.ts` Modification
Add selection preview rendering:
- Marquee box (dashed stroke, light blue fill)
- Selection bounds (solid blue stroke)
- Corner handles (white fill, blue stroke)

#### Step 11: `canvas/Canvas.tsx` Integration
- Add SelectTool import
- Add tool creation branch for `activeTool === 'select'`
- Add cursor style case
- Add cleanup effect for selection store on unmount

#### Step 12: Testing & Polish
- Single-click selection
- Marquee multi-selection
- Translate drag
- Scale via handles
- Undo/redo
- Selection persistence across toolbar interactions

---

### File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `client/src/stores/selection-store.ts` | ~120 | Selection state management |
| `client/src/lib/tools/SelectTool.ts` | ~800 | Tool implementation + hit-testing |
| `client/src/lib/tools/types.ts` | +35 | WorldRect, HandleId, SelectionPreview |

---

### Architecture Notes

**Store Access Pattern:**
```typescript
// Read (synchronous)
const { selectedIds, transform } = useSelectionStore.getState();

// Write
useSelectionStore.getState().setSelection([id1, id2]);
useSelectionStore.getState().beginTranslate(originBounds);
```

**Dirty Rect Flow:**
```
SelectTool.move()
  → updateTranslate(dx, dy) in store
  → invalidateTransformPreview()
    → computes union(prevBounds, currentBounds)
    → calls invalidateWorld(unionBounds)
  → invalidateOverlay()
```

**Hit-Test Priority (overlapping objects):**
```
1. Interior hits preferred over edge hits
2. text (priority 0) > stroke/connector (1) > shape (2)
3. Smaller area wins (nested shapes)
4. Higher ULID wins (topmost layer)
```
