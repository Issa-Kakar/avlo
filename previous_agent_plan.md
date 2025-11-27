# SelectTool Completion: Slack, Highlighting, WYSIWYG Transform

## Overview

Complete the SelectTool implementation with three critical features:
1. **Hit Testing Slack** - Make thin strokes easier to select
2. **Selection Highlighting** - Blue outline on selected objects (**on OVERLAY canvas**)
3. **WYSIWYG Transform Preview** - Objects visually move/scale during drag on base canvas

**CRITICAL ARCHITECTURE NOTE:**
- **Base canvas** = Document content only (strokes, shapes, text, connectors)
- **Overlay canvas** = Preview UI (selection boxes, handles, marquee, selection highlights, cursors)
- Selection highlighting does NOT need z-ordering with objects - it's UI feedback
- `drawAuthoringOverlays()` is outdated/unused - ignore it

---

## Part 1: Hit Testing Slack (SelectTool.ts)

### Problem
- `HIT_RADIUS_PX = 6` with no slack makes thin strokes (like letter "l") nearly impossible to select
- EraserTool uses `ERASER_SLACK_PX = 2.0` for forgiving feel

### Changes

**Add slack constant (line ~7):**
```typescript
const HIT_RADIUS_PX = 6;
const HIT_SLACK_PX = 2.0;    // Add forgiving feel for touch/click precision
const HANDLE_HIT_PX = 10;
```

**Update `hitTestObjects()` (line 563):**
```typescript
// BEFORE:
const radiusWorld = HIT_RADIUS_PX / view.scale;

// AFTER:
const radiusWorld = (HIT_RADIUS_PX + HIT_SLACK_PX) / view.scale;
```

**Update stroke hit testing in `testObject()` (line ~606):**
For strokes, also add the stroke width to the tolerance (like EraserTool does):
```typescript
case 'stroke':
case 'connector': {
  const points = y.get('points') as [number, number][] | undefined;
  if (!points || points.length === 0) return null;

  // Add stroke width to tolerance for more forgiving hit detection
  const strokeWidth = (y.get('width') as number) ?? 2;
  const tolerance = radiusWorld + strokeWidth / 2;  // NEW: Add half stroke width

  if (this.strokeHitTest(worldX, worldY, points, tolerance)) {
    // ... rest unchanged
  }
}
```

---

## Part 2: Selection Highlighting (Blue Outline on OVERLAY)

### Approach
Render selection highlights on the **OVERLAY canvas** in OverlayRenderLoop.ts, within the existing `'selection'` preview case. This keeps all selection UI together and avoids polluting the base canvas.

**Key behaviors:**
- **Hidden during drag** (`isTransforming = true`) - don't render while transform active
- **Uses cached Path2D** from object-cache for geometry
- **Stroking polygon fills** - For strokes (filled PF polygons), `ctx.stroke(path)` draws the perimeter edge, which is the visual boundary

### Files
- **Modify:** `client/src/renderer/OverlayRenderLoop.ts`

### Modify: `OverlayRenderLoop.ts` - Selection Preview Case (~line 287)

Add selection highlighting BEFORE the selection bounds/handles, but ONLY when NOT transforming:

```typescript
} else if (previewToDraw?.kind === 'selection') {
  // Selection preview (world space for bounds, screen space for handle sizing)
  ctx.save();
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // === SELECTION HIGHLIGHTING (only when not transforming) ===
  if (!previewToDraw.isTransforming && previewToDraw.selectedIds?.length > 0) {
    const snapshot = getSnapshot();  // Need to add this getter
    const cache = getObjectCacheInstance();

    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';  // Blue
    ctx.lineWidth = 2 / view.scale;  // 2px visual
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const id of previewToDraw.selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      // Text: stroke the frame rect
      if (handle.kind === 'text') {
        const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
        if (frame) {
          const [x, y, w, h] = frame;
          ctx.strokeRect(x, y, w, h);
        }
        continue;
      }

      // Strokes/Shapes/Connectors: stroke the cached Path2D
      const path = cache.getOrBuild(id, handle);
      ctx.stroke(path);
    }
  }

  // Draw marquee rect if active (unchanged)...
  // Draw selection bounds and handles (unchanged)...

  ctx.restore();
}
```

### Update SelectionPreview Type (types.ts)

Add `selectedIds` to SelectionPreview so we can access them in OverlayRenderLoop:

```typescript
export interface SelectionPreview {
  kind: 'selection';
  selectionBounds: WorldRect | null;
  marqueeRect: WorldRect | null;
  handles: { id: HandleId; x: number; y: number }[] | null;
  isTransforming: boolean;
  selectedIds: string[];  // ADD THIS
  bbox: null;
}
```

### Update SelectTool.getPreview() (~line 301)

Return the selectedIds in the preview:

```typescript
return {
  kind: 'selection',
  selectionBounds,
  marqueeRect,
  handles: isTransforming ? null : handles,
  isTransforming,
  selectedIds,  // ADD THIS
  bbox: null,
};
```

### Provide Snapshot Access in OverlayRenderLoop

OverlayRenderLoop needs access to the snapshot to look up ObjectHandles. Options:

**Option A: Pass snapshot through config (cleaner)**
Add to OverlayConfig and pass getSnapshot callback like existing getView/getPresence.

**Option B: Import from room-doc registry**
Import the registry and get current snapshot directly.

For consistency with existing pattern, use **Option A**:

```typescript
// In OverlayConfig interface, add:
getSnapshot: () => Snapshot;

// In Canvas.tsx where OverlayRenderLoop is created, add:
getSnapshot: () => snapshotRef.current,
```

---

## Part 3: WYSIWYG Transform Preview (objects.ts)

### Approach
During active transforms (translate/scale), apply canvas transforms to selected objects so they visually move/scale in real-time on the base canvas.

### Modify: `objects.ts`

**Add imports at top:**
```typescript
import { useSelectionStore } from '@/stores/selection-store';
```

**Modify `drawObjects()` function:**

```typescript
export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  const { spatialIndex, objectsById } = snapshot;
  if (!spatialIndex) return;

  // === READ SELECTION STATE ===
  const selectionState = useSelectionStore.getState();
  const selectedSet = new Set(selectionState.selectedIds);
  const transform = selectionState.transform;
  const isTransforming = transform.kind !== 'none';

  // ... existing spatial query code unchanged ...

  for (const entry of sortedCandidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    if (shouldSkipLOD(handle.bbox, viewTransform)) {
      culledCount++;
      continue;
    }

    // === TRANSFORM SELECTED OBJECTS ===
    const isSelected = selectedSet.has(entry.id);
    const needsTransform = isTransforming && isSelected;

    if (needsTransform) {
      ctx.save();
      applySelectionTransform(ctx, transform);
      drawObject(ctx, handle);
      ctx.restore();
    } else {
      drawObject(ctx, handle);
    }

    renderedCount++;
  }
}

// Helper function for applying selection transforms
function applySelectionTransform(
  ctx: CanvasRenderingContext2D,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): void {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    ctx.translate(transform.dx, transform.dy);
  } else if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    ctx.translate(ox, oy);
    ctx.scale(transform.scaleX, transform.scaleY);
    ctx.translate(-ox, -oy);
  }
}
```

---

## Part 4: Dirty Rect Invalidation (SelectTool.ts)

The existing `invalidateTransformPreview()` in SelectTool (lines 462-483) is correctly implemented:
- Computes union of prev + current bounds
- Stores `prevPreviewBounds` for next frame
- Calls `invalidateWorld(unionBounds)`

### Additional Fix: Invalidate Origin on Transform Start

In `move()` when transitioning to `translate` or `scale` phase, invalidate the origin bounds BEFORE setting `prevPreviewBounds`:

**In `move()` translate transition (~line 155-159):**
```typescript
this.phase = 'translate';
const bounds = this.computeSelectionBounds();
if (bounds) {
  useSelectionStore.getState().beginTranslate(bounds);
  // Invalidate origin bounds immediately
  this.prevPreviewBounds = bounds;
  this.invalidateWorld(bounds);
}
```

**In `move()` scale transition (~line 136-146):**
```typescript
this.phase = 'scale';
const bounds = this.computeSelectionBounds();
if (bounds) {
  const origin = this.getScaleOrigin(this.activeHandle, bounds);
  useSelectionStore.getState().beginScale(bounds, origin);
  // Invalidate origin bounds immediately
  this.prevPreviewBounds = bounds;
  this.invalidateWorld(bounds);
}
```

### Post-Commit Invalidation - NO Double Invalidation Needed

**Key insight:** After `room.mutate()` commits the transform:
1. Y.Doc observer fires
2. room-doc-manager computes `dirtyPatch` with affected bounds
3. Canvas.tsx snapshot subscription receives new snapshot
4. Canvas.tsx calls `cache.evictMany(evictIds)` + `renderLoop.invalidateWorld(bounds)`

**Therefore:** We do NOT need to manually invalidate after commit - the observer chain handles it.

**Flicker prevention:** `holdPreviewForOneFrame()` is already called in Canvas.tsx on `docVersion` change (line ~128), which holds the preview until base canvas has drawn the committed objects. This prevents the 1-frame gap where objects would appear to jump.

**On transform end, simply:**
```typescript
case 'translate':
case 'scale': {
  // Clear transform state before commit (so drawObjects uses new positions from Y.Doc)
  useSelectionStore.getState().endTransform();

  // Commit to Y.Doc - observer will handle dirty rect invalidation
  // ... commit logic (Part 5) ...

  break;
}
```

**IMPORTANT:** Call `endTransform()` BEFORE the `mutate()` call. This clears the transform state so:
1. `drawObjects()` no longer applies canvas transform to selected objects
2. Objects render at their committed positions from Y.Doc on the next frame
3. No visual discontinuity

**Add helper (already exists but ensure it's there):**
```typescript
private unionBounds(a: WorldRect, b: WorldRect): WorldRect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
```

---

## Part 5: Transform Commit to Y.Doc (SelectTool.ts)

Replace the TODO stubs in `end()` with actual Y.Doc mutations.

### Translate Commit (lines 231-235):
```typescript
case 'translate': {
  const store = useSelectionStore.getState();
  if (store.transform.kind !== 'translate') break;

  const { dx, dy } = store.transform;

  // Only commit if there was actual movement
  if (dx !== 0 || dy !== 0) {
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Map<string, Map<string, unknown>>;

      for (const id of store.selectedIds) {
        const obj = objects.get(id);
        if (!obj) continue;

        const kind = obj.get('kind') as string;

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
```

### Scale Commit (lines 238-242):
```typescript
case 'scale': {
  const store = useSelectionStore.getState();
  if (store.transform.kind !== 'scale') break;

  const { origin, scaleX, scaleY } = store.transform;
  const [ox, oy] = origin;

  // Only commit if there was actual scaling
  if (scaleX !== 1 || scaleY !== 1) {
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Map<string, Map<string, unknown>>;

      for (const id of store.selectedIds) {
        const obj = objects.get(id);
        if (!obj) continue;

        const kind = obj.get('kind') as string;

        if (kind === 'stroke' || kind === 'connector') {
          // Scale points around origin (NOT width)
          const points = obj.get('points') as [number, number][];
          const newPoints = points.map(([x, y]) => [
            ox + (x - ox) * scaleX,
            oy + (y - oy) * scaleY,
          ] as [number, number]);
          obj.set('points', newPoints);
        } else {
          // Scale frame around origin (NOT stroke width)
          const frame = obj.get('frame') as [number, number, number, number];
          const [fx, fy, fw, fh] = frame;

          // Scale position and dimensions
          const newX = ox + (fx - ox) * scaleX;
          const newY = oy + (fy - oy) * scaleY;
          const newW = fw * scaleX;
          const newH = fh * scaleY;

          obj.set('frame', [newX, newY, Math.abs(newW), Math.abs(newH)]);
        }
      }
    });
  }

  useSelectionStore.getState().endTransform();
  break;
}
```

---

## Implementation Order

1. **Part 1: Hit Testing Slack**
   - Add `HIT_SLACK_PX` constant
   - Update `hitTestObjects()` radius calculation
   - Add stroke width to tolerance in `testObject()`

2. **Part 2: Selection Highlighting (Overlay)**
   - Add `selectedIds` to SelectionPreview type
   - Update SelectTool.getPreview() to include selectedIds
   - Add `getSnapshot` to OverlayRenderLoop config
   - Add blue outline rendering in selection preview case

3. **Part 3: WYSIWYG Transform Preview (Base Canvas)**
   - Import selection store in objects.ts
   - Add applySelectionTransform helper
   - Modify render loop to apply transform to selected objects

4. **Part 4: Dirty Rect Invalidation**
   - Add initial invalidation on transform start in move()
   - Add unionBounds helper if not present

5. **Part 5: Transform Commit**
   - Implement translate commit (offset points/frame)
   - Implement scale commit (scale points/frame around origin)
   - Call endTransform() before mutate()

6. **Test**
   - Thin strokes selectable
   - Blue outline visible on selection
   - Drag preview works (WYSIWYG)
   - Transforms persist after pointer up
   - No flicker on commit

---

## Files to Modify

| File | Changes |
|------|---------|
| `client/src/lib/tools/SelectTool.ts` | Slack constant, stroke tolerance, dirty rect init, transform commit, add selectedIds to preview |
| `client/src/lib/tools/types.ts` | Add `selectedIds: string[]` to SelectionPreview |
| `client/src/renderer/OverlayRenderLoop.ts` | Add getSnapshot config, render selection highlights |
| `client/src/renderer/layers/objects.ts` | Import selection store, apply transforms to selected objects |
| `client/src/canvas/Canvas.tsx` | Pass getSnapshot to OverlayRenderLoop config |

---

## Critical Notes

### Stroke Scale Preview (MVP)
- **For now:** Use canvas transform (ctx.scale) for all objects including strokes
- **Limitation:** Strokes are PF polygons - scaling polygon ≠ regenerating from scaled points
- **Future enhancement:** Strokes should always scale uniformly (lock aspect ratio), regenerate PF polygon from scaled points
- Canvas transform is acceptable approximation for MVP - commit is always correct

### Selection Highlighting on Overlay (NOT Base)
- Selection UI goes on overlay canvas - doesn't need z-ordering with objects
- `drawAuthoringOverlays()` is outdated - don't use
- Render highlights in OverlayRenderLoop selection preview case
- Hidden during active transform (`isTransforming = true`)

### Post-Commit Flicker
- No manual invalidation needed after commit
- Observer chain handles dirty rect invalidation automatically
- `holdPreviewForOneFrame()` is for DrawingTool commits (overlay preview → base canvas)
- SelectTool is different - preview IS on base canvas, so no hold needed
- Call `endTransform()` BEFORE `mutate()` to clear transform state
