# SelectTool Scale Transform - Changelog & Current State

**Date:** 2025-01-29
**Branch:** `feature/select-tool`
**Last Commit:** `a3966c9` - fix: remove dead zone flip + add proper diagonal/side handle flip logic

---

## Session Summary

This session focused on fixing scale transform flip behavior for the SelectTool. Two main phases of work were completed.

---

## Phase 1: Dead Zone Fix (COMMITTED)

### Problem
The `applyFlipDeadZone()` function was corrupting ALL scale values before any context-aware logic could run. This caused:
- Shapes to "bounce back" instead of flipping when dragged past origin
- Side handles to require dragging to -1.0 threshold when they should flip immediately
- Diagonal corner drags to never trigger flip (both negative scales bounced to positive)

### Solution (Commit a3966c9)
1. **Removed dead zone** from `computeScaleFactors()` - raw scales pass through
2. **Deleted `applyFlipDeadZone()` method** entirely
3. **Rewrote `computeUniformScaleWithDiagonalFlip()`** with proper flip rules:
   - Both negative (diagonal past origin): immediate flip
   - Side handles (direct axis): immediate flip when < 0
   - Sideways corner drag: keeps -1.0 threshold

### Behavior After Phase 1

| Selection | Handle | Flip Trigger |
|-----------|--------|--------------|
| **Shapes-only** | Corner | scale < 0 (immediate) |
| **Shapes-only** | Side | scale < 0 (immediate) |
| **Strokes/Mixed** | Corner (diagonal) | Both < 0 (immediate) |
| **Strokes/Mixed** | Corner (sideways) | dominant <= -1.0 |
| **Strokes/Mixed** | Side | scale < 0 (immediate) |

---

## Phase 2: Copy-Paste Flip Behavior (UNCOMMITTED)

### Goal
Implement Figma-style "copy-paste" flip behavior for strokes:
- Stroke geometry should NEVER invert/mirror when flipping
- Position should SNAP to quadrants (uniform scale for position)
- Remove the -1.0 threshold entirely for immediate flipping

### Changes Made (Uncommitted)

**New function: `computeUniformScaleNoThreshold()`**
- Returns signed magnitude with NO threshold
- Immediate flip when dominant axis < 0

**Modified stroke scaling logic:**
```typescript
// Position uses uniform scale (SNAPS to quadrant)
const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
const newCx = ox + (cx - ox) * uniformScale;
const newCy = oy + (cy - oy) * uniformScale;

// Geometry uses absolute scale (NO inversion)
const absScale = Math.abs(uniformScale);
const newPoints = points.map(([x, y]) => [
  newCx + (x - cx) * absScale,
  newCy + (y - cy) * absScale,
]);
```

### Current Behavior (Uncommitted State)

**What's working:**
- ✅ Stroke geometry is NOT inverted when flipping (copy-paste visual)
- ✅ No threshold - immediate flip when dominant axis < 0
- ✅ Corner handles work perfectly for diagonal flipping

**What's NOT working / Needs tweaking:**
- ❌ Position is REVERSED when flipping (object on left goes to right and vice versa)
- ❌ Corner handles still only allow diagonal flip (not 4-quadrant)
- ❌ Side handle behavior for strokes-only needs redesign

---

## Current Scale Functions

### `computeUniformScaleNoThreshold()` (strokes - uncommitted)
Used for stroke scaling. No threshold, immediate flip.
```
Both negative → -magnitude
Side handle + axis < 0 → -magnitude
Corner + dominant < 0 → -magnitude
Else → +magnitude
```

### `computeUniformScaleWithDiagonalFlip()` (mixed/shapes - committed)
Used for mixed selections. Has -1.0 threshold for sideways drags.
```
Both negative → -magnitude (immediate)
Side handle + axis < 0 → -magnitude (immediate)
Corner sideways + dominant <= -1.0 → -magnitude (threshold)
Else → +magnitude
```

---

## Files Modified

| File | Function | Status |
|------|----------|--------|
| `SelectTool.ts` | `computeScaleFactors()` | Committed (dead zone removed) |
| `SelectTool.ts` | `applyFlipDeadZone()` | Committed (deleted) |
| `SelectTool.ts` | `computeUniformScaleWithDiagonalFlip()` | Committed (both-negative + side handle fixes) |
| `SelectTool.ts` | `computeUniformScaleNoThreshold()` | **Uncommitted** (new function) |
| `SelectTool.ts` | `commitScale()` stroke case | **Uncommitted** (copy-paste behavior) |
| `SelectTool.ts` | `invalidateTransformPreview()` stroke case | **Uncommitted** (copy-paste behavior) |
| `objects.ts` | `computeUniformScaleForRender()` | Committed (both-negative + side handle fixes) |
| `objects.ts` | `computeUniformScaleNoThreshold()` | **Uncommitted** (new function) |
| `objects.ts` | `drawScaledStrokePreview()` | **Uncommitted** (copy-paste behavior) |

---

## Desired Tweaks (Next Session)

### 1. Position Reversal Issue
**Current:** When flipping, stroke position reverses (left→right, top→bottom)
**Desired:** Stroke should stay in roughly same position, just scale without position flip

**Potential approach:** Instead of using `uniformScale` for position, explore:
- Keep position based on cursor (scaleX/scaleY) but clamp to positive?
- Or compute position differently when scale is negative?

### 2. Four-Quadrant Flipping
**Current:** Corner handles only flip diagonally (both axes flip together)
**Desired:** Ability to flip to any of 4 quadrants independently

**Potential approach:** Use per-axis sign for position, but uniform magnitude for geometry?

### 3. Strokes-Only Side Handle Behavior
**Options to explore:**
1. Same as mixed (translate-only, no scaling) but require 2+ strokes selected
2. Original resize behavior but without awkward snapping
3. Corner-cursor-style behavior (approximate opposite corner based on hover position)

### 4. Threshold Tuning
**Current state:**
- `computeUniformScaleNoThreshold()` - NO threshold (immediate flip)
- `computeUniformScaleWithDiagonalFlip()` - has -1.0 threshold for sideways

**May need:** Fine-tuning of when to use which, or unifying behavior

---

## Code Locations Reference

```
SelectTool.ts:
  - computeScaleFactors(): ~line 592
  - computeUniformScaleNoThreshold(): ~line 1022
  - computeUniformScaleWithDiagonalFlip(): ~line 1054
  - commitScale() stroke case: ~line 892
  - invalidateTransformPreview() stroke case: ~line 729

objects.ts:
  - computeUniformScaleNoThreshold(): ~line 588
  - computeUniformScaleForRender(): ~line 539
  - drawScaledStrokePreview(): ~line 612
```

---

## Decision: Commit or Revert?

The uncommitted changes implement copy-paste (no inversion) but with position reversal. Options:

1. **Commit as-is** - Position reversal is a known issue to fix later
2. **Revert to Phase 1** - Keep just the dead zone fix, discard copy-paste attempt
3. **Further iteration** - Fix position reversal before committing

User preference: Stop here, document state, iterate in next session.

---

## Quick Test Scenarios

### Shape-only (should work perfectly)
1. Select single shape → drag corner past opposite corner → smooth flip ✓
2. Select single shape → drag side handle past opposite edge → smooth flip ✓

### Stroke-only (has position reversal issue)
1. Select single stroke → drag corner diagonally → flips but position reverses
2. Select single stroke → drag side handle → flips but position reverses

### Mixed (uses different code path)
1. Select shape + stroke → corner drag → uniform scale with -1.0 threshold for sideways
2. Select shape + stroke → side drag → stroke translates, shape scales

---

**End of Changelog**
