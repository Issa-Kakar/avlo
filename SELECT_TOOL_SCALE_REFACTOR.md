# SelectTool Scale Transform Refactor - Complete Implementation Guide

**Branch:** `feature/select-tool`
**Date:** 2025-01-27
**Purpose:** Fix scale transform dirty rects, implement correct UX for mixed selections, and achieve true WYSIWYG

---

## Table of Contents

1. [Behavior Specification](#1-behavior-specification)
2. [Current Issues Analysis](#2-current-issues-analysis)
3. [Root Cause Diagnosis](#3-root-cause-diagnosis)
4. [Solution Architecture](#4-solution-architecture)
5. [Implementation Tasks](#5-implementation-tasks)
6. [File Reference](#6-file-reference)
7. [Test Scenarios](#7-test-scenarios)

---

## 1. Behavior Specification

### 1.1 Complete Behavior Matrix

| Selection | Handle | Object | Scale Type | Stroke Width | Flip Rule |
|-----------|--------|--------|------------|--------------|-----------|
| shapesOnly | corner | shape | Non-uniform | Constant | Any direction |
| shapesOnly | side | shape | Single-axis | Constant | Any direction |
| strokesOnly | corner | stroke | Uniform | **Scales** | Diagonal only |
| strokesOnly | side | stroke | Uniform (corner-like) | **Scales** | Diagonal only |
| **mixed** | **corner** | **shape** | **Uniform** | Constant | Diagonal only |
| **mixed** | **corner** | **stroke** | Uniform | **Scales** | Diagonal only |
| **mixed** | **side** | **shape** | Normal single-axis | Constant | **Opposite (axis)** |
| **mixed** | **side** | **stroke** | **TRANSLATE** | **Unchanged** | **Opposite (axis)** |

### 1.2 Key UX Principles

#### Shapes-Only Selection (Current Behavior - No Changes)
- **Corner handles:** Non-uniform scale (each axis independent)
- **Side handles:** Single-axis scale
- **Shape stroke width:** Always constant (preserved)
- **Flip:** Allowed in any direction

#### Strokes-Only Selection
- **Corner handles:** Uniform scale (aspect ratio preserved)
- **Side handles:** Behave like corners (uniform scale from primary axis)
- **Stroke width:** Scales with geometry for WYSIWYG
- **Flip:** Diagonal only (both axes must flip together)

#### Mixed Selection (Shapes + Strokes) - THE CRITICAL CASE
- **Corner handles:**
  - **Both shapes AND strokes use UNIFORM scale**
  - Shapes: geometry scales uniformly, stroke width constant
  - Strokes: geometry scales uniformly, stroke width scales
  - Flip: Diagonal only

- **Side handles (Miro-like behavior):**
  - **Shapes:** Normal single-axis scale (current behavior)
  - **Strokes:** **TRANSLATE ONLY** - slide proportionally, no geometry change
  - Strokes preserve their size and shape completely
  - Strokes' positions move to maintain relative position within selection bounds
  - Flip: Allowed in **opposite direction** (along the axis being dragged)
    - Example: Dragging E handle past W edge flips X axis
    - Shapes flip normally, strokes slide to mirrored position

### 1.3 Mixed + Side Handle: Stroke Translation (Miro-Like)

When dragging a side handle in a mixed selection, strokes "slide" to maintain their relative position:

```
Original Selection: [0, 0, 100, 100]
Stroke A at y=90 (near bottom, relY=0.9)
Stroke B at y=50 (middle, relY=0.5)

Drag TOP (N) handle DOWN (compressing selection):
```

| scaleY | Bounds Y | Stroke A Position | Stroke B Position | Shapes |
|--------|----------|-------------------|-------------------|--------|
| 1.0    | [0, 100] | y=90 (stays)      | y=50 (stays)      | Full size |
| 0.5    | [50, 100]| y=95 (slides down)| y=75 (slides down)| Compress Y |
| 0.2    | [80, 100]| y=98 (near bottom)| y=90 (compressed) | Compress Y |
| -0.2   | [100,120]| y=118 (flipped)   | y=110 (flipped)   | Flipped |

**Key insight:** Stroke A (relY=0.9) stays near the bottom edge as selection compresses. On flip, it ends up near the bottom of the flipped bounds.

### 1.4 Flip Rules by Context

**Strokes-Only Selection (any handle):**
- Flip is only allowed when **both** scaleX AND scaleY are negative (diagonal only)
- Single-axis flip is prevented
- This ensures strokes flip consistently (toward opposite corner)

```typescript
// Strokes-only: diagonal flip rule
const flipped = rawScaleX < 0 && rawScaleY < 0;
const sign = flipped ? -1 : 1;
const s = sign * absMax;  // Uniform scale with flip sign
```

**Mixed Selection - Corner Handles:**
- Same as strokes-only: diagonal flip only
- Both shapes and strokes flip together toward opposite corner

**Mixed Selection - Side Handles:**
- Flip IS allowed in the **opposite direction** (along the dragged axis)
- Example: Dragging East handle past West edge → X axis flips
- Shapes: Normal axis flip (geometry mirrors)
- Strokes: Translate to mirrored relative position (same size, position mirrors)

```typescript
// Mixed + side: axis flip allowed
// Strokes translate to mirrored position automatically via relative position math
const relX = (strokeCenterX - origBounds.minX) / boundsWidth;
// When bounds flip, actualMinX/actualMaxX swap, and newCenterX mirrors naturally
```

---

## 2. Current Issues Analysis

### 2.1 Critical Issues

| Issue | Severity | Location | Impact |
|-------|----------|----------|--------|
| **Stale pixels during scale** | HIGH | `SelectTool.ts` | Ghosting artifacts, especially on axis flips |
| **Stroke width not scaling on commit** | HIGH | `SelectTool.ts:730-784` | WYSIWYG broken - preview doesn't match commit |
| **Mixed corner uses non-uniform for shapes** | HIGH | `SelectTool.ts` | Shapes should use uniform in mixed selection |
| **Mixed side scales strokes** | HIGH | `SelectTool.ts` | Strokes should translate, not scale |
| **Stroke scale uses ctx.scale()** | MEDIUM | `objects.ts` | PF thinning/smoothing distorted during preview |

### 2.2 What's Working

- Hit testing: Perfect
- Translation transforms: Perfect (dirty rects clear correctly)
- Shape WYSIWYG for shapes-only: Perfect (geometry scales, stroke width preserved)
- Cache reuse during translation: Working

---

## 3. Root Cause Diagnosis

### 3.1 Bug 1: Dirty Rect Mismatch

**Location:** `SelectTool.ts:invalidateTransformPreview` and `objects.ts:applySelectionTransform`

**The Problem:**

During **preview**, strokes are rendered with uniform scale:
```typescript
// objects.ts - preview uses uniform scale
if (objectKind === 'stroke' || objectKind === 'connector') {
  const uniformScale = computeUniformScale(sx, sy, transform.handleId);
  sx = uniformScale;
  sy = uniformScale;
}
ctx.scale(sx, sy);  // Uniform scale applied
```

But **dirty rects** use raw `scaleX/scaleY`:
```typescript
// SelectTool.ts - uses raw scale
return {
  minX: ox + (bounds.minX - ox) * transform.scaleX,  // Raw!
  minY: oy + (bounds.minY - oy) * transform.scaleY,  // Raw!
  ...
};
```

**Result:** Dirty rect doesn't cover the actual rendered pixels → stale ghosting.

### 3.2 Bug 2: Sliding Window vs Accumulating Envelope

**Location:** `SelectTool.ts:invalidateTransformPreview`

**Current Logic:**
```typescript
this.prevPreviewBounds = transformedBounds;  // OVERWRITES previous!
```

When user drags out then back, extreme positions are lost → stale staircase trail.

**Fix:** Accumulate envelope (grow to include all visited positions).

### 3.3 Bug 3: Negative Scale Produces Invalid Rects

**Location:** `SelectTool.ts:applyTransformToBounds`

When `scaleX < 0` (flip), computed `minX > maxX` → invalid rect → stale pixels at flip axis.

**Fix:** Normalize with `Math.min/max` after transform.

### 3.4 Bug 4: Mixed Selection Uses Wrong Scale Types

**Current behavior (WRONG):**
- Mixed + corner + shapes → Non-uniform scale
- Mixed + side + strokes → Uniform scale

**Correct behavior:**
- Mixed + corner + shapes → **Uniform** scale
- Mixed + side + strokes → **Translate** (no scale)

---

## 4. Solution Architecture

### 4.1 Selection Store Changes

**File:** `client/src/stores/selection-store.ts`

Add `selectionKind` and `handleKind` to track context:

```typescript
export type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
export type HandleKind = 'corner' | 'side';

interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];
  scaleX: number;
  scaleY: number;
  originBounds: WorldRect;
  handleId: HandleId;
  selectionKind: SelectionKind;  // NEW
  handleKind: HandleKind;         // NEW
}
```

**Compute at `beginScale`:**
```typescript
beginScale: (originBounds, origin, handleId, selectedIds, objectsById) => {
  // Compute selection kind
  const hasStroke = selectedIds.some(id => {
    const h = objectsById.get(id);
    return h?.kind === 'stroke' || h?.kind === 'connector';
  });
  const hasShape = selectedIds.some(id => {
    const h = objectsById.get(id);
    return h?.kind === 'shape' || h?.kind === 'text';
  });

  let selectionKind: SelectionKind = 'none';
  if (hasStroke && hasShape) selectionKind = 'mixed';
  else if (hasStroke) selectionKind = 'strokesOnly';
  else if (hasShape) selectionKind = 'shapesOnly';

  // Compute handle kind
  const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
  const handleKind: HandleKind = isCorner ? 'corner' : 'side';

  set({
    transform: {
      kind: 'scale',
      origin,
      scaleX: 1,
      scaleY: 1,
      originBounds,
      handleId,
      selectionKind,
      handleKind
    }
  });
}
```

### 4.2 Scale Factor Computation

**File:** `SelectTool.ts`

Different computation based on selection context:

```typescript
private computeScaleFactors(
  worldX: number,
  worldY: number,
  handleId: HandleId,
  origin: [number, number],
  originBounds: WorldRect,
  selectionKind: SelectionKind
): { scaleX: number; scaleY: number } {
  const [ox, oy] = origin;
  const origWidth = originBounds.maxX - originBounds.minX;
  const origHeight = originBounds.maxY - originBounds.minY;

  const dx = worldX - ox;
  const dy = worldY - oy;

  const handleSignX = this.getHandleSignX(handleId);
  const handleSignY = this.getHandleSignY(handleId);

  const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  // Compute raw scale factors
  let rawScaleX = 1, rawScaleY = 1;
  if (isCorner) {
    rawScaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    rawScaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
  } else if (isSideH) {
    rawScaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    rawScaleY = 1;
  } else if (isSideV) {
    rawScaleY = origHeight > 0 ? (dy * handleSignY) / origHeight : 1;
    rawScaleX = 1;
  }

  // Selection-specific behavior
  const hasStrokes = selectionKind === 'strokesOnly' || selectionKind === 'mixed';

  if (selectionKind === 'shapesOnly') {
    // Shapes-only: raw scale, any flip allowed
    return { scaleX: rawScaleX, scaleY: rawScaleY };
  }

  if (selectionKind === 'strokesOnly') {
    // Strokes-only: ALWAYS uniform scale (side handles act like corners)
    return this.computeUniformScaleWithDiagonalFlip(rawScaleX, rawScaleY);
  }

  if (selectionKind === 'mixed') {
    if (isCorner) {
      // Mixed + corner: uniform scale for both shapes and strokes
      return this.computeUniformScaleWithDiagonalFlip(rawScaleX, rawScaleY);
    } else {
      // Mixed + side: shapes scale normally (can flip axis), strokes translate
      return this.computeScaleForMixedSide(rawScaleX, rawScaleY, isSideH);
    }
  }

  return { scaleX: rawScaleX, scaleY: rawScaleY };
}

private computeUniformScaleWithDiagonalFlip(
  rawScaleX: number,
  rawScaleY: number
): { scaleX: number; scaleY: number } {
  const minScale = 0.05;  // Prevent collapse to zero
  const absMax = Math.max(Math.abs(rawScaleX), Math.abs(rawScaleY), minScale);

  // Diagonal flip: only when BOTH are negative
  const flipped = rawScaleX < 0 && rawScaleY < 0;
  const sign = flipped ? -1 : 1;
  const s = sign * absMax;

  return { scaleX: s, scaleY: s };
}

private computeScaleForMixedSide(
  rawScaleX: number,
  rawScaleY: number,
  isSideH: boolean
): { scaleX: number; scaleY: number } {
  // For mixed + side: allow axis flip (opposite direction)
  // Shapes scale normally along the axis (can flip)
  // Strokes translate (handled separately in rendering/commit)
  const minScale = 0.05;

  if (isSideH) {
    // Horizontal side: scaleY is 1, only X changes
    // X CAN go negative (flip allowed)
    const scaleX = Math.abs(rawScaleX) < minScale
      ? Math.sign(rawScaleX) * minScale || minScale
      : rawScaleX;
    return { scaleX, scaleY: 1 };
  } else {
    // Vertical side: scaleX is 1, only Y changes
    // Y CAN go negative (flip allowed)
    const scaleY = Math.abs(rawScaleY) < minScale
      ? Math.sign(rawScaleY) * minScale || minScale
      : rawScaleY;
    return { scaleX: 1, scaleY };
  }
}
```

### 4.3 Stroke Translation for Mixed + Side

**New function to compute translation for strokes:**

```typescript
private computeStrokeTranslationForMixedSide(
  handle: ObjectHandle,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number]
): { dx: number; dy: number } {
  // Get stroke center from bbox
  const [minX, minY, w, h] = handle.bbox;
  const strokeCenterX = minX + w / 2;
  const strokeCenterY = minY + h / 2;

  // Compute relative position in original bounds (0 to 1)
  const boundsWidth = originBounds.maxX - originBounds.minX;
  const boundsHeight = originBounds.maxY - originBounds.minY;

  const relX = boundsWidth > 0
    ? (strokeCenterX - originBounds.minX) / boundsWidth
    : 0.5;
  const relY = boundsHeight > 0
    ? (strokeCenterY - originBounds.minY) / boundsHeight
    : 0.5;

  // Compute new selection bounds after scale
  const [ox, oy] = origin;
  const newMinX = ox + (originBounds.minX - ox) * scaleX;
  const newMaxX = ox + (originBounds.maxX - ox) * scaleX;
  const newMinY = oy + (originBounds.minY - oy) * scaleY;
  const newMaxY = oy + (originBounds.maxY - oy) * scaleY;

  // Normalize for flip (ensure min < max)
  const actualMinX = Math.min(newMinX, newMaxX);
  const actualMaxX = Math.max(newMinX, newMaxX);
  const actualMinY = Math.min(newMinY, newMaxY);
  const actualMaxY = Math.max(newMinY, newMaxY);

  // Compute new stroke center (same relative position in new bounds)
  const newWidth = actualMaxX - actualMinX;
  const newHeight = actualMaxY - actualMinY;
  const newCenterX = actualMinX + relX * newWidth;
  const newCenterY = actualMinY + relY * newHeight;

  // Return translation delta
  return {
    dx: newCenterX - strokeCenterX,
    dy: newCenterY - strokeCenterY,
  };
}
```

### 4.4 Preview Rendering Changes

**File:** `client/src/renderer/layers/objects.ts`

Dispatch rendering based on selection context:

```typescript
function renderSelectedObjectWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
  objectsById: Map<string, ObjectHandle>
): void {
  const { selectionKind, handleKind } = transform;
  const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
  const isShape = handle.kind === 'shape' || handle.kind === 'text';

  // CASE 1: Mixed + Side + Stroke → TRANSLATE ONLY
  if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
    const { dx, dy } = computeStrokeTranslationForMixedSide(
      handle,
      transform.originBounds,
      transform.scaleX,
      transform.scaleY,
      transform.origin
    );
    ctx.save();
    ctx.translate(dx, dy);
    drawObject(ctx, handle);  // Use cached Path2D!
    ctx.restore();
    return;
  }

  // CASE 2: Mixed + Side + Shape → Normal single-axis scale
  if (selectionKind === 'mixed' && handleKind === 'side' && isShape) {
    drawShapeWithTransform(ctx, handle, transform);
    return;
  }

  // CASE 3: Mixed + Corner → Uniform scale for both
  if (selectionKind === 'mixed' && handleKind === 'corner') {
    const uniformScale = computeUniformScale(transform.scaleX, transform.scaleY);
    if (isStroke) {
      // PF-per-frame with scaled width
      drawScaledStrokePreviewPF(ctx, handle, transform, uniformScale);
    } else {
      // Shape with uniform scale (stroke width preserved)
      drawShapeWithUniformScale(ctx, handle, transform, uniformScale);
    }
    return;
  }

  // CASE 4: Strokes-only → Uniform scale
  if (selectionKind === 'strokesOnly' && isStroke) {
    const uniformScale = computeUniformScale(transform.scaleX, transform.scaleY);
    drawScaledStrokePreviewPF(ctx, handle, transform, uniformScale);
    return;
  }

  // CASE 5: Shapes-only → Normal non-uniform scale
  if (selectionKind === 'shapesOnly' && isShape) {
    drawShapeWithTransform(ctx, handle, transform);
    return;
  }

  // Fallback
  drawObject(ctx, handle);
}

// PF-per-frame for true WYSIWYG stroke preview
function drawScaledStrokePreviewPF(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
  uniformScale: number
): void {
  const { y } = handle;

  const points = y.get('points') as [number, number][];
  const width = y.get('width') as number;
  const color = (y.get('color') as string) ?? '#000';
  const opacity = (y.get('opacity') as number) ?? 1;

  if (!points || points.length === 0) return;

  const [ox, oy] = transform.origin;
  const absScale = Math.abs(uniformScale);

  // Transform points
  const scaledPoints: [number, number][] = points.map(([x, y]) => [
    ox + (x - ox) * uniformScale,
    oy + (y - oy) * uniformScale,
  ]);

  // Scale width for WYSIWYG
  const scaledWidth = width * absScale;

  // Generate new PF outline (NOT cached - fresh each frame)
  const outline = getStroke(scaledPoints, {
    ...PF_OPTIONS_BASE,
    size: scaledWidth,
    last: true,
  });

  const path = new Path2D(getSvgPathFromStroke(outline, false));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

// Shape with uniform scale (for mixed + corner)
function drawShapeWithUniformScale(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform,
  uniformScale: number
): void {
  const { y } = handle;
  const frame = y.get('frame') as [number, number, number, number];
  if (!frame) return;

  const [ox, oy] = transform.origin;
  const [x, y_, w, h] = frame;

  // Apply uniform scale to frame
  const newX = ox + (x - ox) * uniformScale;
  const newY = oy + (y_ - oy) * uniformScale;
  const newW = w * Math.abs(uniformScale);
  const newH = h * Math.abs(uniformScale);

  // Draw shape with scaled frame, but preserved stroke width
  drawShapeAtFrame(ctx, handle, [newX, newY, newW, newH]);
}
```

### 4.5 Commit Logic Changes

**File:** `SelectTool.ts` - modify `commitScale`

```typescript
private commitScale(
  selectedIds: string[],
  origin: [number, number],
  scaleX: number,
  scaleY: number,
  handleId: HandleId,
  selectionKind: SelectionKind,
  handleKind: HandleKind,
  originBounds: WorldRect
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

      const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
      const isShape = handle.kind === 'shape' || handle.kind === 'text';

      // CASE 1: Mixed + Side + Stroke → TRANSLATE ONLY
      if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
        const { dx, dy } = this.computeStrokeTranslationForMixedSide(
          handle, originBounds, scaleX, scaleY, origin
        );

        const points = yMap.get('points') as [number, number][];
        if (!points) continue;

        const newPoints: [number, number][] = points.map(([x, y]) => [
          x + dx,
          y + dy
        ]);
        yMap.set('points', newPoints);
        // WIDTH UNCHANGED!
        continue;
      }

      // CASE 2: Mixed + Side + Shape → Normal single-axis scale
      if (selectionKind === 'mixed' && handleKind === 'side' && isShape) {
        this.applyScaleToShape(yMap, ox, oy, scaleX, scaleY);
        continue;
      }

      // CASE 3: Mixed + Corner → Uniform scale for both
      if (selectionKind === 'mixed' && handleKind === 'corner') {
        const uniformScale = this.computeUniformScaleValue(scaleX, scaleY);

        if (isStroke) {
          this.applyUniformScaleToStroke(yMap, ox, oy, uniformScale);
        } else {
          this.applyUniformScaleToShape(yMap, ox, oy, uniformScale);
        }
        continue;
      }

      // CASE 4: Strokes-only → Uniform scale with width
      if (selectionKind === 'strokesOnly' && isStroke) {
        const uniformScale = this.computeUniformScaleValue(scaleX, scaleY);
        this.applyUniformScaleToStroke(yMap, ox, oy, uniformScale);
        continue;
      }

      // CASE 5: Shapes-only → Normal non-uniform scale
      if (selectionKind === 'shapesOnly' && isShape) {
        this.applyScaleToShape(yMap, ox, oy, scaleX, scaleY);
        continue;
      }
    }
  });
}

private applyUniformScaleToStroke(
  yMap: Y.Map<unknown>,
  ox: number,
  oy: number,
  uniformScale: number
): void {
  const points = yMap.get('points') as [number, number][];
  if (!points) return;

  const absScale = Math.abs(uniformScale);

  const newPoints: [number, number][] = points.map(([x, y]) => [
    ox + (x - ox) * uniformScale,
    oy + (y - oy) * uniformScale,
  ]);
  yMap.set('points', newPoints);

  // CRITICAL: Scale width for WYSIWYG
  const oldWidth = (yMap.get('width') as number) ?? 2;
  yMap.set('width', oldWidth * absScale);
}

private applyUniformScaleToShape(
  yMap: Y.Map<unknown>,
  ox: number,
  oy: number,
  uniformScale: number
): void {
  const frame = yMap.get('frame') as [number, number, number, number];
  if (!frame) return;

  const [x, y, w, h] = frame;
  const absScale = Math.abs(uniformScale);

  const newX = ox + (x - ox) * uniformScale;
  const newY = oy + (y - oy) * uniformScale;
  const newW = w * absScale;
  const newH = h * absScale;

  // Normalize for flip
  yMap.set('frame', [
    uniformScale < 0 ? newX - newW : newX,
    uniformScale < 0 ? newY - newH : newY,
    newW,
    newH,
  ]);
  // Shape stroke width: unchanged (preserved)
}

private applyScaleToShape(
  yMap: Y.Map<unknown>,
  ox: number,
  oy: number,
  scaleX: number,
  scaleY: number
): void {
  const frame = yMap.get('frame') as [number, number, number, number];
  if (!frame) return;

  const [x, y, w, h] = frame;

  const newX1 = ox + (x - ox) * scaleX;
  const newY1 = oy + (y - oy) * scaleY;
  const newX2 = ox + ((x + w) - ox) * scaleX;
  const newY2 = oy + ((y + h) - oy) * scaleY;

  yMap.set('frame', [
    Math.min(newX1, newX2),
    Math.min(newY1, newY2),
    Math.abs(newX2 - newX1),
    Math.abs(newY2 - newY1),
  ]);
}

private computeUniformScaleValue(scaleX: number, scaleY: number): number {
  const absMax = Math.max(Math.abs(scaleX), Math.abs(scaleY));
  const flipped = scaleX < 0 && scaleY < 0;
  return flipped ? -absMax : absMax;
}
```

### 4.6 Fixed Dirty Rect Invalidation

**File:** `SelectTool.ts`

#### 4.6.1 Fix `applyTransformToBounds` for Negative Scale

```typescript
private applyTransformToBounds(
  bounds: WorldRect,
  transform: TransformState
): WorldRect {
  if (transform.kind === 'translate') {
    return {
      minX: bounds.minX + transform.dx,
      minY: bounds.minY + transform.dy,
      maxX: bounds.maxX + transform.dx,
      maxY: bounds.maxY + transform.dy,
    };
  }

  if (transform.kind === 'scale') {
    const [ox, oy] = transform.origin;
    const sx = transform.scaleX;
    const sy = transform.scaleY;

    const x1 = ox + (bounds.minX - ox) * sx;
    const y1 = oy + (bounds.minY - oy) * sy;
    const x2 = ox + (bounds.maxX - ox) * sx;
    const y2 = oy + (bounds.maxY - oy) * sy;

    // CRITICAL: Normalize for negative scale (flip)
    return {
      minX: Math.min(x1, x2),
      minY: Math.min(y1, y2),
      maxX: Math.max(x1, x2),
      maxY: Math.max(y1, y2),
    };
  }

  return bounds;
}
```

#### 4.6.2 Accumulating Envelope with Per-Object Tracking

For mixed + side handles, we need to track stroke translations separately:

```typescript
private invalidateTransformPreview(): void {
  const store = useSelectionStore.getState();
  const transform = store.transform;
  if (transform.kind !== 'scale') return;

  const { selectionKind, handleKind, originBounds } = transform;
  const snapshot = this.room.currentSnapshot;

  // Compute combined bounds for all objects after transform
  let combinedBounds: WorldRect | null = null;

  for (const id of store.selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;

    const isStroke = handle.kind === 'stroke' || handle.kind === 'connector';
    let objectBounds: WorldRect;

    // Mixed + Side + Stroke: use translation-based bounds
    if (selectionKind === 'mixed' && handleKind === 'side' && isStroke) {
      const { dx, dy } = this.computeStrokeTranslationForMixedSide(
        handle, originBounds, transform.scaleX, transform.scaleY, transform.origin
      );
      const [minX, minY, w, h] = handle.bbox;
      objectBounds = {
        minX: minX + dx,
        minY: minY + dy,
        maxX: minX + w + dx,
        maxY: minY + h + dy,
      };
    } else {
      // All other cases: use scale-based bounds
      const [minX, minY, w, h] = handle.bbox;
      const baseBounds = { minX, minY, maxX: minX + w, maxY: minY + h };

      // For strokes in uniform scale mode, use uniform scale for bounds
      if (isStroke && (selectionKind === 'strokesOnly' ||
          (selectionKind === 'mixed' && handleKind === 'corner'))) {
        const s = this.computeUniformScaleValue(transform.scaleX, transform.scaleY);
        const [ox, oy] = transform.origin;
        const x1 = ox + (baseBounds.minX - ox) * s;
        const y1 = oy + (baseBounds.minY - oy) * s;
        const x2 = ox + (baseBounds.maxX - ox) * s;
        const y2 = oy + (baseBounds.maxY - oy) * s;
        objectBounds = {
          minX: Math.min(x1, x2),
          minY: Math.min(y1, y2),
          maxX: Math.max(x1, x2),
          maxY: Math.max(y1, y2),
        };
      } else {
        objectBounds = this.applyTransformToBounds(baseBounds, transform);
      }
    }

    // Union with combined bounds
    if (!combinedBounds) {
      combinedBounds = objectBounds;
    } else {
      combinedBounds = {
        minX: Math.min(combinedBounds.minX, objectBounds.minX),
        minY: Math.min(combinedBounds.minY, objectBounds.minY),
        maxX: Math.max(combinedBounds.maxX, objectBounds.maxX),
        maxY: Math.max(combinedBounds.maxY, objectBounds.maxY),
      };
    }
  }

  if (!combinedBounds) return;

  // ACCUMULATING ENVELOPE: Grow to include new position, never shrink
  if (this.prevPreviewBounds) {
    this.prevPreviewBounds = {
      minX: Math.min(this.prevPreviewBounds.minX, combinedBounds.minX),
      minY: Math.min(this.prevPreviewBounds.minY, combinedBounds.minY),
      maxX: Math.max(this.prevPreviewBounds.maxX, combinedBounds.maxX),
      maxY: Math.max(this.prevPreviewBounds.maxY, combinedBounds.maxY),
    };
  } else {
    // First move: include original bounds too
    const baseBounds = this.computeSelectionBounds();
    if (baseBounds) {
      this.prevPreviewBounds = {
        minX: Math.min(baseBounds.minX, combinedBounds.minX),
        minY: Math.min(baseBounds.minY, combinedBounds.minY),
        maxX: Math.max(baseBounds.maxX, combinedBounds.maxX),
        maxY: Math.max(baseBounds.maxY, combinedBounds.maxY),
      };
    } else {
      this.prevPreviewBounds = combinedBounds;
    }
  }

  this.invalidateWorld(this.prevPreviewBounds);
}
```

### 4.7 Hover Cursor for Strokes-Only

**File:** `SelectTool.ts`

For strokes-only selections, side handles should show diagonal cursors:

```typescript
private getHandleCursorForStrokes(
  handle: HandleId,
  worldX: number,
  worldY: number
): string {
  const bounds = this.computeSelectionBounds();
  if (!bounds) return 'default';

  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  switch (handle) {
    case 'e':  // Right edge
      return worldY < midY ? 'nesw-resize' : 'nwse-resize';
    case 'w':  // Left edge
      return worldY < midY ? 'nwse-resize' : 'nesw-resize';
    case 'n':  // Top edge
      return worldX < midX ? 'nwse-resize' : 'nesw-resize';
    case 's':  // Bottom edge
      return worldX < midX ? 'nesw-resize' : 'nwse-resize';
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    default: return 'default';
  }
}

updateHoverCursor(worldX: number, worldY: number): void {
  const store = useSelectionStore.getState();
  if (store.selectedIds.length === 0) {
    this.setCursorOverride(null);
    this.applyCursor();
    return;
  }

  const handle = this.hitTestHandle(worldX, worldY);
  if (handle) {
    const selectionKind = this.computeSelectionKind(store.selectedIds);
    const cursor = selectionKind === 'strokesOnly'
      ? this.getHandleCursorForStrokes(handle, worldX, worldY)
      : this.getHandleCursor(handle);
    this.setCursorOverride(cursor);
  } else {
    this.setCursorOverride(null);
  }
  this.applyCursor();
}
```

---

## 5. Implementation Tasks

### 5.1 Task Order (Dependencies)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 1: Store & Foundation                                             │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐  │
│  │ 1. Add selectionKind│  │ 2. Add handleKind   │  │ 3. Fix          │  │
│  │ to store + compute  │  │ to store            │  │ applyTransform  │  │
│  │ at beginScale       │  │                     │  │ ToBounds (flip) │  │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 2: Scale Factor Computation                                       │
│  ┌─────────────────────────────────┐  ┌─────────────────────────────┐   │
│  │ 4. Rewrite computeScaleFactors  │  │ 5. Add stroke translation   │   │
│  │ with selection-aware dispatch   │  │ function for mixed+side     │   │
│  └─────────────────────────────────┘  └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 3: Preview Rendering                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 6. Update objects.ts with context-aware rendering dispatch          ││
│  │    - Mixed+side+stroke: ctx.translate only (cached Path2D)          ││
│  │    - Mixed+corner: uniform scale (PF-per-frame for strokes)         ││
│  │    - StrokesOnly: PF-per-frame                                      ││
│  │    - ShapesOnly: current behavior                                   ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 4: Commit Logic                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 7. Rewrite commitScale with context-aware dispatch                  ││
│  │    - Mixed+side+stroke: translate points only, no width change      ││
│  │    - Mixed+corner+stroke: uniform scale + width scale               ││
│  │    - Mixed+corner+shape: uniform scale, width preserved             ││
│  │    - StrokesOnly: uniform scale + width scale                       ││
│  │    - ShapesOnly: current behavior                                   ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 5: Dirty Rect Fixes                                               │
│  ┌───────────────────────────────┐  ┌─────────────────────────────────┐ │
│  │ 8. Per-object bounds tracking │  │ 9. Accumulating envelope        │ │
│  │ for mixed+side (translation   │  │ instead of sliding window       │ │
│  │ vs scale bounds)              │  │                                 │ │
│  └───────────────────────────────┘  └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 6: UX Polish                                                      │
│  ┌───────────────────────────────┐  ┌─────────────────────────────────┐ │
│  │ 10. Cursor changes for        │  │ 11. Cache reuse for             │ │
│  │ strokesOnly side handles      │  │ ALL translations                │ │
│  └───────────────────────────────┘  └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Detailed Task List

#### Task 1: Add `selectionKind` to Selection Store

**File:** `client/src/stores/selection-store.ts`

1. Add type: `export type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';`
2. Add field to `ScaleTransform`: `selectionKind: SelectionKind`
3. Update `beginScale` action to compute and store `selectionKind`

#### Task 2: Add `handleKind` to Selection Store

**File:** `client/src/stores/selection-store.ts`

1. Add type: `export type HandleKind = 'corner' | 'side';`
2. Add field to `ScaleTransform`: `handleKind: HandleKind`
3. Compute at `beginScale`: `isCorner ? 'corner' : 'side'`

#### Task 3: Fix `applyTransformToBounds` for Negative Scale

**File:** `client/src/lib/tools/SelectTool.ts`

1. Add `Math.min/max` normalization for scale transform
2. Test with flip gestures

#### Task 4: Rewrite `computeScaleFactors`

**File:** `client/src/lib/tools/SelectTool.ts`

1. Add selection-aware dispatch logic
2. Implement `computeUniformScaleWithDiagonalFlip`
3. Implement `enforceNonNegativeForSide` for mixed+side

#### Task 5: Add Stroke Translation Function

**File:** `client/src/lib/tools/SelectTool.ts`

1. Implement `computeStrokeTranslationForMixedSide`
2. Compute relative position in bounds, map to new bounds

#### Task 6: Update Preview Rendering

**File:** `client/src/renderer/layers/objects.ts`

1. Add imports for PF functions
2. Implement `renderSelectedObjectWithTransform` dispatch
3. Implement `drawScaledStrokePreviewPF` (PF-per-frame)
4. Implement `drawShapeWithUniformScale` (for mixed+corner)
5. Update main render loop to use dispatch

#### Task 7: Rewrite Commit Logic

**File:** `client/src/lib/tools/SelectTool.ts`

1. Rewrite `commitScale` with context-aware dispatch
2. Implement helper methods:
   - `applyUniformScaleToStroke` (with width scaling)
   - `applyUniformScaleToShape` (width preserved)
   - `applyScaleToShape` (non-uniform)

#### Task 8: Per-Object Bounds Tracking

**File:** `client/src/lib/tools/SelectTool.ts`

1. Update `invalidateTransformPreview` to compute per-object bounds
2. Use translation bounds for mixed+side+strokes
3. Use scale bounds for everything else

#### Task 9: Accumulating Envelope

**File:** `client/src/lib/tools/SelectTool.ts`

1. Replace sliding window with accumulating envelope
2. Reset in `resetState()`

#### Task 10: Cursor Changes for Strokes-Only

**File:** `client/src/lib/tools/SelectTool.ts`

1. Implement `getHandleCursorForStrokes`
2. Update `updateHoverCursor` to use it

#### Task 11: Cache Reuse for Translations

**File:** `client/src/renderer/layers/objects.ts`

1. For `transform.kind === 'translate'`, use `ctx.translate()` with cached Path2D
2. Apply to all object types

---

## 6. File Reference

| File | Changes Required |
|------|------------------|
| `client/src/stores/selection-store.ts` | Add selectionKind, handleKind types and fields |
| `client/src/lib/tools/SelectTool.ts` | Major: scale computation, commit logic, dirty rects, cursor |
| `client/src/renderer/layers/objects.ts` | Major: context-aware preview rendering dispatch |
| `client/src/renderer/object-cache.ts` | No changes |
| `client/src/renderer/DirtyRectTracker.ts` | No changes |
| `client/src/renderer/RenderLoop.ts` | No changes |

---

## 7. Test Scenarios

### 7.1 Shapes-Only Selection

| Test | Expected |
|------|----------|
| Corner drag | Non-uniform scale, shape stroke width constant |
| Side drag | Single-axis scale, shape stroke width constant |
| Flip any direction | Allowed, works correctly |

### 7.2 Strokes-Only Selection

| Test | Expected |
|------|----------|
| Corner drag | Uniform scale, stroke width scales |
| Side drag | Uniform scale (acts like corner), stroke width scales |
| Flip | Only diagonal (both axes), no single-axis flip |
| Side handle cursor | Diagonal cursor based on position |

### 7.3 Mixed Selection - Corner Handles

| Test | Expected |
|------|----------|
| Corner drag | BOTH shapes and strokes use uniform scale |
| Shape stroke width | Constant (preserved) |
| Stroke width | Scales with geometry |
| Flip | Only diagonal |

### 7.4 Mixed Selection - Side Handles (Miro-Like)

| Test | Expected |
|------|----------|
| Shape behavior | Normal single-axis scale |
| Stroke behavior | TRANSLATE only, no geometry change |
| Stroke width | Unchanged |
| Stroke at bottom, drag top down | Stroke stays near bottom, slides slightly |
| Drag E handle past W edge | X axis flips - shapes mirror, strokes slide to mirrored position |
| Drag N handle past S edge | Y axis flips - shapes mirror, strokes slide to mirrored position |

### 7.5 Dirty Rect Validation

| Test | Expected |
|------|----------|
| Scale up, then back | No stale staircase trail |
| Flip (any selection) | No stale pixels at flip axis |
| Mixed + side | Strokes clear correctly with translation bounds |

### 7.6 WYSIWYG Validation

| Test | Expected |
|------|----------|
| Scale stroke 2x | Preview matches commit (width doubles) |
| Mixed + corner + stroke | Width scales on commit |
| Mixed + side + stroke | Width unchanged on commit |
| PF thinning | Preserved during scale preview |

---

**End of Document**
