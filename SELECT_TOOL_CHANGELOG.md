# SelectTool Scale Transform - Changelog & Current State

**Date:** 2025-01-29
**Branch:** `feature/select-tool`
**Last Commit:** `daea2d0` - feat: position preservation for corner handle uniform scaling

---

## Session Summary

This document tracks the evolution of SelectTool scale transform behavior. Three main phases have been completed.

---

## Phase 1: Dead Zone Fix (COMMITTED - a3966c9)

### Problem
The `applyFlipDeadZone()` function was corrupting ALL scale values before any context-aware logic could run.

### Solution
1. Removed dead zone from `computeScaleFactors()`
2. Deleted `applyFlipDeadZone()` entirely
3. Rewrote `computeUniformScaleWithDiagonalFlip()` with proper flip rules

---

## Phase 2: No-Geometry-Inversion (COMMITTED - a3966c9)

### Problem
When flipping, stroke geometry would mirror/invert visually.

### Solution
Used absolute scale (`absScale`) for geometry while allowing signed scale for position:
```typescript
const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
const absScale = Math.abs(uniformScale);
// Geometry uses absScale (never inverts)
```

---

## Phase 3: Position Preservation (COMMITTED - daea2d0)

### Problem
When flipping diagonally with corner handles, object positions would invert within the selection box:
- Object at top-left would end up at bottom-right after flip
- Object at bottom-right would end up at top-left after flip

**Example:** Selection with "3" at top-left and "S" at bottom-right:
```
BEFORE:                    OLD FLIP BEHAVIOR:         NEW BEHAVIOR:
┌─────────────┐           ┌─────────────┐           ┌─────────────┐
│ 3           │           │           S │           │ 3           │
│             │    ──►    │             │    ──►    │             │
│           S │           │ 3           │           │           S │
└─────────────┘           └─────────────┘           └─────────────┘
```

### Solution
Implemented `computePreservedPosition()` helper that:
1. Computes object's normalized position (0-1) within the selection box
2. Transforms the selection box corners with the scale
3. Places the object at the same normalized position in the new (possibly flipped) box

**Key Math:**
```typescript
function computePreservedPosition(
  cx: number, cy: number,           // object center
  originBounds: WorldRect,          // selection box
  origin: [number, number],         // transform anchor
  uniformScale: number              // signed scale
): [number, number] {
  const { minX, minY, maxX, maxY } = originBounds;
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;

  // 1. Relative position in original box (0-1)
  const tx = boxWidth > 0 ? (cx - minX) / boxWidth : 0.5;
  const ty = boxHeight > 0 ? (cy - minY) / boxHeight : 0.5;

  // 2. Compute new box corners (both transform around origin)
  const newCorner1X = ox + (minX - ox) * uniformScale;
  const newCorner1Y = oy + (minY - oy) * uniformScale;
  const newCorner2X = ox + (maxX - ox) * uniformScale;
  const newCorner2Y = oy + (maxY - oy) * uniformScale;

  // 3. Get actual min/max (handles flip)
  const newMinX = Math.min(newCorner1X, newCorner2X);
  const newMinY = Math.min(newCorner1Y, newCorner2Y);
  const newBoxWidth = Math.abs(newCorner2X - newCorner1X);
  const newBoxHeight = Math.abs(newCorner2Y - newCorner1Y);

  // 4. Apply same relative position in new box
  return [newMinX + tx * newBoxWidth, newMinY + ty * newBoxHeight];
}
```

### Files Modified

| File | Changes |
|------|---------|
| `SelectTool.ts` | Added `computePreservedPosition()` helper |
| `SelectTool.ts` | Updated stroke scaling in `commitScale()` to use preserved position |
| `SelectTool.ts` | Updated stroke scaling in `invalidateTransformPreview()` to use preserved position |
| `SelectTool.ts` | Updated shape scaling for mixed+corner to use center-based approach with absScale + preserved position |
| `objects.ts` | Added `computePreservedPosition()` helper |
| `objects.ts` | Updated `drawScaledStrokePreview()` to use preserved position |
| `objects.ts` | Updated `drawShapeWithUniformScale()` to use center-based approach with absScale + preserved position |
| `objects.ts` | Updated `drawTextWithUniformScale()` with same approach |

---

## Current Behavior Summary

### Corner Handle Scaling (WORKING PERFECTLY ✓)

| Selection Type | Behavior |
|----------------|----------|
| **Strokes-only** | Uniform scale, no geometry inversion, position preserved |
| **Mixed (strokes + shapes)** | Uniform scale, no geometry inversion, position preserved |
| **Shapes-only** | Non-uniform scale (independent X/Y), corner-based |

### Side Handle Scaling

| Selection Type | Behavior | Status |
|----------------|----------|--------|
| **Strokes-only** | Resize with snapping | ❌ Needs work - remove snapping, add preserved position |
| **Mixed** | Shapes scale, strokes translate | ✓ Working |
| **Shapes-only** | Non-uniform scale (one axis) | ⚠️ Has anchor issue (see below) |

---

## Known Issues / Future Work

### 1. Strokes-Only Side Handle Resize
**Current:** Has awkward "snapping" behavior
**Desired:** Normal resize behavior with flip support and preserved position
**Approach:** Apply same pattern as corner handles - use preserved position, remove threshold snapping

### 2. Shapes Selection Box "Sliding" Issue
**Current:** When resizing shapes-only (any handle) or mixed (side handles), the selection box "slides" instead of anchoring
**Desired:** Selection box should have a fixed anchor point (opposite corner/edge) like Figma and other apps
**Observed in:**
- Shapes-only corner resize
- Shapes-only side resize
- Mixed side resize (shapes portion)

**Root cause:** May be using incorrect origin calculation or transform formula. The perfect shape preview during drawing DOES anchor correctly - need to investigate that code path.

---

## Code Locations Reference

```
SelectTool.ts:
  - computePreservedPosition(): ~line 1104
  - computeUniformScaleNoThreshold(): ~line 1022
  - computeUniformScaleWithDiagonalFlip(): ~line 1078 (now unused, prefixed _)
  - commitScale() stroke case: ~line 891
  - commitScale() shape case: ~line 924
  - invalidateTransformPreview() stroke case: ~line 729
  - invalidateTransformPreview() shape case: ~line 761

objects.ts:
  - computePreservedPosition(): ~line 617
  - computeUniformScaleNoThreshold(): ~line 588
  - drawScaledStrokePreview(): ~line 658
  - drawShapeWithUniformScale(): ~line 719
  - drawTextWithUniformScale(): ~line 788
```

---

## Quick Test Scenarios

### Corner Handles (All Working ✓)
1. **Two strokes diagonal:** Flip → positions preserved, geometry not inverted ✓
2. **Two shapes (mixed selection):** Flip → positions preserved, geometry not inverted ✓
3. **Mixed stroke + shape:** Flip → positions preserved, geometry not inverted ✓
4. **Single object:** Flip → works correctly (t=0.5, 0.5 stays centered) ✓
5. **Shrink without flip:** Normal scaling unchanged ✓

### Side Handles (Needs Work)
1. **Strokes-only side:** Has snapping, needs preserved position
2. **Shapes-only side:** Selection box slides (anchor issue)
3. **Mixed side:** Shapes slide (anchor issue), strokes translate correctly

---

**End of Changelog**
