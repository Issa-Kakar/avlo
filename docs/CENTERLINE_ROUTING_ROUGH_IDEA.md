# Centerline Routing Implementation Plan

## Overview

This document outlines the implementation strategy for **centerline-preferred orthogonal routing**. The core insight is that instead of adding all padding boundary lines and trying to make A* prefer the centerline via cost penalties, we **merge facing sides into a single centerline** during grid construction. This forces any route through that corridor to use the centerline naturally.

---

## The Core Insight

### Current Problem
```
[Start]→→→↓                    ← Goes down at start's right padding line (hugging)
         ↓
         →→→→→↓
              ↓
              ←[End]
```

The route "hugs" the shape because:
1. Grid has lines at: start-right-pad, end-left-pad, midpoint
2. A* sees all vertical lines as equal cost
3. Bend penalty makes it turn at first opportunity (start-right-pad)

### The Solution: Merge Facing Sides

```
BEFORE (separate lines):        AFTER (merged to centerline):
|       |   mid   |       |    |              mid              |
|start  |         | end   |    |               |               |
|pad    |         | pad   |    |               |               |

Result: A* MUST use centerline - it's the only vertical line in corridor
```

**Why L-routes still work:**
For perpendicular exits (e.g., East anchor → North anchor), the facing sides don't have a segment "parallel" to them. Going East from an East-facing side is perpendicular travel - no centerline needed.

---

## Current File Structure Analysis

| File | Lines | Current State | Needs Changes |
|------|-------|--------------|---------------|
| `routing.ts` | 54 | Dispatcher only | Minor (add anchored-start dispatch) |
| `routing-astar.ts` | 570 | A* + direction seeding | Add facing side integration |
| `routing-grid.ts` | 340 | Grid construction | Major refactor for midline merging |
| `routing-zroute.ts` | 200 | Simple HVH/VHV | Minimal changes |
| `constants.ts` | 222 | Configs/offsets | Add MIN_CENTERLINE_GAP |
| `shape-utils.ts` | 125 | Dir type, helpers | Expand with spatial helpers |

### Recommendation: Keep Files Separate

Do NOT merge routing-grid.ts and routing-astar.ts yet:
- They have distinct responsibilities (grid construction vs pathfinding)
- Merging would create a 900+ line file
- Instead, add a new file for spatial/direction helpers

**New file structure:**
```
routing.ts           → Dispatcher (keep as-is)
routing-astar.ts     → A* pathfinding (add facing side cost awareness)
routing-grid.ts      → Grid construction (major refactor)
routing-spatial.ts   → NEW: Direction/spatial classification helpers
routing-zroute.ts    → Simple routing (keep as-is)
constants.ts         → Add MIN_CENTERLINE_GAP constant
shape-utils.ts       → Keep frame/vector helpers here
```

---

## Implementation Phases

### Phase 0: Foundation - Spatial Helpers

**Goal:** Create classification helpers that the grid builder will use.

**File:** `client/src/lib/connectors/routing-spatial.ts` (new file)

#### Step 0.1: Direction Classification Types

```typescript
/**
 * Axis classification for direction pairs
 */
export type AxisRelation = 'same-axis' | 'cross-axis';

/**
 * Direction relationship (when same-axis)
 */
export type DirRelation = 'opposing' | 'same' | 'cross';

/**
 * Spatial relationship on a single axis
 */
export type AxisPosition = 'before' | 'after' | 'overlapping' | 'contained' | 'containing';
```

#### Step 0.2: Direction Classification Helpers

```typescript
import { type Dir, isHorizontal, isVertical } from './shape-utils';

/**
 * Check if two directions are on the same axis.
 * Same axis: both horizontal (E/W) or both vertical (N/S)
 */
export function isSameAxis(dir1: Dir, dir2: Dir): boolean {
  return (isHorizontal(dir1) && isHorizontal(dir2)) ||
         (isVertical(dir1) && isVertical(dir2));
}

/**
 * Check if two directions are cross-axis (perpendicular).
 */
export function isCrossAxis(dir1: Dir, dir2: Dir): boolean {
  return !isSameAxis(dir1, dir2);
}

/**
 * Check if two directions are opposite (N↔S, E↔W).
 */
export function isOpposing(dir1: Dir, dir2: Dir): boolean {
  return (dir1 === 'N' && dir2 === 'S') || (dir1 === 'S' && dir2 === 'N') ||
         (dir1 === 'E' && dir2 === 'W') || (dir1 === 'W' && dir2 === 'E');
}

/**
 * Classify the relationship between two directions.
 */
export function classifyDirRelation(exitDir: Dir, enterDir: Dir): DirRelation {
  if (isCrossAxis(exitDir, enterDir)) return 'cross';
  if (isOpposing(exitDir, enterDir)) return 'opposing';
  return 'same';
}
```

#### Step 0.3: AABB Helper Type

Currently `shapeBounds` uses `{ x, y, w, h }`. Add conversion helpers:

```typescript
export interface PaddedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Convert shape bounds + padding to min/max format.
 */
export function computePaddedBounds(
  bounds: { x: number; y: number; w: number; h: number },
  padding: number
): PaddedBounds {
  return {
    minX: bounds.x - padding,
    minY: bounds.y - padding,
    maxX: bounds.x + bounds.w + padding,
    maxY: bounds.y + bounds.h + padding,
  };
}
```

#### Step 0.4: Spatial Relationship Detection

```typescript
/**
 * Compute spatial relationship between two bounds on X axis.
 *
 * @returns 'before' if A is entirely left of B
 *          'after' if A is entirely right of B
 *          'overlapping' if they overlap
 *          'contained' if A is inside B
 *          'containing' if B is inside A
 */
export function computeXRelation(boundsA: PaddedBounds, boundsB: PaddedBounds): AxisPosition {
  if (boundsA.maxX <= boundsB.minX) return 'before';  // A left of B
  if (boundsA.minX >= boundsB.maxX) return 'after';   // A right of B

  const aInsideB = boundsA.minX >= boundsB.minX && boundsA.maxX <= boundsB.maxX;
  const bInsideA = boundsB.minX >= boundsA.minX && boundsB.maxX <= boundsA.maxX;

  if (aInsideB) return 'contained';
  if (bInsideA) return 'containing';
  return 'overlapping';
}

// Same for Y axis
export function computeYRelation(boundsA: PaddedBounds, boundsB: PaddedBounds): AxisPosition {
  if (boundsA.maxY <= boundsB.minY) return 'before';  // A above B
  if (boundsA.minY >= boundsB.maxY) return 'after';   // A below B

  const aInsideB = boundsA.minY >= boundsB.minY && boundsA.maxY <= boundsB.maxY;
  const bInsideA = boundsB.minY >= boundsA.minY && boundsB.maxY <= boundsA.maxY;

  if (aInsideB) return 'contained';
  if (bInsideA) return 'containing';
  return 'overlapping';
}
```

#### Step 0.5: Facing Sides Computation

This is the critical helper. Given two AABBs, determine which sides "face" each other:

```typescript
export interface FacingSides {
  /** Vertical corridor: X-lines that face each other */
  xFacing: {
    exists: boolean;
    fromLine: number;      // From shape's facing X line (right if exiting E)
    toLine: number;        // To shape's facing X line (left if entering W)
    centerline: number;    // Midpoint between facing lines
    gap: number;           // Distance between facing lines
  } | null;

  /** Horizontal corridor: Y-lines that face each other */
  yFacing: {
    exists: boolean;
    fromLine: number;      // From shape's facing Y line
    toLine: number;        // To shape's facing Y line
    centerline: number;
    gap: number;
  } | null;
}

/**
 * Compute facing sides between two padded bounds.
 *
 * Facing sides are the "interior" sides that look at each other.
 * For shapes side-by-side on X axis: A's right faces B's left (or vice versa)
 * For shapes stacked on Y axis: A's bottom faces B's top (or vice versa)
 */
export function computeFacingSides(
  fromBounds: PaddedBounds,
  toBounds: PaddedBounds,
  minGap: number = 10  // MIN_CENTERLINE_GAP
): FacingSides {
  const xRel = computeXRelation(fromBounds, toBounds);
  const yRel = computeYRelation(fromBounds, toBounds);

  let xFacing: FacingSides['xFacing'] = null;
  let yFacing: FacingSides['yFacing'] = null;

  // X-axis facing (vertical corridor)
  if (xRel === 'before') {
    // From is left of To → from.right faces to.left
    const gap = toBounds.minX - fromBounds.maxX;
    if (gap >= minGap) {
      xFacing = {
        exists: true,
        fromLine: fromBounds.maxX,
        toLine: toBounds.minX,
        centerline: (fromBounds.maxX + toBounds.minX) / 2,
        gap,
      };
    }
  } else if (xRel === 'after') {
    // From is right of To → from.left faces to.right
    const gap = fromBounds.minX - toBounds.maxX;
    if (gap >= minGap) {
      xFacing = {
        exists: true,
        fromLine: fromBounds.minX,
        toLine: toBounds.maxX,
        centerline: (fromBounds.minX + toBounds.maxX) / 2,
        gap,
      };
    }
  }

  // Y-axis facing (horizontal corridor)
  if (yRel === 'before') {
    // From is above To → from.bottom faces to.top
    const gap = toBounds.minY - fromBounds.maxY;
    if (gap >= minGap) {
      yFacing = {
        exists: true,
        fromLine: fromBounds.maxY,
        toLine: toBounds.minY,
        centerline: (fromBounds.maxY + toBounds.minY) / 2,
        gap,
      };
    }
  } else if (yRel === 'after') {
    // From is below To → from.top faces to.bottom
    const gap = fromBounds.minY - toBounds.maxY;
    if (gap >= minGap) {
      yFacing = {
        exists: true,
        fromLine: fromBounds.minY,
        toLine: toBounds.maxY,
        centerline: (fromBounds.minY + toBounds.maxY) / 2,
        gap,
      };
    }
  }

  return { xFacing, yFacing };
}
```

---

### Phase 1: Constants and Types Updates

**File:** `constants.ts`

Add:
```typescript
/** Minimum gap between facing sides for centerline to be valid (world units) */
export const MIN_CENTERLINE_GAP_W = 20;
```

**File:** `routing-grid.ts`

Add to Grid interface (optional - for debugging):
```typescript
export interface Grid {
  cells: GridCell[][];
  xLines: number[];
  yLines: number[];
  // Debug info (optional)
  facingSides?: FacingSides;
}
```

---

### Phase 2: Grid Construction Refactor

**Goal:** Modify `buildNonUniformGrid` to:
1. Detect facing sides between from/to bounds
2. If centerline exists: merge facing side lines into centerline
3. Handle case where start/end is ON a facing side

#### Step 2.1: Update buildNonUniformGrid signature

```typescript
export function buildNonUniformGrid(
  from: Terminal,
  to: Terminal,
  fromApproach: [number, number],
  toApproach: [number, number],
  strokeWidth: number,
  startInsidePadding?: boolean
): Grid {
  // ... existing setup ...

  const approachOffset = computeApproachOffset(strokeWidth);

  // === NEW: Compute facing sides ===
  let facingSides: FacingSides | null = null;

  if (to.shapeBounds) {
    // For free→anchored: create "point bounds" for free endpoint
    const toBounds = computePaddedBounds(to.shapeBounds, approachOffset);

    if (from.shapeBounds) {
      // anchored→anchored
      const fromBounds = computePaddedBounds(from.shapeBounds, approachOffset);
      facingSides = computeFacingSides(fromBounds, toBounds, MIN_CENTERLINE_GAP_W);
    } else {
      // free→anchored: free endpoint has no "facing side" in traditional sense
      // But we still want centerline behavior when going head-on
      facingSides = computeFacingSidesFromPoint(from.position, toBounds, MIN_CENTERLINE_GAP_W);
    }
  }

  // === Grid line placement with centerline merging ===
  // ... modified line placement logic ...
}
```

#### Step 2.2: New helper for free→anchored facing sides

When start is free (a point), we check if the point is in a position that would create a "corridor" to the shape:

```typescript
/**
 * Compute facing sides from a point to a padded bounds.
 *
 * For free→anchored routing, we check if the point is positioned
 * such that routing would benefit from a centerline.
 */
export function computeFacingSidesFromPoint(
  point: [number, number],
  toBounds: PaddedBounds,
  minGap: number
): FacingSides {
  const [px, py] = point;

  let xFacing: FacingSides['xFacing'] = null;
  let yFacing: FacingSides['yFacing'] = null;

  // Check X-axis: is point left or right of shape with gap?
  if (px < toBounds.minX) {
    const gap = toBounds.minX - px;
    if (gap >= minGap) {
      xFacing = {
        exists: true,
        fromLine: px,  // Point's X (no padding line for point)
        toLine: toBounds.minX,
        centerline: (px + toBounds.minX) / 2,
        gap,
      };
    }
  } else if (px > toBounds.maxX) {
    const gap = px - toBounds.maxX;
    if (gap >= minGap) {
      xFacing = {
        exists: true,
        fromLine: px,
        toLine: toBounds.maxX,
        centerline: (px + toBounds.maxX) / 2,
        gap,
      };
    }
  }

  // Similar for Y-axis
  if (py < toBounds.minY) {
    const gap = toBounds.minY - py;
    if (gap >= minGap) {
      yFacing = {
        exists: true,
        fromLine: py,
        toLine: toBounds.minY,
        centerline: (py + toBounds.minY) / 2,
        gap,
      };
    }
  } else if (py > toBounds.maxY) {
    const gap = py - toBounds.maxY;
    if (gap >= minGap) {
      yFacing = {
        exists: true,
        fromLine: py,
        toLine: toBounds.maxY,
        centerline: (py + toBounds.maxY) / 2,
        gap,
      };
    }
  }

  return { xFacing, yFacing };
}
```

#### Step 2.3: Modify grid line placement

The key insight: **When centerline exists on an axis, DON'T add both facing side lines - add only the centerline.**

```typescript
// === Current (to be replaced) ===
// Obstacle padding boundaries (adds ALL 4 lines)
if (to.shapeBounds) {
  const { x, y, w, h } = to.shapeBounds;
  xLines.push(x - approachOffset, x + w + approachOffset);
  yLines.push(y - approachOffset, y + h + approachOffset);
}

// Midpoints (wrong - uses approach points)
const midX = (fromApproach[0] + toApproach[0]) / 2;
const midY = (fromApproach[1] + toApproach[1]) / 2;
xLines.push(midX);
yLines.push(midY);
```

```typescript
// === New logic ===
if (to.shapeBounds) {
  const { x, y, w, h } = to.shapeBounds;
  const toBounds = computePaddedBounds(to.shapeBounds, approachOffset);

  // Determine which padding lines to add based on facing sides
  const shouldMergeX = facingSides?.xFacing?.exists ?? false;
  const shouldMergeY = facingSides?.yFacing?.exists ?? false;

  if (shouldMergeX) {
    // X-facing exists: use centerline instead of both facing lines
    xLines.push(facingSides!.xFacing!.centerline);

    // BUT: still add the NON-facing sides (exterior wrap lines)
    // If from is LEFT of to: add to's RIGHT padding (for wrapping around)
    // If from is RIGHT of to: add to's LEFT padding
    if (facingSides!.xFacing!.fromLine < facingSides!.xFacing!.toLine) {
      // from is left → to's right is exterior
      xLines.push(toBounds.maxX);
    } else {
      // from is right → to's left is exterior
      xLines.push(toBounds.minX);
    }
  } else {
    // No X centerline - add both horizontal padding lines
    xLines.push(toBounds.minX, toBounds.maxX);
  }

  if (shouldMergeY) {
    // Y-facing exists: use centerline instead of both facing lines
    yLines.push(facingSides!.yFacing!.centerline);

    // Add non-facing (exterior) side
    if (facingSides!.yFacing!.fromLine < facingSides!.yFacing!.toLine) {
      yLines.push(toBounds.maxY);
    } else {
      yLines.push(toBounds.minY);
    }
  } else {
    // No Y centerline - add both vertical padding lines
    yLines.push(toBounds.minY, toBounds.maxY);
  }
}

// NO separate midpoint calculation - centerlines ARE the midpoints now
```

#### Step 2.4: Handle endpoint ON facing side

When the goal position is on a facing side line that we're merging, we need to keep connectivity:

```typescript
// If goal is on a facing side that got merged, add a line there for connectivity
if (shouldMergeX && to.isAnchored) {
  const goalX = computeGoalX(to, approachOffset);
  // Check if goal X is on a merged facing side
  if (Math.abs(goalX - facingSides!.xFacing!.toLine) < 1) {
    // Goal is on the facing side - we still need this line for the endpoint
    xLines.push(goalX);
    // But the cells along this line (except the goal) should be...?
    // This is the "block adjacent cells" question
  }
}
```

**The "block adjacent cells" question:**

User mentioned: "if the start or end has an x/y line on those facing sides we'll keep them, but we need to figure out: do we block the adjacent cells on that axis of the shapes boundary on that axis?"

**Proposed answer:** When goal is on a facing side:
1. Add the goal's X or Y line back to the grid
2. **Mark cells along that line as blocked EXCEPT the goal cell itself**
3. This creates a "stub" - route can reach goal but can't travel along the facing side

This is handled in `createCellGrid`:

```typescript
// NEW: After creating cells, if goal is on merged facing side, block the line except goal
if (facingSides?.xFacing?.exists && goalIsOnFacingX) {
  const facingXIndex = xLines.indexOf(goalX);
  if (facingXIndex >= 0) {
    for (let yi = 0; yi < yLines.length; yi++) {
      const cell = cells[yi][facingXIndex];
      if (cell.y !== goalPos[1]) {
        cell.blocked = true;
      }
    }
  }
}
```

---

### Phase 3: Direction Seeding Refinement

**Goal:** Always seed first direction for deterministic routing.

Currently, direction seeding only happens when:
1. `from.isAnchored` - uses `from.outwardDir`
2. `startInsidePadding` - computes escape direction

**Proposed:** Always seed when we have facing sides information.

```typescript
// In computeAStarRoute:

let preferredFirstDir: Dir | null = null;

if (from.isAnchored) {
  // Anchored start: always use outwardDir
  preferredFirstDir = from.outwardDir;
} else if (startInsidePadding) {
  // Inside padding: escape direction
  preferredFirstDir = computePreferredFirstDir(from.position, to);
} else if (facingSides) {
  // Free start with facing sides: seed based on direction relation
  const dirRelation = classifyDirRelation(from.outwardDir, to.outwardDir);

  if (dirRelation === 'opposing' && facingSides.xFacing?.exists) {
    // Head-on horizontal: start going outward (from.outwardDir)
    preferredFirstDir = from.outwardDir;
  } else if (dirRelation === 'opposing' && facingSides.yFacing?.exists) {
    // Head-on vertical
    preferredFirstDir = from.outwardDir;
  }
  // Cross-axis: let A* decide naturally (L-route preferred)
}
```

---

### Phase 4: Test Scenarios

Before implementing, define test cases to validate:

#### 4.1: Free→Anchored Head-On (Z-route expected)
```
Start: Free point at (0, 50)
End: Shape at (200, 0, 100, 100), anchor on W side at (200, 50)
Exit: E (inferred from drag)
Enter: W

Expected: HVH with vertical segment at centerline X = 100
Current: HVH but might hug shape left padding
```

#### 4.2: Free→Anchored L-Route (perpendicular)
```
Start: Free point at (50, 0)
End: Shape at (100, 100, 100, 100), anchor on N side at (150, 100)
Exit: S (inferred)
Enter: N

Expected: Simple VH - down then right
No centerline needed (cross-axis)
```

#### 4.3: Free→Anchored Same Direction
```
Start: Free point at (0, 50)
End: Shape at (200, 0, 100, 100), anchor on E side at (300, 50)
Exit: E
Enter: E (same direction)

Expected: Wrap around - requires going right past shape, then down/up
Centerline for horizontal corridor portion
```

---

## Code Simplification Opportunities

While implementing, consider these cleanups:

1. **Duplicate simplifyOrthogonal**: Both routing-astar.ts and routing-zroute.ts have this function. Move to shape-utils.ts or new routing-spatial.ts.

2. **Duplicate computeApproachPoint**: Both files have this. Consider single source.

3. **MinHeap class**: Could be extracted to utils, but fine inline for now.

4. **Grid debug visualization**: Consider adding optional debug mode that draws grid lines on overlay for development.

---

## Questions Resolved

### Q: Should we merge routing-grid.ts and routing-astar.ts?
**A: No.** Keep separate - they have distinct responsibilities. Add new `routing-spatial.ts` for helpers.

### Q: Should free endpoints be represented as tiny AABBs?
**A: No.** Handle specially with `computeFacingSidesFromPoint`. A point has no "sides" - simpler to treat as point.

### Q: How to handle endpoint on merged facing side?
**A: Block the line except goal cell.** Creates a stub so route can reach goal but not travel along facing side.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Facing sides detection wrong for edge cases | Medium | Comprehensive test cases |
| Breaking existing free→anchored routes | Low | Keep current behavior when no facing sides |
| Performance impact from facing sides computation | Low | Simple math, no iteration |
| Blocking logic creates unreachable goals | Medium | Always unblock goal cell |

---

## Success Criteria

1. **Free→Anchored Head-On**: Produces centered Z-route (not hugging)
2. **Free→Anchored L-Route**: Still produces clean L (no regression)
3. **All existing tests pass**: No breaking changes to current behavior
4. **Foundation for shape→shape**: Facing sides detection works for two AABBs

---

## Next Steps After This Phase

Once free→anchored centerline routing works:

1. **Shape→Shape Routing**: Use same facing sides logic with two real AABBs
2. **Two-Obstacle Blocking**: Grid construction with two blocked regions
3. **Wrap Routing**: Same-direction cases with exterior line usage
4. **Sticky Connectors**: Shape movement triggers route recomputation

# CENTERLINE PREFERENCE: REFINED ALGORITHM

## The Core Insight

**Precise Rule:** For any segment that runs along a **SHAPE PADDING LINE ITSELF** (the actual padded AABB boundary), if:
1. That padding line is a **FACING side** (interior side looking at the other shape)
2. A **CENTERLINE** exists parallel to it with minimum space

→ **Use centerline instead of the shape padding line.**

**Key Distinction:**
- We're not checking arbitrary parallel segments - we're checking if the path uses the **actual shape padding AABB lines**
- Each shape has 4 padding lines: 2 X-lines (left_pad, right_pad), 2 Y-lines (top_pad, bottom_pad)
- **Facing sides** = the interior sides that look at each other
- **Exterior sides** = the outer sides used for wrapping around (neutral cost, hugging is fine)

**The Two Choices:**
When routing parallel to a facing side, there are only two options:
1. Use the shape's padded AABB line (hugging)
2. Use the centerline (preferred when available)

**Cost Strategy:**
- **Centerline:** BONUS (cheaper than neutral)
- **Facing side padding lines:** PENALTY (more expensive than neutral)
- **Exterior/non-facing padding lines:** NEUTRAL (hugging is acceptable here)

## Detection Algorithm

### Step 1: Identify Potential Facing Sides

For two shapes A (start) and B (end):
- If path would traverse a **vertical segment** parallel to A's E/W sides → those are facing candidates
- If path would traverse a **horizontal segment** parallel to B's N/S sides → those are facing candidates

### Step 2: Check Centerline Viability

For each axis where parallel traversal detected:
- X-centerline = (A.right_pad + B.left_pad) / 2 (for horizontal corridor)
- Y-centerline = (A.bottom_pad + B.top_pad) / 2 (for vertical corridor)
- Centerline viable if: gap >= MIN_CENTERLINE_SPACE

### Step 3: Route Decision

```
IF segment runs parallel to facing side
AND centerline exists on that axis
THEN use centerline instead of facing side padding
```

---

## Worked Examples

### Example 1: Exit EAST, Enter WEST (Opposing Horizontal)

```
[Start]=→    ←=[End]
        E    W
```

**Path structure:** H → V → H
- Exit EAST (horizontal stub)
- Vertical segment (parallel to start's E OR end's W)
- Enter WEST (horizontal stub)

**Facing sides:** Start's EAST, End's WEST (both vertical)
**Vertical segment is parallel to facing sides** → Use X-centerline

```
HUGGING:                    CENTERLINE:
[Start]=→↓                  [Start]=→→→→↓
         ↓                              ↓
         ↓←←←←←←=[End]                  ↓←←←←=[End]

Down at start.right_pad     Down at midline_x
```

### Example 2: Exit EAST, Enter NORTH (Perpendicular, Wrong Quadrant)

```
    [End]
      ↑N

[Start]→E
```

Start is BELOW end. Cannot do direct L.

**Path structure:** H → V → H → V
- Exit EAST (stub)
- Go UP (vertical)
- Go LEFT (horizontal) ← **This is parallel to End's NORTH!**
- Go DOWN into NORTH (stub)

**Facing side:** End's NORTH (horizontal line)
**Horizontal segment parallel to NORTH** → Use Y-centerline

```
HUGGING:                         CENTERLINE:
[Start]→→→→↑                     [Start]→→→→↑
           ↑                              ↑
    [End]←←←                      ←←←←←←←←
      ↑N   ↓                      ↓
           ↓                      ↓
                              [End]
                                ↑N
                                ↓

LEFT along end.north_pad        LEFT along midline_y
```

### Example 3: Direct L (Perpendicular, Agreeing Quadrant)

```
[Start]→E
        ↓
      [End]
        ↑N
```

**Path structure:** H → V (bend at intersection)
- No segment parallel to any facing side
- Direct L uses intersection point

**No centerline needed** - the bend happens at the natural intersection.

### Example 4: Same Direction - POSITION/ALIGNMENT CRITICAL

#### Case 4a: Y-aligned, X-offset (start left of end)

```
←[Start]     [End]←
  W            W
```

**Facing sides:** Start's EAST, End's WEST (both vertical, interior)
**Path:** W stub → V down → H right → V up → W stub

**Key observation:** The vertical segments (V down, V up) are on **EXTERIOR** sides:
- Start's WEST (not facing - it's the exit direction side)
- End's WEST (not facing - it's the entry direction side)

**No parallel facing side segments used!** The E/W facing sides are never traversed parallel.
This is a **U-shape** where centerline X doesn't help (we go around, not through).

#### Case 4b: Diagonal offset (partial Y overlap)

```
←[Start]
  W   ↖
        ↖
          [End]←
            W
```

Start is top-left, end is bottom-right. Shapes have partial Y overlap.

**Two sub-cases based on Y overlap amount:**

**Sub-case: Small Y overlap (gap between N/S facing sides)**
```
Path: W → UP → RIGHT → UP → W(stub)
                 ↑
         This horizontal segment parallels N/S facing sides!
```
- Start's SOUTH and End's NORTH are now facing sides (horizontal)
- The rightward horizontal segment runs parallel to these
- **Centerline Y should be used** instead of hugging one shape's N/S padding

**Sub-case: Large Y overlap (shapes close vertically)**
```
Path: W → DOWN → RIGHT → UP → W(stub)
```
- Must go DOWN first to clear start, then wrap around
- The horizontal segment is now in different territory
- Facing sides detection changes based on actual path geometry

#### Case 4c: Vertically stacked, horizontally aligned

```
  [End]←
    W

←[Start]
  W
```

Start is below end, X-aligned.

**Facing sides:** Start's NORTH, End's SOUTH (horizontal lines)

**Path options:**
1. **U-shape around exterior:** W → DOWN → L/R → UP → UP → W
   - Uses Start's WEST (exterior, neutral) for the DOWN segment
   - This is acceptable when no centerline Y exists in the corridor

2. **Snake through corridor with centerline:** W → UP → L/R → UP → W
   - If there's a gap between shapes (corridor exists)
   - The horizontal segment should use centerline Y, not hug N/S padding

**Why position matters:**
- If shapes are X-aligned and have a vertical corridor → centerline Y preferred for horizontal segments
- If shapes have no corridor (too close) → must use U-shape around exterior

#### The Exterior Parallel Segments Question

**Concern:** What about exterior padding lines that are also parallel to the travel direction?

**Answer:** For **non-facing exterior sides**, use **NEUTRAL cost** (hugging is acceptable).

**Why this works:**
1. Manhattan routing naturally gravitates toward the goal
2. If centerline exists and has a BONUS, A* will prefer it over neutral exterior hugging
3. If centerline doesn't exist (shapes overlapping), exterior hugging is the only option anyway

**The rule simplification:**
- **BONUS** for centerline (when it exists and is parallel to facing sides)
- **PENALTY** for facing side padding lines (the interior sides)
- **NEUTRAL** for everything else (exterior sides, stubs, perpendicular segments)

This means we don't need to explicitly track exterior parallel segments - the cost structure naturally handles it:
- Centerline beats neutral (A* will prefer centerline when available)
- Neutral beats penalty (A* avoids facing side hugging when centerline is available)

---

## Implementation Strategy

### Option A: Post-Path Analysis (Evaluate & Penalize)

After A* finds initial path, analyze each segment:

```typescript
function evaluatePath(path: Point[], startShape: AABB, endShape: AABB): number {
  let penalty = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = { from: path[i], to: path[i + 1] };
    const isVertical = segment.from.x === segment.to.x;
    const isHorizontal = segment.from.y === segment.to.y;

    // Check if segment parallels a facing side
    if (isVertical) {
      const facingX = [startShape.right + PAD, endShape.left - PAD];
      if (facingX.includes(segment.from.x)) {
        // Check if X-centerline exists
        const centerlineX = (facingX[0] + facingX[1]) / 2;
        if (centerlineX exists && segment.from.x !== centerlineX) {
          penalty += CENTERLINE_MISS_PENALTY;
        }
      }
    }
    // Similar for horizontal segments
  }

  return penalty;
}
```

### Option B: Pre-Route Grid Modification (Block Facing Lines)

Before running A*, modify grid to exclude facing side lines:

```typescript
function buildCenterlinePreferredGrid(from, to, corridor): Grid {
  const xLines = [];
  const yLines = [];

  // Always add: start/goal positions, exterior padding, centerline
  xLines.push(from.position[0], to.position[0]);
  xLines.push(startShape.left - PAD, endShape.right + PAD); // exterior
  xLines.push(corridor.centerlineX); // the preferred route

  // DON'T add facing side lines: start.right + PAD, end.left - PAD
  // This forces A* to use centerline for vertical segments in corridor

  // BUT: need connection from start to centerline
  // Start cell exists at start.x, and centerline exists
  // A* will naturally go horizontal to reach centerline

  return buildGrid(xLines, yLines, ...);
}
```


### Option D: Three-Tier Cost Model (RECOMMENDED)

Apply BONUS/PENALTY/NEUTRAL based on edge classification:

```typescript
const CENTERLINE_BONUS = -500;      // Cheaper than neutral
const FACING_PENALTY = 1000;        // More expensive than neutral
const EXTERIOR_NEUTRAL = 0;         // Normal cost

function computeMoveCost(from, to, arrivalDir, moveDir, corridor): number {
  let cost = baseCost(from, to, arrivalDir, moveDir);

  // Determine edge classification
  const edgeX = from.x; // or to.x for vertical edges
  const edgeY = from.y; // or to.y for horizontal edges

  if (corridor.exists) {
    if (corridor.axis === 'x' && (moveDir === 'N' || moveDir === 'S')) {
      // Vertical movement - check X position
      if (Math.abs(edgeX - corridor.centerline) < EPSILON) {
        cost += CENTERLINE_BONUS;  // Prefer this!
      } else if (edgeX === corridor.facingSideStart || edgeX === corridor.facingSideEnd) {
        cost += FACING_PENALTY;    // Avoid this
      }
      // Exterior sides get no modification (neutral)
    }
    // Similar for horizontal movement with Y-axis corridors
  }

  return cost;
}
```

**Why this works:**
- Centerline is cheaper than neutral → A* naturally prefers centerline
- Facing sides are more expensive → A* avoids them when centerline exists
- Exterior sides are neutral → A* uses them when necessary (wrapping)
- If centerline doesn't exist, facing sides become the fallback (still reachable)

---

## Recommended Implementation: Three-Tier Cost Model

1. **Detect Corridor** during grid construction (before A*)
2. **Add all lines** (including facing sides) for fallback routing
3. **Apply cost modifiers** in A* based on edge classification:
   - CENTERLINE: **BONUS** (-500) - actively preferred
   - FACING: **PENALTY** (+1000) - actively avoided
   - EXTERIOR: **NEUTRAL** (0) - acceptable fallback

```typescript
interface Corridor {
  exists: boolean;
  axis: 'x' | 'y';              // 'x' = vertical centerline, 'y' = horizontal centerline
  facingSideStart: number;      // e.g., startShape.right + PAD
  facingSideEnd: number;        // e.g., endShape.left - PAD
  centerline: number;           // (facingSideStart + facingSideEnd) / 2
  hasMinSpace: boolean;         // gap >= MIN_CENTERLINE_SPACE
}

// Cost modifiers (added to base cost)
const CENTERLINE_BONUS = -500;  // Cheaper than neutral
const FACING_PENALTY = 1000;    // More expensive than neutral
// Exterior/neutral = 0 (no modification)
```

**Key insight:** By using additive modifiers instead of multipliers:
- Centerline is always preferred when available (bonus makes it cheaper)
- Facing sides are avoided but still reachable (penalty is finite)
- Exterior sides are neutral (natural fallback for wrapping)
- Manhattan routing toward goal is preserved

---

## Key Invariants

1. **Facing sides are INTERIOR sides** - the sides of shapes that look at each other (not the exit/entry sides)
2. **Exterior sides are NEUTRAL** - hugging is acceptable, no penalty applied
3. **Stubs are non-negotiable** - the initial/final segments are fixed by anchor direction
4. **Centerline only applies when corridor exists** - if shapes overlap on that axis, no centerline available
5. **Position/alignment determines facing sides** - which sides are "facing" depends on actual shape positions
6. **The check is per-edge** - during A* expansion, check if the current X/Y position is a facing line, centerline, or exterior
7. **Three-tier costs preserve fallback** - BONUS/PENALTY/NEUTRAL ensures paths always exist even when centerline is blocked
