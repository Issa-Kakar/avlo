# SelectTool Implementation Progress

## Current State (Session 4) - Critical Fixes + Documented Issues

**Branch:** `feature/select-tool`
**Date:** 2025-01-26
**Last Commit:** `fix: SelectTool dirty rect + WYSIWYG shape scaling`

---

### ✅ Completed This Session

#### 1. Dirty Rect Invalidation Fix (CRITICAL)
**File:** `client/src/lib/tools/SelectTool.ts`

**Bug:** Objects were disappearing during transform because:
- Spatial index has objects at ORIGINAL positions (Y.Map unchanged during preview)
- Subsequent moves only unioned `prevPreviewBounds + transformedBounds`
- Original bounds was NOT included after first move
- Spatial query couldn't find objects → they weren't drawn

**Fix:** ALWAYS include original bounds in dirty rect:
```typescript
// Union: original + current transformed + previous transformed
let unionBounds = union(bounds, transformedBounds);
if (prevPreviewBounds) {
  unionBounds = union(unionBounds, prevPreviewBounds);
}
```

#### 2. WYSIWYG Shape Scaling
**File:** `client/src/renderer/layers/objects.ts`

**Problem:** Using `ctx.scale()` scaled EVERYTHING including stroke width.

**Fix:** For shapes during transform:
1. Compute transformed frame mathematically (not canvas transform)
2. Build fresh Path2D from transformed frame
3. Draw with ORIGINAL stroke width (not scaled)

New functions:
- `applyTransformToFrame()` - Math-based frame transformation
- `buildShapePathFromFrame()` - Builds Path2D from explicit frame
- `drawShapeWithTransform()` - WYSIWYG shape rendering
- `drawTextWithTransform()` - WYSIWYG text rendering

#### 3. Side Handle Detection
**File:** `client/src/lib/tools/SelectTool.ts`

- `hitTestHandle()` now detects side edges (n, e, s, w) in addition to corners
- Appropriate cursors: `ns-resize`, `ew-resize`, `nwse-resize`, `nesw-resize`
- Side handles are NOT rendered - only cursor changes on hover

#### 4. Transform Commit to Y.Doc
**File:** `client/src/lib/tools/SelectTool.ts`

Implemented `commitTranslate()` and `commitScale()`:
- Strokes/Connectors: Always uniform scale (side handles use primary axis)
- Shapes/Text: Non-uniform scale allowed (directional with side handles)
- Handles negative scale (flip) with proper frame normalization

---

### 🔴 FUNDAMENTAL ISSUES (Next Session)

#### Issue 1: Selection Box Hit Testing is WRONG

**Current (Broken) Behavior:**
- To translate a selection, must precisely click ON an object within the selection
- Clicking empty space between selected objects clears selection
- This is wrong UX

**Expected Behavior:**
- Clicking ANYWHERE inside selection bounds should start translate
- Only clicking OUTSIDE selection bounds should clear/change selection

**Root Cause:**
- `begin()` does `hitTestObjects()` first, which returns null for empty space
- Then falls through to clear selection or start marquee
- Should check "are we inside selection bounds?" FIRST

**Required Fix:**
```typescript
begin(pointerId, worldX, worldY):
  // 1. Check handle hit (existing - works)
  // 2. NEW: Check if inside existing selection bounds
  const selectionBounds = computeSelectionBounds();
  if (selectionBounds && pointInsideBounds(worldX, worldY, selectionBounds)) {
    // Clicking inside selection = start translate (NOT hit test objects)
    this.phase = 'pendingClick';
    this.willTranslateOnDrag = true;
    return;
  }
  // 3. Then do object hit testing (for new selection)
  // 4. Then empty space = clear selection
```

#### Issue 2: Fill-Aware Hit Testing for Selection

**Current (Broken) Behavior:**
- Non-filled shapes are selectable by clicking inside their interior
- This prevents marquee selection inside unfilled shapes

**Expected Behavior:**
- Non-filled shapes: Only selectable by clicking near outline/stroke
- Filled shapes: Selectable by clicking anywhere inside
- This matches how EraserTool works

**Required Fix:**
- `shapeHitTestForSelection()` should respect fill state
- If NOT filled: only check edge hit test
- If filled: allow interior click

#### Issue 3: Scale Flip/Mirror is Broken

**Symptoms:**
- Dragging handle past origin doesn't properly flip/mirror
- Appears to have "minimum width/height" that prevents full flip
- Dirty rects get stale pixels during flip (ghosting)

**Suspected Causes:**
1. `computeScaleFactors()` might have sign issues at flip boundary
2. Dirty rect invalidation might not cover flip properly
3. Might need to track live cursor position in selection state

**Investigation Needed:**
- Compare with how PerfectShapePreview handles anchors + live cursor
- Perfect shapes have `anchors` (frozen) + `cursor` (live) model
- Selection transform might need similar explicit cursor tracking

**Questions:**
- Do we need live cursor in selection state during drag?
- Is the scale origin calculation correct at flip boundary?
- Are we computing transformed bounds correctly when scale is negative?

#### Issue 4: Instant Drag UX

**Current Behavior:**
- Single click to select, immediate drag to move
- Feels too twitchy/sensitive

**Suggested Improvement:**
- Small delay or threshold before drag mode activates
- Still allow quick select-and-drag, but make it feel more intentional

---

### Files Modified This Session

| File | Changes |
|------|---------|
| `SelectTool.ts` | Dirty rect fix, side handles, cursor logic, commit methods |
| `objects.ts` | WYSIWYG shape/text transform, per-object scaling |
| `selection-store.ts` | HandleId in ScaleTransform |
| `types.ts` | Extended HandleId type |
| `OverlayRenderLoop.ts` | Stroke highlighting uses bbox |

---

### Architecture Notes

#### Spatial Index During Transform
- Objects remain at ORIGINAL position in spatial index (Y.Map unchanged)
- Transform is purely visual (canvas transform or computed frame)
- Dirty rect MUST include original bounds for spatial query to find objects
- This is why objects disappeared - spatial query returned nothing

#### WYSIWYG vs Canvas Transform
- **Canvas transform (`ctx.scale`)**: Scales EVERYTHING including stroke width
- **WYSIWYG**: Compute new geometry, draw with original styling
- Shapes use WYSIWYG for proper stroke width preservation
- Strokes still use canvas transform (TODO: WYSIWYG for strokes later)

#### Selection State Model
Current:
```typescript
transform: { kind: 'scale', origin, scaleX, scaleY, handleId, originBounds }
```

Might need:
```typescript
transform: {
  kind: 'scale',
  origin,
  scaleX, scaleY,
  handleId,
  originBounds,
  liveCursor?: [number, number]  // For flip handling?
}
```

---

### Test Scenarios for Next Session

- [ ] Click inside selection bounds (on empty space) → should start translate
- [ ] Click outside selection bounds → should clear selection
- [ ] Click on unfilled shape interior → should NOT select (only outline)
- [ ] Marquee inside unfilled shape → should work
- [ ] Drag handle past origin → should flip cleanly without ghosting
- [ ] Scale strokes → should be uniform regardless of handle
- [ ] Scale shapes with side handle → should stretch directionally

---

## Previous Sessions Summary

### Session 3 - Scale Fix, Side Handles, Transform Commit
- Extended HandleId for side handles
- Fixed scale formula (was dividing by half width)
- Added per-object scale logic

### Session 2 - WYSIWYG Transform + Selection Highlighting
- Added selection highlighting on overlay
- Implemented WYSIWYG transform preview

### Session 1 - Critical Bug Fixes
- Fixed bbox format mismatch
- Fixed empty space click not clearing selection
- Fixed marquee center-point vs intersection

### Foundation
- Created selection-store.ts
- Created SelectTool.ts with state machine
- Hit testing with fill-awareness (for eraser)
