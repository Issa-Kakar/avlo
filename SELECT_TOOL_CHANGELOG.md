# SelectTool Scale Transform - Changelog & Current State

**Date:** 2025-01-29
**Branch:** `feature/select-tool`
**Last Commit:** `5feed7f` - feat: non-anchor stroke flip shift for mixed+side transforms
**Current Phase:** Phase 7 - Geometry Extraction Refactor (COMPLETED)

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

## Current Behavior Summary (After Phase 6)

### Corner Handle Scaling

| Selection Type | Behavior | Status |
|----------------|----------|--------|
| **Strokes-only** | Uniform scale, no geometry inversion, position preserved | ✅ Perfect |
| **Mixed (strokes + shapes)** | Uniform scale, no geometry inversion, position preserved | ✅ Perfect |
| **Shapes-only** | Non-uniform scale (independent X/Y), corner-based, anchor fixed | ✅ Fixed |

### Side Handle Scaling

| Selection Type | Behavior | Status |
|----------------|----------|--------|
| **Strokes-only** | Resize with snapping | ⚠️ Has snapping behavior |
| **Mixed** | Shapes scale, anchor strokes edge-pin, non-anchor strokes flip-shift | ✅ Perfect |
| **Shapes-only** | Non-uniform scale (one axis), anchor fixed | ✅ Fixed |

---

## Known Issues / Future Work

### 1. Strokes-Only Side Handle Resize
**Current:** Has awkward "snapping" behavior
**Desired:** Normal resize behavior with flip support and preserved position
**Approach:** Apply same pattern as corner handles - use preserved position (already does, but needs to remove threshold snapping)

---

## Phase 4: Anchor Sliding Fix (IMPLEMENTED)

**Date:** 2025-01-29

### The Problem

Anchor sliding was caused by **two coordinate space mismatches**:
1. **Transform bounds** computed from padded bboxes (`strokeWidth * 0.5 + 1`)
2. **Stroke translation** (mixed+side) used bbox center, not geometry center

**Example (before fix):**
```
Shape frame: [100, 100, 50, 50]  (left edge at x=100)
Stroke width: 10 → Padding: 6
BBox: [94, 94, 156, 156]  (left edge at x=94)

Origin for E handle = [94, midY]  ← from padded bbox
Transform: newX = 94 + (100 - 94) * 1.5 = 103  ← frame moves!

RESULT: Left edge slides from 100 → 103 (3px drift)
```

### The Solution

Implemented **geometry-based transform bounds** + **geometry-based stroke centers**:

1. **Added `computeTransformBoundsForScale()`** - computes raw geometry bounds:
   - Shapes/text: raw frame [x, y, w, h]
   - Strokes/connectors: raw points min/max (no width inflation)

2. **Updated `ScaleTransform` interface** to store both:
   - `originBounds` - geometry-based (for position math)
   - `bboxBounds` - padded (for dirty rect invalidation)

3. **Updated `computeStrokeTranslation()`** to use geometry center:
   - When stroke at x=0, origin at x=0 → `dx = 0` (no movement!)
   - Anchor strokes stay pinned, non-anchor strokes translate proportionally

### Why This Works

When both origin AND stroke center come from raw geometry:
```
Stroke at x=0, width=10
Geometry bounds: minX = 0, maxX = 0
Geometry center: cx = 0
Origin for E handle: ox = 0 (from geometry bounds)

newCx = 0 + (0 - 0) * 0.75 = 0
dx = 0  ← stroke stays pinned!
```

### Files Modified

| File | Changes |
|------|---------|
| `SelectTool.ts` | Added `computeTransformBoundsForScale()` helper |
| `SelectTool.ts` | Updated scale initiation to use geometry bounds for origin |
| `SelectTool.ts` | Updated `computeStrokeTranslation()` to use geometry center |
| `SelectTool.ts` | Updated `getPreview()` to use originBounds during scale |
| `SelectTool.ts` | Updated `invalidateTransformPreview()` to use bboxBounds |
| `selection-store.ts` | Added `bboxBounds` to ScaleTransform interface |
| `selection-store.ts` | Updated `beginScale()` to accept both bounds types |
| `objects.ts` | Updated `computeStrokeTranslationForRender()` to use geometry center |

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

## Phase 5: Anchor Stroke Edge-Pinning (IMPLEMENTED)

**Date:** 2025-01-29

### The Problem

After Phase 4 fixed shapes-only anchor sliding with geometry-based bounds, mixed selection + side handle transforms still had issues:
- Anchor strokes (strokes that define the anchor edge) were translating when they should stay pinned
- On scale flip (negative scale), anchor strokes should shift to define the opposite edge, then stay pinned again

**Desired behavior:**
- Pre-flip (scale >= 0): Anchor stroke stays pinned (dx ≈ 0)
- At flip (scale crosses 0): Anchor stroke shifts by its width to define the opposite edge
- Post-flip (scale < 0): Anchor stroke stays pinned again on the new edge

### The Solution

Replaced center-based stroke translation with edge-pinning logic:

1. **Detect anchor strokes** - Check if stroke geometry touches the anchor line (within epsilon)
2. **Pre-flip behavior** - Pin the edge that originally touched the anchor
3. **Post-flip behavior** - Pin the opposite edge (shift by stroke width)
4. **Interior strokes** - Continue using origin-based translation

**Key Logic:**
```typescript
if (isAnchor) {
  if (scaleX >= 0) {
    // Pre-flip: pin original touching edge
    const edgeX = touchesLeft ? minX : maxX;
    dx = anchorX - edgeX; // ≈ 0 since edge ≈ anchor
  } else {
    // Post-flip: pin opposite edge (shift by stroke width)
    const edgeX = touchesLeft ? maxX : minX;
    dx = anchorX - edgeX;
  }
} else {
  // Interior stroke → origin-based translation
  const newCx = ox + (cx - ox) * scaleX;
  dx = newCx - cx;
}
```

### Files Modified

| File | Changes |
|------|---------|
| `SelectTool.ts` | Updated `computeStrokeTranslation()` with edge-pinning logic, added `handleId` parameter |
| `objects.ts` | Updated `computeStrokeTranslationForRender()` with same edge-pinning logic, added `HandleId` import |

---

## Phase 6: Non-Anchor Stroke Flip Shift (COMMITTED - 5feed7f)

**Date:** 2025-01-29

### The Problem

After Phase 5 fixed anchor stroke edge-pinning, non-anchor strokes (strokes NOT touching the anchor edge) had inconsistent flip behavior:
- Anchor strokes jumped discretely at flip (shifted by their width)
- Non-anchor strokes moved continuously through the flip (no jump)
- This created a visual disconnect where anchor strokes "snapped" but non-anchor strokes didn't

**Mental Model:**
Non-anchor strokes are conceptually "anchored to the moving handle". When the moving handle crosses the anchor and flips to the other side, non-anchor strokes should also flip.

### The Solution

At the flip point (scale < 0), non-anchor strokes shift by **half their width** in the **opposite direction** of anchor strokes:

| Handle | Anchor Stroke Shift | Non-Anchor Stroke Shift |
|--------|---------------------|-------------------------|
| W | RIGHT (+width) | LEFT (-halfWidth) |
| E | LEFT (-width) | RIGHT (+halfWidth) |
| S | UP (-height) | DOWN (+halfHeight) |
| N | DOWN (+height) | UP (-halfHeight) |

**Why half width?**
At scale=0, the stroke center is at the anchor. The stroke spans `[anchor - width/2, anchor + width/2]`. The amount that has "crossed" the anchor is exactly half the stroke width.

**Key Logic:**
```typescript
} else {
  // Non-anchor stroke: origin-based translation + shift at flip
  const newCx = ox + (cx - ox) * scaleX;
  dx = newCx - cx;

  // At flip (scaleX < 0), shift by half stroke width (OPPOSITE direction of anchor strokes)
  if (scaleX < 0) {
    const halfWidth = (maxX - minX) / 2;
    // W handle: anchor shifts RIGHT, so non-anchor shifts LEFT (-)
    // E handle: anchor shifts LEFT, so non-anchor shifts RIGHT (+)
    dx += handleId === 'w' ? -halfWidth : halfWidth;
  }
  dy = 0;
}
```

### Resulting Behavior

- **Pre-flip:** Non-anchor strokes move toward the anchor (continuous origin-based translation)
- **At flip:** Non-anchor strokes jump by halfWidth to the opposite side of the anchor
- **Post-flip:** Non-anchor strokes continue moving away from the anchor (same direction as before)

This creates the "flip but keep going" behavior where all strokes (anchor and non-anchor) snap at the same moment, then continue in their original direction.

### Files Modified

| File | Changes |
|------|---------|
| `SelectTool.ts` | Updated `computeStrokeTranslation()` to add halfWidth shift for non-anchor strokes at flip |
| `objects.ts` | Updated `computeStrokeTranslationForRender()` with same halfWidth shift logic |

---

## Phase 7: Pragmatic Refactor - Geometry Extraction (COMPLETED)

**Date:** 2025-01-29

### The Problem

SelectTool.ts grew to ~2033 lines with duplicated geometry functions across:
- SelectTool.ts and objects.ts (scale math: ~320 lines duplicated)
- SelectTool.ts and EraserTool.ts (hit testing: ~70 lines duplicated)
- Dead code (unused functions: ~90 lines)

### The Solution

Extract pure functions into two new shared modules:

1. **`@/lib/geometry/scale-transform.ts`** (~206 lines)
   - `computeUniformScaleNoThreshold()` - uniform scale with immediate flip
   - `computePreservedPosition()` - maintains relative position in selection box
   - `computeStrokeTranslation()` - edge-pinning logic for mixed+side transforms

2. **`@/lib/geometry/hit-test-primitives.ts`** (~298 lines)
   - `pointToSegmentDistance()` - distance from point to line segment
   - `pointInRect()`, `pointInWorldRect()`, `pointInDiamond()` - point containment
   - `strokeHitTest()` - polyline proximity test
   - `circleRectIntersect()` - circle-rect intersection (for eraser)
   - `rectsIntersect()`, `segmentsIntersect()`, `segmentIntersectsRect()` - intersection tests
   - `polylineIntersectsRect()`, `ellipseIntersectsRect()`, `diamondIntersectsRect()` - geometry intersection tests
   - `computePolylineArea()` - bounding box area for selection priority

### Files Modified

| File | Status | Changes |
|------|--------|---------|
| `scale-transform.ts` | ✅ CREATED | New shared module for scale math |
| `hit-test-primitives.ts` | ✅ CREATED | New shared module for hit testing primitives |
| `objects.ts` | ✅ UPDATED | Uses imports from scale-transform.ts, removed debug logging |
| `SelectTool.ts` | ✅ UPDATED | Uses imports from both modules |
| `EraserTool.ts` | ✅ UPDATED | Uses imports from hit-test-primitives.ts, deleted ~55 lines |

### Outcomes

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| SelectTool.ts | ~1586 lines | ~1586 lines | (already extracted in prior sessions) |
| objects.ts | ~774 lines | ~765 lines | ~9 lines (debug logging removed) |
| EraserTool.ts | ~465 lines | ~384 lines | ~81 lines |

### Changes Made This Session

1. ✅ Updated EraserTool.ts to import from hit-test-primitives.ts
2. ✅ Deleted duplicated `strokeHitTest`, `pointToSegmentDistance`, `circleRectIntersect` from EraserTool.ts
3. ✅ Updated remaining method calls from `this.function()` to imported `function()`
4. ✅ Removed debug console.log and unused counter variables from objects.ts
5. ✅ Typecheck passes (pre-existing errors only, no new regressions)

---

## Quick Test Scenarios

### Corner Handles - Uniform Scale
1. **Two strokes diagonal:** Flip → positions preserved, geometry not inverted ✓
2. **Mixed stroke + shape:** Flip → positions preserved, geometry not inverted ✓
3. **Single stroke:** Flip → works correctly (t=0.5, 0.5 stays centered) ✓
4. **Shrink without flip:** Normal scaling unchanged ✓

### Corner Handles - Non-Uniform Scale (After Phase 4 Fix)
1. **Shapes-only corner:** Opposite corner stays fixed ✓
2. **Shape with thick stroke (20px):** No sliding despite large padding ✓

### Side Handles (After Phase 6 Fix)
1. **Strokes-only side:** Has snapping behavior (future improvement)
2. **Shapes-only side:** Opposite edge stays fixed ✓
3. **Mixed side anchor strokes:** Stay pinned pre-flip, jump by width at flip, stay pinned post-flip ✓
4. **Mixed side non-anchor strokes:** Translate toward anchor, jump by halfWidth at flip, continue away from anchor ✓
5. **Mixed side flip consistency:** All strokes snap at the same moment, then continue in original direction ✓

---

**End of Changelog**
