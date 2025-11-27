# SelectTool Implementation Progress

## Phase 5 - Scale Fix, Side Handles, Transform Commit (CURRENT)

**Branch:** `feature/select-tool`
**Date:** 2025-01-26 (Session 3)
**Plan File:** `/home/issak/.claude/plans/splendid-singing-lake.md`

---

### ✅ Completed This Session

#### 1. HandleId Type Extended (DONE)
**File:** `client/src/lib/tools/types.ts` (line 19)

```typescript
// BEFORE:
export type HandleId = 'nw' | 'ne' | 'se' | 'sw';

// AFTER:
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
```

#### 2. ScaleTransform Updated with handleId (DONE)
**File:** `client/src/stores/selection-store.ts`

- Added import: `import type { HandleId } from '@/lib/tools/types';`
- Added `handleId: HandleId` to ScaleTransform interface (line 26)
- Updated `beginScale` signature to accept handleId (line 59)
- Updated `beginScale` implementation (line 109-110)

---

### ⏳ Remaining Tasks (In Order)

#### Task 1: Update computeHandles() - Add Side Handles
**File:** `client/src/lib/tools/SelectTool.ts` (lines 417-424)

**REPLACE WITH:**
```typescript
private computeHandles(bounds: WorldRect): { id: HandleId; x: number; y: number }[] {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  return [
    // Corners
    { id: 'nw', x: bounds.minX, y: bounds.minY },
    { id: 'ne', x: bounds.maxX, y: bounds.minY },
    { id: 'se', x: bounds.maxX, y: bounds.maxY },
    { id: 'sw', x: bounds.minX, y: bounds.maxY },
    // Sides (midpoints)
    { id: 'n', x: midX, y: bounds.minY },
    { id: 'e', x: bounds.maxX, y: midY },
    { id: 's', x: midX, y: bounds.maxY },
    { id: 'w', x: bounds.minX, y: midY },
  ];
}
```

---

#### Task 2: Update hitTestHandle() - Test All 8 Handles
**File:** `client/src/lib/tools/SelectTool.ts` (lines 534-560)

**REPLACE WITH:**
```typescript
private hitTestHandle(worldX: number, worldY: number): HandleId | null {
  const store = useSelectionStore.getState();
  if (store.selectedIds.length === 0) return null;

  const bounds = this.computeSelectionBounds();
  if (!bounds) return null;

  const view = this.getView();
  const handleRadius = HANDLE_HIT_PX / view.scale;

  // Use computeHandles to get all 8 handles
  const handles = this.computeHandles(bounds);

  for (const h of handles) {
    const dx = worldX - h.x;
    const dy = worldY - h.y;
    if (dx * dx + dy * dy <= handleRadius * handleRadius) {
      return h.id;
    }
  }

  return null;
}
```

---

#### Task 3: Update getScaleOrigin() - Add Side Handle Origins
**File:** `client/src/lib/tools/SelectTool.ts` (lines 426-434)

**REPLACE WITH:**
```typescript
private getScaleOrigin(handle: HandleId, bounds: WorldRect): [number, number] {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  // Scale origin is opposite edge/corner from the dragged handle
  switch (handle) {
    // Corners - opposite corner
    case 'nw': return [bounds.maxX, bounds.maxY];
    case 'ne': return [bounds.minX, bounds.maxY];
    case 'se': return [bounds.minX, bounds.minY];
    case 'sw': return [bounds.maxX, bounds.minY];
    // Sides - opposite edge midpoint
    case 'n': return [midX, bounds.maxY];
    case 's': return [midX, bounds.minY];
    case 'e': return [bounds.minX, midY];
    case 'w': return [bounds.maxX, midY];
  }
}
```

---

#### Task 4: Fix computeScaleFactors() - CRITICAL BUG FIX
**File:** `client/src/lib/tools/SelectTool.ts` (lines 436-462)

**BUGS IN CURRENT CODE:**
1. Divides by `origWidth/2` instead of `origWidth` (2x scale error!)
2. Uses `Math.abs()` which prevents negative scale (no flip/mirror)
3. No side handle support

**REPLACE WITH:**
```typescript
private computeScaleFactors(worldX: number, worldY: number): { scaleX: number; scaleY: number } {
  const store = useSelectionStore.getState();
  const transform = store.transform;
  if (transform.kind !== 'scale') return { scaleX: 1, scaleY: 1 };

  const { origin, originBounds, handleId } = transform;
  const [ox, oy] = origin;

  // Original dimensions
  const origWidth = originBounds.maxX - originBounds.minX;
  const origHeight = originBounds.maxY - originBounds.minY;

  // Vector from origin to cursor
  const dx = worldX - ox;
  const dy = worldY - oy;

  // Get sign multipliers based on handle direction
  const handleSignX = this.getHandleSignX(handleId);
  const handleSignY = this.getHandleSignY(handleId);

  let scaleX = 1;
  let scaleY = 1;

  const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  if (isCorner) {
    // Corner handles: free scale in both axes (SIGNED for flip)
    scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
  } else if (isSideH) {
    // East/West handle: X scales, Y = 1
    scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    scaleY = 1;
  } else if (isSideV) {
    // North/South handle: Y scales, X = 1
    scaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
    scaleX = 1;
  }

  // Apply minimum scale magnitude (0.1) but preserve sign for flip
  const minScale = 0.1;
  scaleX = Math.sign(scaleX || 1) * Math.max(minScale, Math.abs(scaleX));
  scaleY = Math.sign(scaleY || 1) * Math.max(minScale, Math.abs(scaleY));

  return { scaleX, scaleY };
}

/** Returns +1 or -1 for X direction based on handle */
private getHandleSignX(handleId: HandleId): number {
  switch (handleId) {
    case 'nw': case 'w': case 'sw': return -1;  // Left side
    case 'ne': case 'e': case 'se': return 1;   // Right side
    default: return 1;
  }
}

/** Returns +1 or -1 for Y direction based on handle */
private getHandleSignY(handleId: HandleId): number {
  switch (handleId) {
    case 'nw': case 'n': case 'ne': return -1;  // Top side
    case 'sw': case 's': case 'se': return 1;   // Bottom side
    default: return 1;
  }
}
```

---

#### Task 5: Add getHandleCursor() Helper + Update Cursor Logic
**File:** `client/src/lib/tools/SelectTool.ts`

**ADD after getHandleSignY():**
```typescript
private getHandleCursor(handle: HandleId): string {
  switch (handle) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    default: return 'default';
  }
}
```

**UPDATE move() scale phase (lines 143-147):**
```typescript
const cursor = this.getHandleCursor(this.activeHandle);
this.setCursorOverride(cursor);
this.applyCursor();
```

**UPDATE updateHoverCursor() (lines 336-340):**
```typescript
if (handle) {
  const cursor = this.getHandleCursor(handle);
  this.setCursorOverride(cursor);
} else {
  this.setCursorOverride(null);
}
```

---

#### Task 6: Update beginScale Call to Pass handleId
**File:** `client/src/lib/tools/SelectTool.ts` (line 140)

**CHANGE FROM:**
```typescript
useSelectionStore.getState().beginScale(bounds, origin);
```

**TO:**
```typescript
useSelectionStore.getState().beginScale(bounds, origin, this.activeHandle!);
```

---

#### Task 7: Update objects.ts - Per-Object Scale (Strokes Always Uniform)
**File:** `client/src/renderer/layers/objects.ts`

**CRITICAL DESIGN:**
- Strokes ALWAYS scale uniformly (preserve aspect ratio)
- Shapes CAN scale non-uniformly (directional stretch with side handles)
- For side handles: use the primary axis (X for e/w, Y for n/s)
- For corner handles: use max(|scaleX|, |scaleY|) for strokes

**ADD import at top:**
```typescript
import type { HandleId } from '@/lib/tools/types';
```

**REPLACE applySelectionTransform function (lines 299-310):**
```typescript
function applySelectionTransform(
  ctx: CanvasRenderingContext2D,
  transform: {
    kind: string;
    dx?: number;
    dy?: number;
    origin?: [number, number];
    scaleX?: number;
    scaleY?: number;
    handleId?: HandleId;
  },
  objectKind: 'stroke' | 'shape' | 'text' | 'connector'
): void {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    ctx.translate(transform.dx, transform.dy);
  } else if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
    const [ox, oy] = transform.origin;
    let sx = transform.scaleX;
    let sy = transform.scaleY;

    // Strokes ALWAYS scale uniformly
    if (objectKind === 'stroke' || objectKind === 'connector') {
      const uniformScale = computeUniformScale(sx, sy, transform.handleId);
      sx = uniformScale;
      sy = uniformScale;
    }

    ctx.translate(ox, oy);
    ctx.scale(sx, sy);
    ctx.translate(-ox, -oy);
  }
}

function computeUniformScale(scaleX: number, scaleY: number, handleId?: HandleId): number {
  if (!handleId) {
    return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }

  switch (handleId) {
    case 'e': case 'w': return scaleX;  // Horizontal: X is primary
    case 'n': case 's': return scaleY;  // Vertical: Y is primary
    default: return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }
}
```

**UPDATE render loop call (around line 80):**
```typescript
if (needsTransform) {
  ctx.save();
  applySelectionTransform(ctx, transform, handle.kind);
  drawObject(ctx, handle);
  ctx.restore();
}
```

---

#### Task 8: Implement commitTranslate()
**File:** `client/src/lib/tools/SelectTool.ts`

**ADD import at top:**
```typescript
import * as Y from 'yjs';
```

**ADD method after invalidateTransformPreview():**
```typescript
private commitTranslate(selectedIds: string[], dx: number, dy: number): void {
  const snapshot = this.room.currentSnapshot;

  this.room.mutate((ydoc: Y.Doc) => {
    const root = ydoc.getMap('root');
    const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      const yMap = objects.get(id);
      if (!yMap) continue;

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        const points = yMap.get('points') as [number, number][];
        if (!points) continue;
        const newPoints: [number, number][] = points.map(([x, y]) => [x + dx, y + dy]);
        yMap.set('points', newPoints);
      } else {
        const frame = yMap.get('frame') as [number, number, number, number];
        if (!frame) continue;
        const [x, y, w, h] = frame;
        yMap.set('frame', [x + dx, y + dy, w, h]);
      }
    }
  });
}
```

**REPLACE translate case in end() (lines 232-236):**
```typescript
case 'translate': {
  const store = useSelectionStore.getState();
  if (store.transform.kind !== 'translate') {
    store.endTransform();
    break;
  }

  const { dx, dy } = store.transform;
  const { selectedIds } = store;

  if (dx === 0 && dy === 0) {
    store.endTransform();
    break;
  }

  // Clear transform BEFORE mutate
  store.endTransform();
  this.commitTranslate(selectedIds, dx, dy);
  break;
}
```

---

#### Task 9: Implement commitScale() with Per-Object Uniform Logic
**File:** `client/src/lib/tools/SelectTool.ts`

**ADD methods after commitTranslate():**
```typescript
private commitScale(
  selectedIds: string[],
  origin: [number, number],
  scaleX: number,
  scaleY: number,
  handleId: HandleId
): void {
  const snapshot = this.room.currentSnapshot;
  const [ox, oy] = origin;

  this.room.mutate((ydoc: Y.Doc) => {
    const root = ydoc.getMap('root');
    const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;

      const yMap = objects.get(id);
      if (!yMap) continue;

      if (handle.kind === 'stroke' || handle.kind === 'connector') {
        // Strokes: ALWAYS uniform scale
        const uniformScale = this.computeUniformScaleForCommit(scaleX, scaleY, handleId);

        const points = yMap.get('points') as [number, number][];
        if (!points) continue;
        const newPoints: [number, number][] = points.map(([x, y]) => [
          ox + (x - ox) * uniformScale,
          oy + (y - oy) * uniformScale
        ]);
        yMap.set('points', newPoints);
      } else {
        // Shapes/text: non-uniform allowed
        const frame = yMap.get('frame') as [number, number, number, number];
        if (!frame) continue;
        const [x, y, w, h] = frame;

        const newX1 = ox + (x - ox) * scaleX;
        const newY1 = oy + (y - oy) * scaleY;
        const newX2 = ox + ((x + w) - ox) * scaleX;
        const newY2 = oy + ((y + h) - oy) * scaleY;

        // Handle negative scale (flip)
        yMap.set('frame', [
          Math.min(newX1, newX2),
          Math.min(newY1, newY2),
          Math.abs(newX2 - newX1),
          Math.abs(newY2 - newY1)
        ]);
      }
    }
  });
}

private computeUniformScaleForCommit(scaleX: number, scaleY: number, handleId: HandleId): number {
  switch (handleId) {
    case 'e': case 'w': return scaleX;
    case 'n': case 's': return scaleY;
    default: return Math.sign(scaleX || 1) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
  }
}
```

**REPLACE scale case in end() (lines 239-243):**
```typescript
case 'scale': {
  const store = useSelectionStore.getState();
  if (store.transform.kind !== 'scale') {
    store.endTransform();
    break;
  }

  const { origin, scaleX, scaleY, handleId } = store.transform;
  const { selectedIds } = store;

  if (scaleX === 1 && scaleY === 1) {
    store.endTransform();
    break;
  }

  store.endTransform();
  this.commitScale(selectedIds, origin, scaleX, scaleY, handleId);
  break;
}
```

---

#### Task 10: Fix Selection Highlighting for Strokes (Use BBox)
**File:** `client/src/renderer/OverlayRenderLoop.ts` (lines 304-321)

**REPLACE selection highlighting loop:**
```typescript
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

  // Strokes/Connectors: draw bbox rectangle (avoids PF "ball" end cap)
  if (handle.kind === 'stroke' || handle.kind === 'connector') {
    const [minX, minY, maxX, maxY] = handle.bbox;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    continue;
  }

  // Shapes: stroke the cached Path2D
  const path = cache.getOrBuild(id, handle);
  ctx.stroke(path);
}
```

---

#### Task 11: Fix Dirty Rect Invalidation
**File:** `client/src/lib/tools/SelectTool.ts`

**REPLACE invalidateTransformPreview() (lines 464-485):**
```typescript
private invalidateTransformPreview(): void {
  const bounds = this.computeSelectionBounds();
  if (!bounds) return;

  const store = useSelectionStore.getState();
  const transformedBounds = this.applyTransformToBounds(bounds, store.transform);

  if (this.prevPreviewBounds) {
    // Subsequent moves: union previous with current
    const unionBounds: WorldRect = {
      minX: Math.min(this.prevPreviewBounds.minX, transformedBounds.minX),
      minY: Math.min(this.prevPreviewBounds.minY, transformedBounds.minY),
      maxX: Math.max(this.prevPreviewBounds.maxX, transformedBounds.maxX),
      maxY: Math.max(this.prevPreviewBounds.maxY, transformedBounds.maxY),
    };
    this.invalidateWorld(unionBounds);
  } else {
    // FIRST MOVE: Invalidate BOTH original AND transformed bounds
    const unionBounds: WorldRect = {
      minX: Math.min(bounds.minX, transformedBounds.minX),
      minY: Math.min(bounds.minY, transformedBounds.minY),
      maxX: Math.max(bounds.maxX, transformedBounds.maxX),
      maxY: Math.max(bounds.maxY, transformedBounds.maxY),
    };
    this.invalidateWorld(unionBounds);
  }

  this.prevPreviewBounds = transformedBounds;
}
```

**ADD final invalidation before resetState() in end() (around line 245):**
```typescript
// Final invalidation for transform phases
if (this.phase === 'translate' || this.phase === 'scale') {
  const bounds = this.computeSelectionBounds();
  if (bounds) {
    this.invalidateWorld(bounds);
  }
}
```

**REPLACE cancel() (lines 255-263):**
```typescript
cancel(): void {
  if (this.phase === 'translate' || this.phase === 'scale') {
    const bounds = this.computeSelectionBounds();
    if (bounds) {
      const store = useSelectionStore.getState();
      const transformedBounds = this.applyTransformToBounds(bounds, store.transform);
      const unionBounds: WorldRect = {
        minX: Math.min(bounds.minX, transformedBounds.minX),
        minY: Math.min(bounds.minY, transformedBounds.minY),
        maxX: Math.max(bounds.maxX, transformedBounds.maxX),
        maxY: Math.max(bounds.maxY, transformedBounds.maxY),
      };
      this.invalidateWorld(unionBounds);
    }
  }

  useSelectionStore.getState().cancelTransform();
  useSelectionStore.getState().cancelMarquee();
  this.setCursorOverride(null);
  this.applyCursor();
  this.resetState();
  this.invalidateOverlay();
}
```

---

#### Task 12: Update Overlay Handle Rendering (Circles for Sides)
**File:** `client/src/renderer/OverlayRenderLoop.ts` (lines 346-366)

**REPLACE handle rendering:**
```typescript
if (previewToDraw.handles) {
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
  ctx.lineWidth = 1.5 / view.scale;

  for (const h of previewToDraw.handles) {
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(h.id);

    if (isCorner) {
      // Square handles for corners
      const handleSize = 8 / view.scale;
      ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
    } else {
      // Circular handles for sides
      const handleRadius = 4 / view.scale;
      ctx.beginPath();
      ctx.arc(h.x, h.y, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
```

---

#### Task 13: Run Typecheck and Test

```bash
npm run typecheck
```

**Test scenarios:**
- [ ] Corner handle scale (all 4 corners)
- [ ] Side handle scale (all 4 sides)
- [ ] Flip past origin (negative scale)
- [ ] Mixed selection (strokes + shapes)
- [ ] Strokes always uniform, shapes stretch with side handles
- [ ] Translate commit persists
- [ ] Scale commit persists
- [ ] Undo/redo works
- [ ] Selection highlighting shows bbox for strokes
- [ ] No ghosting during transform

---

## Critical Implementation Notes

### Scale Formula (FIXED)
```
scale = (cursor - origin) * handleSign / origDimension
```
**NOT** `/ (origDimension / 2)` which was the bug!

### Flip/Mirror Support
- Keep scale SIGNED (can be negative)
- Only use `Math.abs()` on final frame dimensions in commitScale

### Stroke Uniform Scaling
- Strokes ALWAYS scale uniformly regardless of handle type
- For side handles: use primary axis (X for e/w, Y for n/s)
- For corner handles: use max(|scaleX|, |scaleY|)

### Mixed Selections
- Per-object scale logic in BOTH objects.ts (preview) AND SelectTool.ts (commit)
- Shapes: directional with side handles
- Strokes: always uniform

### Transform Order
1. Clear transform state (`endTransform()`)
2. THEN mutate Y.Doc
This prevents double-transform visual glitch.

### First-Move Dirty Rect
Must invalidate union of BOTH original bounds AND transformed bounds to clear ghosting.

---

## Files Summary

| File | Status | Changes |
|------|--------|---------|
| `client/src/lib/tools/types.ts` | ✅ DONE | Added side handles to HandleId |
| `client/src/stores/selection-store.ts` | ✅ DONE | Added handleId to ScaleTransform |
| `client/src/lib/tools/SelectTool.ts` | ⏳ PENDING | Scale fix, commit, dirty rects |
| `client/src/renderer/layers/objects.ts` | ⏳ PENDING | Per-object scale logic |
| `client/src/renderer/OverlayRenderLoop.ts` | ⏳ PENDING | Stroke bbox, side handle circles |

---

## Previous Sessions

### Phase 4 (Session 2) - WYSIWYG Transform + Selection Highlighting
- Added HIT_SLACK_PX for forgiving hit detection
- Added selectedIds to SelectionPreview
- Implemented selection highlighting on overlay
- Implemented WYSIWYG transform preview in objects.ts

### Phase 3 (Session 1) - Critical Bug Fixes
- Fixed bbox format mismatch ([minX,minY,maxX,maxY] not [x,y,w,h])
- Fixed empty space click not clearing selection
- Fixed marquee using center-point instead of intersection

### Phase 2 - Integration
- Full Canvas.tsx integration
- Cursor handling for handles
- Overlay rendering for selection preview

### Phase 1 - Foundation
- Created selection-store.ts
- Created SelectTool.ts with state machine
- Hit testing with fill-awareness
