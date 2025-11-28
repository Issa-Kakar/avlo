# SelectTool Scale Transform - Agent Handoff V2

**Created:** 2025-01-28
**Branch:** `feature/select-tool`
**Status:** Partially implemented, critical bugs identified

---

## Current State Summary

We attempted to fix three issues with SelectTool scale transforms:
1. Stroke translation using wrong math (FIXED - works well)
2. Shape minimum scale (ATTEMPTED - caused new bugs)
3. Diagonal-only flip too restrictive (ATTEMPTED - caused new bugs)

**What IS working (preserve this):**
- Mixed selection + corner handles: Per-axis sideways flip logic is GOOD
- Mixed selection + side handles + strokes: Translation with origin-based math works perfectly
- The threshold concept for sideways corner drags is correct

**What's broken:**
- Dead zone causing "bounce-back" on ALL scale types (shapes, strokes, mixed)
- Corner handles missing "both negative = immediate diagonal flip" rule
- Stroke-only selections inherit same bugs (same code path)

---

## Root Cause Analysis

### THE SINGLE ROOT CAUSE: Dead Zone Applied Too Early

In `computeScaleFactors()` (SelectTool.ts ~line 636-639), we added:
```typescript
scaleX = this.applyFlipDeadZone(scaleX);
scaleY = this.applyFlipDeadZone(scaleY);
```

Where `applyFlipDeadZone` converts scales in (-1, 0) to POSITIVE:
```typescript
if (scale >= 0) return scale;
if (scale > -1) return -scale;  // CORRUPTS THE SCALE!
return scale;
```

**This is applied BEFORE scales reach any other function.** The corruption propagates everywhere:

| Code Path | What Receives | Result |
|-----------|---------------|--------|
| Shapes (non-uniform) | Positive "bounced" scales | Bounce-back instead of flip |
| `computeUniformScaleWithDiagonalFlip()` | Positive scales | "Both negative" rule never triggers |
| Side handles | Bounced active axis | Bounce-back |
| Stroke-only selections | Same corrupt scales | Same bugs |

**Example trace:**
1. User drags corner diagonally past origin
2. Raw scales: scaleX = -0.5, scaleY = -0.5
3. After dead zone: scaleX = +0.5, scaleY = +0.5 (BOUNCED!)
4. Uniform scale sees: both positive → no flip
5. Shape rendering sees: both positive → shape grows back

### Secondary Issue: Missing "Both Negative" Rule

Even WITHOUT the dead zone, `computeUniformScaleWithDiagonalFlip()` currently lacks the rule:
```typescript
// MISSING: if (scaleX < 0 && scaleY < 0) return -magnitude;
```

Instead it only checks `activeScale <= -1.0`, which is for SIDEWAYS drags only.

### What's NOT a Bug (Don't Change)

The per-axis threshold logic for SIDEWAYS corner drags IS correct:
- When you drag a corner handle sideways (e.g., primarily left when you should go diagonally)
- One axis goes very negative, the other stays positive or small
- The threshold (-1.0) determines when to flip
- **This behavior is working well for mixed selections**

---

## The User's Insight on Diagonal Behavior

For a corner handle, the resize direction is along a diagonal (NW/SE or NE/SW).

**For NW corner (top-left) with NW/SE resize direction:**
- Drag NW → scale up
- Drag SE → scale down (and flip if past origin)
- Drag NE (perpendicular) → **dominant axis decides**:
  - More N than E → N dominates → scale up
  - More E than N → E dominates → scale down
- Drag SW (perpendicular) → same logic

**Key insight:** If you drag EXACTLY perpendicular (45° to the resize diagonal), human micro-movements will make it "wobble" slightly up and down. This is expected!

---

## Proposed Fix

### Step 1: Remove Dead Zone from computeScaleFactors()

**File:** `SelectTool.ts` around line 636

**Change from:**
```typescript
scaleX = this.applyFlipDeadZone(scaleX);
scaleY = this.applyFlipDeadZone(scaleY);
```

**To:**
```typescript
// Raw scales pass through - no dead zone
// Shapes: Math.min/max normalization handles negative scales
// Strokes: uniform scale function handles flip logic
```

Also **DELETE** the `applyFlipDeadZone()` helper method entirely.

### Step 2: Add "Both Negative" Rule to computeUniformScaleWithDiagonalFlip()

**File:** `SelectTool.ts` around line 1012

**Add this rule BEFORE the existing logic:**
```typescript
private computeUniformScaleWithDiagonalFlip(scaleX: number, scaleY: number): number {
  const absX = Math.abs(scaleX);
  const absY = Math.abs(scaleY);
  const STROKE_MIN = 0.001;

  // ============================================
  // CORNER HANDLES: Check "both negative" FIRST
  // ============================================
  // If BOTH axes are negative, user is dragging diagonally toward flip
  // → Flip IMMEDIATELY, no threshold needed
  if (scaleX < 0 && scaleY < 0) {
    const magnitude = Math.max(absX, absY, STROKE_MIN);
    return -magnitude;
  }

  // ============================================
  // SIDE HANDLES: One axis is fixed at 1
  // ============================================
  // (Keep existing side handle logic - this is working)
  if (scaleY === 1 && scaleX !== 1) {
    const magnitude = Math.max(absX, STROKE_MIN);
    return scaleX <= -1.0 ? -magnitude : magnitude;
  }
  if (scaleX === 1 && scaleY !== 1) {
    const magnitude = Math.max(absY, STROKE_MIN);
    return scaleY <= -1.0 ? -magnitude : magnitude;
  }

  // ============================================
  // CORNER HANDLES: Sideways drag (one axis negative)
  // ============================================
  // (Keep existing threshold logic - this is working for mixed)
  const magnitude = Math.max(absX, absY, STROKE_MIN);
  const dominantScale = absX >= absY ? scaleX : scaleY;
  if (dominantScale <= -1.0) {
    return -magnitude;
  }

  return magnitude;
}
```

**Key insight:** Keep the threshold at -1.0 for now. The user said the sideways flip behavior is good. Only the "both negative" rule was missing.

### Step 3: Mirror in objects.ts

Apply the exact same "both negative" rule to `computeUniformScaleForRender()` in `objects.ts`.

---

## Behavior Matrix After Fix

| Selection | Handle | Scale Type | Flip Trigger |
|-----------|--------|------------|--------------|
| **Shapes** | | | |
| Shape-only | Corner | Non-uniform | scale < 0 (immediate) |
| Shape-only | Side | Non-uniform | active axis < 0 (immediate) |
| **Strokes (uniform scale)** | | | |
| Stroke-only | Corner, diagonal | Uniform | BOTH < 0 → immediate |
| Stroke-only | Corner, sideways | Uniform | dominant <= -1.0 |
| Stroke-only | Side | Uniform | active axis <= -1.0 |
| **Mixed** | | | |
| Mixed | Corner (all objects) | Uniform | Same as stroke rules |
| Mixed | Side + stroke | **TRANSLATE** | N/A (position only) |
| Mixed | Side + shape | Non-uniform | active axis < 0 (immediate) |

**Important:** The -1.0 threshold for sideways/side flips is WORKING WELL per user feedback. Don't change it.

---

## Test Scenarios

### Shape Flip (should work smoothly now)
1. Select single shape
2. Drag corner handle past opposite corner
3. **Expected:** Shape flips smoothly when crossing origin, NO bounce-back

### Stroke Diagonal Flip (corner handle)
1. Select single stroke
2. Drag SE corner diagonally toward NW (past origin)
3. **Expected:** IMMEDIATE flip when both axes go negative

### Stroke Sideways Drag (corner handle)
1. Select single stroke
2. Drag SE corner primarily LEFT (staying below the selection)
3. **Expected:** Flip when dominant axis reaches -1.0 (1x width past origin)

### Stroke Side Handle
1. Select single stroke
2. Drag E (right) handle to the left past W edge
3. **Expected:** Flip when scale reaches -1.0

### Mixed Selection Translation (ALREADY WORKING)
1. Select shape + stroke together
2. Drag E handle
3. **Expected:** Shape scales, stroke translates (anchor behavior)

### Mixed Corner (ALREADY WORKING)
1. Select shape + stroke together
2. Drag corner handle sideways
3. **Expected:** Per-axis flip with -1.0 threshold

---

## Exact Changes Required

| File | Function | Change |
|------|----------|--------|
| `SelectTool.ts` | `computeScaleFactors()` ~L636 | Remove dead zone calls |
| `SelectTool.ts` | `applyFlipDeadZone()` ~L644 | DELETE entire function |
| `SelectTool.ts` | `computeUniformScaleWithDiagonalFlip()` ~L1012 | ADD "both negative" check at TOP |
| `objects.ts` | `computeUniformScaleForRender()` ~L537 | ADD same "both negative" check |

---

## Resolved Questions

1. **Threshold value:** Keep at -1.0 for now. User confirmed sideways flip behavior is good.

2. **Cursor feedback:** Mentioned as buggy but lower priority than flip fixes.

---

## Summary for Next Agent

**Two changes needed:**

1. **REMOVE dead zone** from `computeScaleFactors()` - this is corrupting ALL scales
2. **ADD "both negative" check** to `computeUniformScaleWithDiagonalFlip()` - restore immediate diagonal flip

**DO NOT CHANGE:**
- The -1.0 threshold for sideways/side flips (working well)
- The side handle detection (scaleY === 1 or scaleX === 1)
- The stroke translation (origin-based math is working)

**Code locations:**
- `SelectTool.ts:636-653` - Dead zone (REMOVE)
- `SelectTool.ts:644-654` - `applyFlipDeadZone()` function (DELETE)
- `SelectTool.ts:1007-1042` - `computeUniformScaleWithDiagonalFlip()` (ADD both-negative rule)
- `objects.ts:531-566` - `computeUniformScaleForRender()` (ADD both-negative rule)

**Working code (don't touch):**
- `SelectTool.ts:974-1005` - `computeStrokeTranslation()`
- `objects.ts:503-529` - `computeStrokeTranslationForRender()`

---

**End of Handoff V2**
