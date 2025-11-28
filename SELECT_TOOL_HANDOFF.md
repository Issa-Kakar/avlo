# SelectTool Scale Transform - Agent Handoff Document

**Created:** 2025-01-28
**Branch:** `feature/select-tool`
**Plan File:** `/home/issak/.claude/plans/snug-hopping-phoenix.md`
**Status:** Planning complete, ready for implementation

---

## Executive Summary

The SelectTool scale transform refactor is mostly complete (dirty rects work, WYSIWYG works), but there are 5 remaining UX issues that need to be fixed to achieve Miro-like behavior.

---

## Current Codebase State

### What's Working
- Dirty rect accumulating envelope (no more ghosting)
- `applyTransformToBounds()` normalization for negative scale
- `selectionKind` and `handleKind` in selection store
- PF-per-frame rendering for stroke scale preview
- Context-aware `commitScale()` with per-object dispatch
- Context-aware `renderSelectedObjectWithScaleTransform()` dispatch
- Translation transforms work perfectly

### What's Broken
1. **Shape geometry has artificial 10% minimum** - creates "pause" before flip
2. **Diagonal-only flip is too strict** - can't flip by going horizontally past selection edge
3. **Stroke translation doesn't edge-anchor** - all strokes slide, but edge strokes should stay fixed
4. **Multi-stroke side handles use wrong behavior** - should translate, not uniform scale
5. **Single-stroke shows side handles** - should hide them (corners only)
6. **Cursor incorrect for strokes-only** - shows axis cursor for side handles

---

## Critical Discovery: Shape Minimum Scale

### The Problem
In `SelectTool.ts` lines 636-639:
```typescript
// Apply minimum scale magnitude (0.1) but preserve sign for flip
const minScale = 0.1;
scaleX = Math.sign(scaleX || 1) * Math.max(minScale, Math.abs(scaleX));
scaleY = Math.sign(scaleY || 1) * Math.max(minScale, Math.abs(scaleY));
```

This creates an artificial floor at 10% size. When you try to compress a shape smaller than 10%, it "pauses" and won't shrink further until you cross the axis for a flip.

### How DrawingTool Does It (Correct)
In `perfect-shape-preview.ts` lines 98-102:
```typescript
const minX = Math.min(A[0], C[0]);
const minY = Math.min(A[1], C[1]);
const width = Math.abs(C[0] - A[0]);
const height = Math.abs(C[1] - A[1]);
if (width === 0 || height === 0) return; // Only skip at EXACTLY zero
```

**NO artificial minimum.** Shapes compress fluid to zero. The `Math.min/max` naturally handles axis flipping. This is the feel we need for SelectTool shapes.

### The Fix
- **For shapes:** Remove `minScale` entirely. Use raw scale factors.
- **For strokes:** Keep a tiny minimum (0.001) to prevent Perfect Freehand issues with zero-width strokes.

---

## Critical Discovery: Diagonal-Only Flip is Too Strict

### The Problem
In `SelectTool.ts` lines 1015-1022:
```typescript
private computeUniformScaleWithDiagonalFlip(scaleX: number, scaleY: number): number {
  const minScale = 0.05;
  const absMax = Math.max(Math.abs(scaleX), Math.abs(scaleY), minScale);

  // Diagonal flip: only when BOTH are negative
  const flipped = scaleX < 0 && scaleY < 0;
  return flipped ? -absMax : absMax;
}
```

The rule `scaleX < 0 && scaleY < 0` requires **BOTH** axes to be negative. This means:
- If you drag SE corner far to the LEFT (scaleX very negative), but stay BELOW the anchor (scaleY positive), it WON'T flip.
- You must go DIAGONALLY toward the opposite corner to trigger flip.

### Miro Behavior (User Observation)
The user described Miro's behavior in detail:

> "if you head to the left of the furthest selection bound y axis, and you cross it and keep going, still underneath but your cursor (NOT SELECTION BOUNDS, YOUR CURSOR), is past the top left corner by the selection box's size left to right, if you cross that point, then even if you aren't going above the top left corner with your cursor, it can still flip"

Translation: If you go 1× selection width past the origin on the X axis, X-axis flips, regardless of Y position.

### The Fix: Per-Axis Magnitude Threshold with Bidirectional Hysteresis

```typescript
private computeScaleWithMagnitudeFlip(
  rawScaleX: number,
  rawScaleY: number
): { scaleX: number; scaleY: number } {
  // Per-axis flip with magnitude threshold at 1.0
  const flipX = rawScaleX < 0 && Math.abs(rawScaleX) >= 1.0;
  const flipY = rawScaleY < 0 && Math.abs(rawScaleY) >= 1.0;

  let finalScaleX = rawScaleX;
  let finalScaleY = rawScaleY;

  // In hysteresis zone (-1 < scale < 0), snap to positive (no flip)
  if (rawScaleX < 0 && !flipX) {
    finalScaleX = Math.abs(rawScaleX);  // Snap to positive
  }
  if (rawScaleY < 0 && !flipY) {
    finalScaleY = Math.abs(rawScaleY);  // Snap to positive
  }

  return { scaleX: finalScaleX, scaleY: finalScaleY };
}
```

**Hysteresis behavior:**
- **Flip ON:** When |scale| >= 1.0 (cursor 1× selection size past origin)
- **Flip OFF:** When |scale| < 1.0 (cursor within 1× selection size of origin)

For **uniform scale** (strokes), both axes must flip for diagonal flip:
```typescript
const uniformMagnitude = Math.max(Math.abs(scaleX), Math.abs(scaleY));
const flipX = scaleX < 0 && Math.abs(scaleX) >= 1.0;
const flipY = scaleY < 0 && Math.abs(scaleY) >= 1.0;
const flipped = flipX && flipY;  // Both must cross for diagonal flip
const finalScale = flipped ? -uniformMagnitude : uniformMagnitude;
```

---

## Critical Discovery: Stroke Edge-Anchoring

### The Problem
Current stroke translation in `SelectTool.ts` lines 972-1008:
```typescript
// All strokes use simple relative position
const relX = bw > 0 ? (cx - originBounds.minX) / bw : 0.5;
const ncx = actMinX + relX * (actMaxX - actMinX);
```

ALL strokes slide proportionally. But Miro keeps **edge-defining strokes FIXED**.

### Miro Behavior (User Observation)
The user described complex behavior:

> "the strokes that are defining the selection boundaries, AND are the ones being dragged to, are not moving in the side handle translation, until you cross the edge handle and then it will swap"

Translation:
- Strokes whose bbox **defines/touches the anchor edge** stay FIXED in world space
- Middle strokes slide proportionally
- Strokes at the dragging edge move with that edge

### The Fix: Edge-Anchored Translation

```typescript
function computeStrokeTranslationWithEdgeAnchor(
  handle: ObjectHandle,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId
): { dx: number; dy: number } {
  const [bboxMinX, bboxMinY, bboxW, bboxH] = handle.bbox;
  const bboxMaxX = bboxMinX + bboxW;
  const bboxMaxY = bboxMinY + bboxH;
  const EPSILON = 0.5;  // Float tolerance

  const cx = (bboxMinX + bboxMaxX) / 2;
  const cy = (bboxMinY + bboxMaxY) / 2;

  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  // Check if stroke bbox DEFINES the anchor edge (opposite of dragged handle)
  const definesAnchorX = isSideH && (
    (handleId === 'w' && Math.abs(bboxMaxX - originBounds.maxX) < EPSILON) || // Anchor at E
    (handleId === 'e' && Math.abs(bboxMinX - originBounds.minX) < EPSILON)    // Anchor at W
  );
  const definesAnchorY = isSideV && (
    (handleId === 'n' && Math.abs(bboxMaxY - originBounds.maxY) < EPSILON) || // Anchor at S
    (handleId === 's' && Math.abs(bboxMinY - originBounds.minY) < EPSILON)    // Anchor at N
  );

  // Compute new bounds after scale
  const [ox, oy] = origin;
  const newMinX = ox + (originBounds.minX - ox) * scaleX;
  const newMaxX = ox + (originBounds.maxX - ox) * scaleX;
  const actMinX = Math.min(newMinX, newMaxX);
  const actMaxX = Math.max(newMinX, newMaxX);
  // Same for Y...

  // Compute relative position
  const bw = originBounds.maxX - originBounds.minX;
  const relX = bw > 0 ? (cx - originBounds.minX) / bw : 0.5;

  let ncx = cx, ncy = cy;

  if (isSideH) {
    if (definesAnchorX) {
      ncx = cx;  // FIXED - stay at original world position
    } else {
      ncx = actMinX + relX * (actMaxX - actMinX);  // Proportional slide
    }
    ncy = cy;  // Y unchanged for horizontal side
  }

  // Same logic for isSideV...

  return { dx: ncx - cx, dy: ncy - cy };
}
```

### Critical: Anchor Edge SWAPS on Flip

When the selection flips (scale goes negative), the anchor and drag edges swap roles. This is essential for correct behavior.

**Example: S-stroke at left edge, dragging W handle right**

```
Pre-flip (scaleX > 0):
- Dragging edge: LEFT (where S is) → S MOVES with drag
- Anchor edge: RIGHT → strokes here stay FIXED
- S slides toward the origin (right edge)

At flip (scaleX crosses 0 → negative):
- S has slid all the way to the origin position
- Edges swap roles!

Post-flip (scaleX < 0):
- Anchor edge: now LEFT (original) → S is here (at origin) → S becomes FIXED
- Dragging edge: now RIGHT (original) → this edge moves
- S stays fixed at origin while selection grows on other side
```

**The proportional math handles this naturally:**
- S has `relX ≈ 0` (was at original left edge)
- After flip: `newCx = actMinX + 0 * width = actMinX = origin`
- S stays at origin regardless of further scaling (because `relX=0` maps to `actMinX`)

**Edge-anchor DETECTION must account for flip:**

```typescript
// The anchor edge definition flips with the scale sign
const isFlippedX = scaleX < 0;

// For W handle:
// - Normal (scaleX >= 0): anchor is at originBounds.maxX (right)
// - Flipped (scaleX < 0): anchor is at originBounds.minX (left)
let anchorEdgeX: number;
if (handleId === 'w') {
  anchorEdgeX = isFlippedX ? originBounds.minX : originBounds.maxX;
} else if (handleId === 'e') {
  anchorEdgeX = isFlippedX ? originBounds.maxX : originBounds.minX;
}

// Check if stroke bbox touches the CURRENT anchor edge
const definesAnchorX = Math.abs(bboxMinX - anchorEdgeX) < EPSILON ||
                       Math.abs(bboxMaxX - anchorEdgeX) < EPSILON;
```

This ensures strokes that end up at the origin after flip are correctly frozen there.

---

## Critical Discovery: Single-Stroke & Strokes-Only Side Handles

### Clarification
Side handles should **behave like corner handles** for strokes-only selections (not be hidden). This means:
- Side handles are still visible and interactive
- They perform **uniform scale** (same as corners)
- The **cursor is diagonal** (not axis-based), computed dynamically based on cursor position relative to handle midpoint

### Dynamic Diagonal Cursor Logic
For strokes-only side handles, compute cursor based on which "quadrant" of the handle the cursor is in:

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
    case 'e':  // Right edge - cursor above or below midpoint?
      return worldY < midY ? 'nesw-resize' : 'nwse-resize';
    case 'w':  // Left edge
      return worldY < midY ? 'nwse-resize' : 'nesw-resize';
    case 'n':  // Top edge - cursor left or right of midpoint?
      return worldX < midX ? 'nwse-resize' : 'nesw-resize';
    case 's':  // Bottom edge
      return worldX < midX ? 'nesw-resize' : 'nwse-resize';
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    default: return 'default';
  }
}
```

### Why This Works
- Hovering East handle above midpoint → acts like NE corner → `nesw-resize`
- Hovering East handle below midpoint → acts like SE corner → `nwse-resize`
- The uniform scale behavior is the same regardless - only cursor feedback changes

---

## Updated Behavior Matrix

| Selection | Handle | Count | Object | Scale Type | Stroke Width | Flip Rule | Min Scale |
|-----------|--------|-------|--------|------------|--------------|-----------|-----------|
| shapesOnly | corner | any | shape | Non-uniform | Constant | Per-axis (\|s\|≥1) | **NONE** |
| shapesOnly | side | any | shape | Single-axis | Constant | Per-axis (\|s\|≥1) | **NONE** |
| strokesOnly | corner | any | stroke | Uniform | Scales | Per-axis (\|s\|≥1) | 0.001 |
| strokesOnly | side | 1 | stroke | **Uniform (corner-like)** | Scales | Per-axis (\|s\|≥1) | 0.001 |
| strokesOnly | side | >1 | stroke | **TRANSLATE (edge-anchored)** | Unchanged | Any direction | N/A |
| mixed | corner | any | shape | **Uniform** | Constant | Per-axis (\|s\|≥1) | **NONE** |
| mixed | corner | any | stroke | Uniform | Scales | Per-axis (\|s\|≥1) | 0.001 |
| mixed | side | any | shape | Single-axis | Constant | Per-axis (\|s\|≥1) | **NONE** |
| mixed | side | any | stroke | **TRANSLATE (edge-anchored)** | Unchanged | Any direction | N/A |

---

## Implementation Order

### Phase 1: Shape Fluid Scaling (Highest Impact)
**Files:** `SelectTool.ts`, `objects.ts`

1. Remove `minScale = 0.1` from `computeScaleFactors` (lines 636-639)
2. Update shape commit logic to use `Math.min/max` on frame corners
3. Update shape preview rendering in `objects.ts` to match
4. Keep stroke minimum very small (0.001) in uniform scale computation
5. **Test:** Shapes compress smoothly to zero, flip at axis crossing

### Phase 2: Per-Axis Flip with Magnitude Threshold
**Files:** `SelectTool.ts`, `objects.ts`

1. Rename/rewrite `computeUniformScaleWithDiagonalFlip` to `computeUniformScaleWithFlip`
2. Add per-axis magnitude check: `flipX = scaleX < 0 && |scaleX| >= 1.0`
3. For uniform scale: flip triggers when BOTH axes cross threshold
4. Add `computeScaleWithMagnitudeFlip()` for shapes (per-axis independent)
5. Update rendering in `objects.ts` to match
6. **Test:** Hysteresis zone works, flip feels natural

### Phase 3: Strokes-Only Side Handles Act Like Corners
**Files:** `SelectTool.ts`

1. Add `getHandleCursorForStrokes(handle, worldX, worldY)` function
2. Update `updateHoverCursor` to use dynamic diagonal cursor for strokesOnly side handles
3. Ensure side handles use uniform scale (same path as corners) for strokesOnly
4. For single-stroke: uniform scale with corner-like behavior
5. For multi-stroke: will be handled in Phase 4 (translate)
6. **Test:** Side handles show diagonal cursor based on cursor position relative to midpoint

### Phase 4: Edge-Anchored Stroke Translation
**Files:** `SelectTool.ts`, `objects.ts`

1. Add `computeStrokeTranslationWithEdgeAnchor()` function
2. Replace `computeStrokeTranslation` for mixed+side+stroke
3. Apply to strokesOnly+side (only triggers for multi-stroke now since side handles hidden for single)
4. Update rendering in `objects.ts` to match
5. **Test:** Edge strokes stay fixed, middle strokes slide

### Phase 5: Cursor Fixes
**Files:** `SelectTool.ts`

1. Update `getHandleCursor` logic based on handle visibility
2. No cursor for hidden handles
3. **Test:** Cursor matches visible handles

---

## Critical Files Reference

| File | Line Numbers | What's There |
|------|--------------|--------------|
| `client/src/lib/tools/SelectTool.ts:636-639` | minScale = 0.1 problem |
| `client/src/lib/tools/SelectTool.ts:1015-1022` | Diagonal-only flip rule |
| `client/src/lib/tools/SelectTool.ts:972-1008` | Stroke translation (needs edge-anchor) |
| `client/src/lib/tools/SelectTool.ts:663-671` | Cursor logic |
| `client/src/renderer/layers/objects.ts:544-549` | Render-side uniform scale |
| `client/src/renderer/layers/objects.ts:507-538` | Render-side stroke translation |
| `client/src/renderer/layers/perfect-shape-preview.ts:98-102` | DrawingTool approach (reference) |

---

## Test Scenarios Checklist

### Shape Fluid Scaling
- [ ] Shape can compress to 0 width/height (no pause at 10%)
- [ ] Shape flips smoothly when crossing axis
- [ ] Feels identical to DrawingTool shape preview
- [ ] Commit works with 0 width or 0 height

### Per-Axis Flip (Uniform Scale)
- [ ] Drag SE corner far left (past origin by 1× width) → X flip triggers
- [ ] Drag SE corner far up (past origin by 1× height) → Y flip triggers
- [ ] Both must cross for diagonal flip (strokes preserve aspect ratio)
- [ ] Return to within 1× of origin → unflips (hysteresis works)
- [ ] Shrinking feels natural - moving ANY direction from corner affects scale

### Strokes-Only Side Handles (Corner-Like Behavior)
- [ ] Side handles visible and interactive
- [ ] Side handles perform uniform scale (same as corners)
- [ ] Cursor is diagonal, not axis-based
- [ ] Cursor direction changes based on cursor position relative to selection midpoint
- [ ] E handle: above midpoint → nesw-resize, below → nwse-resize
- [ ] Single-stroke + side handle = uniform scale with width scaling

### Multi-Stroke Side Handles (Edge-Anchored Translation)
- [ ] Strokes at anchor edge stay FIXED in world space
- [ ] Middle strokes slide proportionally
- [ ] Works for both mixed+side and strokesOnly+side (multi)
- [ ] On axis flip, strokes reposition correctly

### Cursor
- [ ] Cursor matches visible handles
- [ ] No cursor shown for hidden handles

---

## Previous Documentation

- `SELECT_TOOL_SCALE_REFACTOR.md` - Original refactor plan (mostly complete)
- `PREVIOUS_PLAN.md` - Previous agent's conversation about Miro UX
- `SELECT_TOOL_COMPREHENSIVE.md` - May contain additional context

---

## Key Insights Summary

1. **DrawingTool is the reference** - Its `perfect-shape-preview.ts` has the correct fluid geometry transformation. Use `Math.min/max`, no artificial minimum.

2. **Flip is per-axis with magnitude threshold** - The 1.0 threshold means "cursor must travel 1× selection width past origin to flip that axis."

3. **Edge-anchoring uses bbox-defines-bounds** - A stroke is "at the anchor edge" if its bbox literally touches that edge of selection bounds (within EPSILON tolerance).

4. **Single-stroke hides side handles** - User explicitly chose this. Simpler UI.

5. **The goal is Miro-like UX** - Fluid, natural, predictable scaling behavior.

---

**End of Handoff Document**
