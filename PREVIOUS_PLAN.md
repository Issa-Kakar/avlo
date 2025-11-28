# SelectTool Scale Transform Refactor - Final UX Polish
> @SELECT_TOOL_SCALE_REFACTOR.md we are essentially done with this refactor, but there are a few more tweaks to make. perhaps the plan isn't done yet, i know for sure the cursors are not updated. either way though: the 
scaling clear bugs are not an issue anymore, dirty rects are good now. this could be a case of which the task wasn't fully done. but this is the issue currently: when scaling with the side handles in mixed, although the
 shapes are working perfectly and the strokes are translating: there is a UX thing regarding how miro does it with the translations of the stroke: the best way i can describe it is by walking you through it, imagine a 
selection that is mixed, and there is a stroke on the very right side, and the very top middle. when you do the marquee selection, because those were the "outmost" bound objects in the selection, they are making the 
border of the selection, aka the bounds, if that makes sense. now: when dragging the side handle, the stroke behaviour isn't just blindly translating: if you were to grab the left side hand, and pull it all the way left
 to right: the middle top stroke would start to slide slowly to the right, imagine a shape was to the very left at the start, when you are moving to the left to the right, it approaches the axis flip point and 
everything starts to converge. but critically: that right side stroke that was the outmost one: never moved. vs our implementation, it does move to the right, it not fixed, the determining factor to deciding behaviour 
of whether its anchored within the selection box or not is hard to understand, but the strokes being on the edge where the axis would flip is usually when this stroke wouldn't move. and this seems to go on the other way
 as well if the other side has a stroke on the furthest left at the same time, it stays fixed. and crucially: there's a hint, not sure if you can get something out of it, but when you cross origins, if i didin't mention
 above^ the "fixed" position objects still flip, but once they cross the axis(your cursor crosses that origin, the oppsisite selection bound) they flip but they remain in place, i think the key is looking at it by 
selection box? and also keep in mind: the ones that are in the middle or unaffected axis's stay sliding continuously. and crucially: when there's an axis flip, this is the biggest hint, you need to think about what they
 are doing? : in the example, once dragging it left to right, at that point where your selection box shrinks until its about to cross the origin, so keeping in mind the stroke on the far right HAS NOT moved: right when 
you cross, it will flip, but the other strokes that were moving during the cross, they already "cross" to the other side very slightly, imagine a small sliver vertically: there is a decoupling of the selection box vs 
the stroke box, this might be because they just fundamentally treat it differently. but when the selection box hasn't flipped yet, that stroke selection box will stay on that left side, not being in range essentially 
within the actual selection box, while the moving strokes will be "past" the axis switch point visually already, and then boom when you cross, there is a FLIP almost! THEY ALSO DO THIS HORIZONTAL SCALING EVEN WITH JUST 
STROKES SELECTED, SO THE SIDE SELECT HANDLE DURING STROKE MULTI SELECT ALWAYS TRANSLATES FOR THEM, AND THE SELECTION BOX AND THE STROKES SELECTION BOXES DIFFER, I TESTED IT WITH TWO STROKES ONLY: THEY QUITE LITERALLY 
"SWAP" AT THAT AXIS POINT BECAUSE YOU DRAG RIGHT TO LEFT OR LEFT TO RIGHT, THE SIDE YOU ARE DRAGGING IS MOVING AND IT WILL CONTINUE TO MOVE EVEN IF IT GOES PAST THE SELECTION BOX VISUALLY, BUT WAITS UNTIL THE CROSS AND 
BOOM IT'LL PULL ITSELF BACK TO THE OTHERSIDE OF THE AXIS, WHERE IT STARTS TO TRANSLATE AGAIN. if this makes sense to you: investigate to see how this should ideally work, i like our multi stroke scaling i don't want to 
translate only on side handles per say, but we need to fix another issue that is actually a bug: the side handles are scaling to the side and not corners and furthermore: the UX regarding in terms of how it feels is 
off, it isn't letting you reverse in the oppisite axis(perhaps because diagnaol scaling isn't finished for stroke only?) and the cursor resize behaviour is just not intuitive and natural to what a whiteboard feels like.
 AND HERE IS A KEY UX DETAIL: WE MUST ADOPT THIS, THE MIXED STROKE CORNER RESIZE WE HAVE WORKS BUT FEELS CLONKY. I NOTICE THAT MIRO, IF YOU HAVE A MIXED SELECTION OF SHAPES AND STROKES, AND YOU GRAB LETS SAY THE BOTTOM 
RIGHT CORNER, AND YOU MOVE ALL THE WAY TO THE LEFT PAST THE TOP LEFT CORNER ANCHOR, EVEN IF YOU ARE WAY BELOW THE TOP LEFT ANCHOR: IF YOUR CURSOR CROSSES THE ORIGIN, AND , AND THIS IS CRITICAL, IT GOES THE SELECTION 
BOUNDS DISTANCE PAST THE TOP LEFT CORNER(IN THE LEFT DIRECTION ONLY) IT WILL AXIS FLIP AS WELL. THIS FEELS VERY VERY NATURAL. BREAK THIS DOWN STEP BY STEP: FIGURE OUT IF THERE'S ANY BUGS, AND ALSO ANY BETTER UX 
WHITEBOARD SEMANTICS WE CAN IMPLEMENT. ULTRATHINK 

● This is a fascinating UX deep-dive. Let me carefully analyze what you're describing and investigate the current implementation to understand the gaps.

  Let me first read the current state of the code and plan to understand exactly where we are:

● Reading Plan(~/.claude/plans/precious-coalescing-frost.md)
  ⎿  Read 746 lines

● Read(client/src/lib/tools/SelectTool.ts)
  ⎿  Read 1757 lines

● Read(client/src/renderer/layers/objects.ts)
  ⎿  Read 701 lines

● This is a complex set of issues. Let me break down what I understood from your detailed description:

  Issues Identified

  1. Strokes-Only Side Handle Bug (Critical)

  The side handles are computing single-axis scale (scaleY=1 or scaleX=1) in computeScaleFactors(), then converting to uniform scale later in render/commit. This creates a mismatch - the drag feels wrong because the raw
   scale values don't reflect uniform scaling.

  Current code (lines 626-633):
  } else if (isSideH) {
    scaleX = origWidth > 0 ? (dx * handleSignX) / origWidth : 1;
    scaleY = 1;  // <-- BUG: Forces Y to 1, but strokes need uniform
  }

  2. Mixed + Side + Stroke: Edge-Anchoring (Miro-like)

  Your description of Miro's behavior:
  - Strokes at the anchor edge (opposite of dragged handle) should stay FIXED in world space
  - Strokes at the dragging edge move with that edge
  - Strokes in the middle slide proportionally

  Our current implementation: All strokes use simple relative position, so even strokes at the anchor edge move when bounds shrink.

  3. Mixed + Corner: Per-Axis Flip UX

  Miro allows single-axis flip when the cursor crosses the origin AND goes the selection bounds distance past in that axis direction. Our diagonal-only flip is too restrictive.

  4. Cursor Issues

  Strokes-only side handles should show diagonal cursors (since they act like corners).

  Let me update the plan file with the complete analysis and solution:

● Updated plan
  ⎿  /plan to preview · ~/.claude/plans/precious-coalescing-frost.md
  ⎿  Interrupted · What should Claude do instead?

> Wait: when i say miro allows the "flip" when in mixed object selection, i mean specifically in the case of "crossing the origin" is differently handled and feels more natural to flip to the DIAGNAOL axis. so in the 
miro scenerio, imagine taking the bottom right corner of the mixed selection box, and moving VERRRY slightly up to the left. the degree of scaling difference based on cursor positon is completeley different compared to 
ours, they already start to scale even if its not clearly clearly in that direction, which is probably very complex to implement. but the thing i was referring to: when you keep going from right to left dragging the 
corner handle, keeping in mind you are not heading towards the top left corner directly for the diagnoal axis flip, if you head to the left of the furthest selection bound y axis, and you cross it and keep going, still 
underneath but your cursor (NOT SELECTION BOUNDS, YOUR CURSOR), is past the top left corner by the selection box's size left to right, if you cross that point, then even if you aren't going above the top left corner 
with your cursor, it can still flip. does that make sense? ultrathink 

● I understand now. Let me restate to make sure I have it right:

  Miro's Flip Rule (for mixed + corner):

  When dragging SE corner (anchor at NW/top-left):
  - You drag LEFT, staying BELOW the anchor (not heading diagonally toward it)
  - Your cursor crosses the anchor's X position → scaleX goes negative
  - You keep going LEFT...
  - FLIP triggers when: cursor X is past the anchor by the original selection width

  In other words: if (scaleX < 0 && Math.abs(scaleX) >= 1.0) → flip X-axis

  This means:
  - Zone 1 (0 to -1 scale): "Hysteresis zone" - no flip yet, selection shrinks toward the axis
  - Zone 2 (past -1 scale): Flip triggers because you've gone "one full selection width" past the origin

  This is per-axis - you can flip just X without flipping Y, as long as you've gone far enough on that axis.

  Current (broken): scaleX < 0 && scaleY < 0 - requires BOTH negative (diagonal only)

  Miro (natural): Math.abs(scaleX) >= 1 && scaleX < 0 - per-axis, with magnitude threshold

  Let me update the plan with this corrected understanding:

● Updated plan
  ⎿  /plan to preview · ~/.claude/plans/precious-coalescing-frost.md

● Let me write a clean version of the plan file:

● Updated plan
  ⎿  /plan to preview · ~/.claude/plans/precious-coalescing-frost.md

● Ah yes! So it's a true bidirectional hysteresis band:

  1. Flip ON threshold: |scale| >= 1.0 (one selection width past origin)
  2. Flip OFF threshold: |scale| < 1.0 (come back within one selection width of origin)

  If you drag way out (scale = -3.0) and start coming back:
  - At scale = -1.5 → still flipped (magnitude >= 1.0)
  - At scale = -0.9 → flip turns OFF, snaps back to positive

  This prevents jitter when hovering near the flip boundary.

  Let me update the plan:

● Updated plan
  ⎿  /plan to preview · ~/.claude/plans/precious-coalescing-frost.md

● The plan is now comprehensive. Before I finalize and exit plan mode, I have a few clarifying questions:
                                                                                                                                                                                                                          
● User answered Claude's questions:
  ⎿  · For mixed + side + stroke edge-anchoring: should strokes be considered 'at the anchor edge' based on a percentage threshold (like 10% from edge), or should it be based on whether the stroke's bbox is literally 
     touching/defining the selection bounds? → Bbox touching selection bounds
     · For strokes-only selection, you mentioned you like our uniform scale approach. But Miro uses translation for side handles even in strokes-only. Which do you prefer? → Actually: the corner handles are already 
     uniformly scaling on strokes only. i finally understand now: the only reason there's no translation sideways on single selected strokes is because there is no reshaping strokes geometry amongst one axis, but since 
     theres not multiple strokes, they put the corner resize handles on it to show the default translate sides isn't an option, so they corner anchor resize as the side handles. i like that actually: you can resize with
      the corners on multistroke select anyway and translate via sides. for single strokes: we can compute the anchors and fix the cursors once we have everything else down(need to check selection state candidate size).


     · Which fixes are highest priority? I can implement them in a specific order based on impact. → Full Miro parity

● Excellent insight! Let me update the plan with this clearer understanding:

  Key realization about strokes-only:
  - Single stroke: Corner handles only (or corner-style behavior on sides) - uniform scale
  - Multi-stroke:
    - Side handles: TRANSLATE (Miro style) - strokes slide relative to each other
    - Corner handles: Uniform scale (geometry + width)

  This means for multi-stroke selections, side handles should use the same translation logic as mixed + side + stroke!

● Updated plan
  ⎿  /plan to preview · ~/.claude/plans/precious-coalescing-frost.md

● The plan is now complete with all your clarifications incorporated:

  Summary of final plan:

  1. Per-axis flip with bidirectional hysteresis (Fix 2) - First priority
    - Flip triggers at |scale| >= 1.0, unflips at |scale| < 1.0
    - Allows independent X/Y flip, prevents accidental flip
  2. Edge-anchored stroke translation (Fix 3) - Second priority
    - Uses bbox-defines-bounds detection (not percentage)
    - Strokes whose bbox defines the anchor edge stay FIXED in world space
    - Applies to BOTH mixed+side+stroke AND strokesOnly+side (multi-stroke)
  3. Strokes-only behavior by count (Fix 1) - Third priority
    - Single stroke: corner-like uniform scale
    - Multi-stroke: TRANSLATE on side handles (same as mixed)
  4. Cursor fixes - Deferred until core behavior is correct

  
## Overview

The dirty rect bugs are fixed and the core behavior matrix is implemented. This plan focuses on the remaining UX issues and bugs discovered during testing.

**Status:** Core implementation complete. UX polish and bug fixes remaining.

---

## Completed Work (Previous Sessions)

- Dirty rect accumulating envelope (no more ghosting)
- `applyTransformToBounds()` normalization for negative scale
- `selectionKind` and `handleKind` in selection store
- PF-per-frame rendering for stroke scale preview
- Context-aware `commitScale()` with per-object dispatch
- Context-aware `renderSelectedObjectWithScaleTransform()` dispatch

---

## Current Issues (User Reported)

### Issue 1: Strokes-Only Side Handles - Wrong Behavior
**Symptom:** Side handles are doing weird single-axis scale instead of Miro-like behavior

**User's Key Insight (Miro behavior):**
- **Single stroke:** Corner handles only (no meaningful side handle behavior since can't translate relative to itself)
- **Multi-stroke:**
  - **Side handles:** TRANSLATE only (strokes slide relative to each other, like mixed+side+stroke)
  - **Corner handles:** Uniform scale (geometry + width)

**Root Cause:** Our current implementation tries to do uniform scale for strokes-only side handles, but Miro uses TRANSLATION for multi-stroke selections.

**Fix:** For multi-stroke selections, side handles should translate strokes (same logic as mixed+side+stroke). For single stroke, show corner-style handles or corner behavior on sides.

### Issue 2: Strokes-Only - Flip Behavior Too Restrictive
**Symptom:** "it isn't letting you reverse in the opposite axis"

**Root Cause:** Diagonal-only flip rule (`scaleX < 0 && scaleY < 0`) prevents single-axis gestures from flipping, even when dragging a side handle past the origin.

**Fix:** For strokes-only side handles, since they act like corners, the flip should work naturally when the cursor crosses the origin. The issue is the side handle only computes one axis, so the other stays at 1 (positive) and prevents diagonal flip.

### Issue 3: Mixed + Side + Stroke - Edge-Anchoring (Miro UX)
**Symptom:** All strokes slide proportionally, but Miro keeps edge-defining strokes fixed.

**Current Behavior:** Simple relative position preservation - ALL strokes move to maintain relative position [0,1] within new bounds.

**Miro Behavior:**
1. Stroke at **anchor edge** (opposite handle) → stays FIXED in world space
2. Stroke at **dragging edge** → moves with that edge
3. Stroke in **middle** → slides proportionally

**Example:** Selection [0,100], grab LEFT handle, drag right (shrinking):
- Stroke A at x=95 (relX≈0.95, near RIGHT/anchor edge) → stays at x=95 (fixed!)
- Stroke B at x=50 (relX=0.5, middle) → slides to x=75 (proportional)
- Stroke C at x=5 (relX≈0.05, near LEFT/dragging edge) → moves to new left edge

**Key Insight:** Strokes near the ANCHOR edge should stay at their original world position, not mapped to relative position in new bounds.

### Issue 4: Mixed + Corner - Per-Axis Flip with Magnitude Threshold
**Symptom:** "feels clunky" when dragging corner past opposite corner

**User's Miro Observation:**
Dragging SE corner (anchor at NW), moving LEFT but staying BELOW the anchor:
- Cursor at x=-50 (past origin, but < 1× selection width) → NO flip yet
- Cursor at x=-100 (past origin by 1× selection width) → FLIP on X axis!

**Miro's Rule (per-axis, with magnitude threshold):**
```
// Flip X only when cursor is >= 1 selection width past origin
flipX = (scaleX < 0) && (Math.abs(scaleX) >= 1.0)
flipY = (scaleY < 0) && (Math.abs(scaleY) >= 1.0)
```

This creates a **hysteresis zone** between scale=0 and scale=-1 where:
- Scale can go negative (shrinking past origin)
- But flip doesn't trigger until you've traveled "one full selection size" past

**Why this feels natural:**
- Prevents accidental flip from barely crossing origin
- Allows independent X/Y flip (not just diagonal)
- Creates predictable "you must commit to it" threshold

**Current (broken):** `scaleX < 0 && scaleY < 0` - requires BOTH negative (diagonal only), no magnitude check

### Issue 5: Cursor for Strokes-Only Side Handles
**Symptom:** Cursor shows single-axis resize (ns/ew-resize) but should show diagonal

**Fix:** Use diagonal cursor for strokes-only side handles since they act like corners.

---

## Implementation Plan

### Fix 1: Strokes-Only Side Handles - Translation for Multi-Stroke

**Files:** `SelectTool.ts`, `objects.ts`

**Logic:**
```typescript
// In computeScaleFactors() and rendering:
if (selectionKind === 'strokesOnly' && handleKind === 'side') {
  const selectedCount = store.selectedIds.length;

  if (selectedCount > 1) {
    // MULTI-STROKE: Side handles TRANSLATE (same as mixed+side+stroke)
    // Use edge-anchored translation with bbox-defines-bounds detection
    // Strokes at anchor edge stay fixed, others slide
  } else {
    // SINGLE STROKE: Side handles act like corners (uniform scale)
    // Or: hide side handles entirely, show only corners
  }
}
```

**Note:** Cursor/handle display for single stroke is deferred - can be addressed after core fixes.

### Fix 2: Per-Axis Flip with Bidirectional Hysteresis

**Hysteresis behavior:**
- **Flip ON:** When `|scale| >= 1.0` (cursor goes 1× selection size past origin)
- **Flip OFF:** When `|scale| < 1.0` (cursor comes back within 1× selection size of origin)

**Example flow:**
1. Drag way past origin: scale = -3.0 → FLIPPED
2. Start coming back: scale = -1.5 → still flipped (magnitude >= 1.0)
3. Keep coming: scale = -0.9 → UNFLIP! (magnitude < 1.0, snaps to +0.9)

This prevents jitter when hovering near the flip boundary.

**New function for mixed selections:**
```typescript
private computeScaleWithMagnitudeFlip(
  scaleX: number,
  scaleY: number
): { scaleX: number; scaleY: number } {
  // Per-axis flip with bidirectional hysteresis at magnitude 1.0
  // Flip ON when |scale| >= 1.0, flip OFF when |scale| < 1.0
  const flipX = scaleX < 0 && Math.abs(scaleX) >= 1.0;
  const flipY = scaleY < 0 && Math.abs(scaleY) >= 1.0;

  let finalScaleX = scaleX;
  let finalScaleY = scaleY;

  // In hysteresis zone (-1 < scale < 0), snap to positive (no flip)
  if (scaleX < 0 && !flipX) {
    finalScaleX = Math.abs(scaleX); // Snap to positive
  }
  if (scaleY < 0 && !flipY) {
    finalScaleY = Math.abs(scaleY); // Snap to positive
  }

  // Clamp minimum
  const minScale = 0.05;
  finalScaleX = Math.sign(finalScaleX) * Math.max(minScale, Math.abs(finalScaleX));
  finalScaleY = Math.sign(finalScaleY) * Math.max(minScale, Math.abs(finalScaleY));

  return { scaleX: finalScaleX, scaleY: finalScaleY };
}
```

### Fix 3: Edge-Anchored Stroke Translation (Miro-like)

**Detection method:** Bbox-defines-bounds (not percentage threshold)

A stroke is "at the anchor edge" if its bbox literally defines that edge of the selection bounds.

**Algorithm:**
```typescript
function computeStrokeTranslationWithEdgeAnchor(
  handle: ObjectHandle,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId
): { dx: number; dy: number } {
  const [bboxMinX, bboxMinY, bboxMaxX, bboxMaxY] = handle.bbox;
  const EPSILON = 0.5; // Tolerance for float comparison

  // Determine which edge is the ANCHOR (opposite of dragged handle)
  // Check if stroke bbox DEFINES that anchor edge
  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  // Stroke defines anchor edge if its bbox touches/equals the selection bounds on that edge
  const definesAnchorX = isSideH && (
    (handleId === 'w' && Math.abs(bboxMaxX - originBounds.maxX) < EPSILON) || // Anchor at E, bbox at E
    (handleId === 'e' && Math.abs(bboxMinX - originBounds.minX) < EPSILON)    // Anchor at W, bbox at W
  );
  const definesAnchorY = isSideV && (
    (handleId === 'n' && Math.abs(bboxMaxY - originBounds.maxY) < EPSILON) || // Anchor at S, bbox at S
    (handleId === 's' && Math.abs(bboxMinY - originBounds.minY) < EPSILON)    // Anchor at N, bbox at N
  );

  // Compute new center
  let ncx = cx, ncy = cy;

  if (isSideH) {
    if (definesAnchorX) {
      ncx = cx; // FIXED - stay at original world position
    } else {
      // Proportional slide using relative position
      ncx = actMinX + relX * (actMaxX - actMinX);
    }
  }

  if (isSideV) {
    if (definesAnchorY) {
      ncy = cy; // FIXED
    } else {
      ncy = actMinY + relY * (actMaxY - actMinY);
    }
  }

  return { dx: ncx - cx, dy: ncy - cy };
}
```

**Key insight:** Only strokes whose bbox actually touches the anchor edge of the selection stay fixed. This matches Miro's precise behavior.

### Fix 4: Cursor for Strokes-Only Side Handles

**File:** `SelectTool.ts` - `getHandleCursor()`

```typescript
private getHandleCursor(handle: HandleId): string {
  const store = useSelectionStore.getState();
  const selectionKind = this.computeSelectionKind(store.selectedIds);

  // Strokes-only: side handles act like corners, show diagonal cursor
  if (selectionKind === 'strokesOnly') {
    const isSide = ['n', 's', 'e', 'w'].includes(handle);
    if (isSide) {
      return handle === 'n' || handle === 's' ? 'nwse-resize' : 'nesw-resize';
    }
  }

  // Standard cursors
  switch (handle) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    default: return 'default';
  }
}
```

---

## Implementation Order (Full Miro Parity Priority)

1. **Fix 2: Per-axis flip with bidirectional hysteresis** (SelectTool.ts + objects.ts)
   - Most impactful UX improvement
   - Add `computeScaleWithMagnitudeFlip()` function
   - Update render and commit logic for mixed corner handles

2. **Fix 3: Edge-anchored stroke translation** (SelectTool.ts + objects.ts)
   - Update `computeStrokeTranslation()` with bbox-defines-bounds detection
   - Update `computeStrokeTranslationForRender()` in objects.ts to match
   - Apply to BOTH mixed+side+stroke AND strokesOnly+side (multi-stroke)

3. **Fix 1: Strokes-only side handles** (SelectTool.ts + objects.ts)
   - Multi-stroke: Use translation (same as mixed+side+stroke)
   - Single stroke: Defer cursor/handle changes until later

4. **Fix 4: Cursor fixes** (SelectTool.ts) - DEFERRED
   - Handle after core behavior is correct
   - Depends on selection count logic

---

## Critical Files

| File | Changes |
|------|---------|
| `client/src/lib/tools/SelectTool.ts` | computeScaleFactors, getHandleCursor, computeStrokeTranslation, new flip logic |
| `client/src/renderer/layers/objects.ts` | computeStrokeTranslationForRender, flip logic in render |

---

## Updated Behavior Matrix

| Selection | Handle | Count | Object | Behavior | Stroke Width | Flip Rule |
|-----------|--------|-------|--------|----------|--------------|-----------|
| shapesOnly | corner | any | shape | Non-uniform scale | Constant | Any direction |
| shapesOnly | side | any | shape | Single-axis scale | Constant | Any direction |
| strokesOnly | corner | any | stroke | Uniform scale | **Scales** | Diagonal only |
| strokesOnly | side | 1 | stroke | Corner-like (uniform) | **Scales** | Diagonal only |
| strokesOnly | side | >1 | stroke | **TRANSLATE (edge-anchored)** | **Unchanged** | Any direction |
| mixed | corner | any | shape | **Uniform scale** | Constant | **Per-axis (|s|≥1)** |
| mixed | corner | any | stroke | Uniform scale | **Scales** | **Per-axis (|s|≥1)** |
| mixed | side | any | shape | Single-axis scale | Constant | Any direction |
| mixed | side | any | stroke | **TRANSLATE (edge-anchored)** | **Unchanged** | Any direction |

**Key changes from original:**
- strokesOnly + side + multi-stroke = TRANSLATE (not uniform scale)
- mixed + corner = per-axis flip with magnitude ≥1 threshold (not diagonal-only)
- Edge-anchoring uses bbox-defines-bounds detection (not percentage threshold)

---

## Test Scenarios

### Per-Axis Flip with Hysteresis (Mixed + Corner)
- [ ] Drag SE toward NW, cursor at scale=-0.5 → no flip (in hysteresis zone)
- [ ] Drag SE past origin by 1× selection width on X → X-axis flips (scale < -1.0)
- [ ] Drag way past (scale=-3.0), come back to scale=-0.9 → UNFLIP (magnitude < 1.0)
- [ ] Can flip X independently from Y

### Edge-Anchored Translation (Mixed + Side + Stroke AND Strokes-Only Multi)
- [ ] Stroke whose bbox defines anchor edge stays FIXED in world space
- [ ] Stroke in middle slides proportionally
- [ ] Stroke whose bbox defines dragging edge moves with that edge
- [ ] Works for both mixed selections AND multi-stroke selections

### Strokes-Only Behavior by Count
- [ ] Single stroke + side handle → uniform scale (corner-like behavior)
- [ ] Multi-stroke + side handle → TRANSLATE with edge-anchoring
- [ ] Multi-stroke + corner handle → uniform scale (width scales)
