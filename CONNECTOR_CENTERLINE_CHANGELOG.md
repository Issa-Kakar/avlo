# Connector Centerline Refactor - CHANGELOG & HANDOFF

## Status: DIRECTION SEEDING COMPLETE - Next: Centerline Paths & Blocking

---

## Session 2 Completed Work ✅

### 1. Implemented `computeFreeStartDirection()` in `routing-astar.ts`
**Lines 144-242** - New function that computes start direction for FREE endpoints based on spatial relationship to target shape (NOT cursor drag).

**Three cases handled:**
- **SAME SIDE (Z-route possible):** Start on same side as anchor's opposite (e.g., start LEFT, anchor WEST)
  - Z-route ONLY valid when: primary axis matches anchor axis (E/W → H, N/S → V)
  - Otherwise: L-route on perpendicular axis
- **OPPOSITE SIDES (wrap around):** Start on same side AS anchor (e.g., start LEFT, anchor EAST)
  - If contained within padded bounds: wrap around via shortest path (N/S or E/W based on shape center)
- **ADJACENT SIDES:** Go directly toward anchor

**Key insight:** Computes primary axis from `start→snap point` relationship, NOT cursor drag direction.

### 2. Integrated Direction Seeding in `computeAStarRoute()`
**Lines 633-648** - Changed from conditional seeding to ALWAYS seed for free endpoints:
```typescript
if (from.isAnchored) {
  preferredFirstDir = from.outwardDir;
} else if (startInsidePadding) {
  preferredFirstDir = computePreferredFirstDir(from.position, to);  // existing escape logic
} else {
  preferredFirstDir = computeFreeStartDirection(from, to, strokeWidth);  // NEW
}
```

### 3. Deleted `computeFreeToAnchoredFacing()` from `routing-grid.ts`
Function was fundamentally wrong - checked anchor direction but free endpoints don't have "anchor sides".

### 4. Fixed `buildNonUniformGrid()` Dispatch
**Lines 361-375** - Simplified to only compute facing sides for anchored→anchored cases:
```typescript
if (from.shapeBounds && to.shapeBounds) {
  facing = computeFacingSides(from.shapeBounds, to.shapeBounds, approachOffset);
} else {
  // Free→Anchored: no facing sides, use midpoint-based routing
  facing = { ...emptyFacingSides };
}
```

### 5. Fixed `computeShapeToShapeSpatial()` in `shape-utils.ts`
**Lines 256-274** - Removed `approachOffset` parameter. Spatial relations now use actual shape bounds only:
```typescript
export function computeShapeToShapeSpatial(
  startBounds: AABB,
  endBounds: AABB
): ShapeToShapeSpatial {
  // NO padding - spatial relations based on actual geometry
  const endIsRightOf = endBounds.x > startBounds.x + startBounds.w;
  // ...
}
```

### 6. Updated `computeFacingSides()` Call
**Line 128** - No longer passes `approachOffset` to spatial check.

---

## Remaining Typecheck Errors

```
src/lib/connectors/routing-grid.ts(219,3): error TS6133: 'startPos' is declared but its value is never read.
src/lib/connectors/routing-grid.ts(220,3): error TS6133: 'goalPos' is declared but its value is never read.
```
These are in `createCellGrid` - unused parameters that can be prefixed with `_`.

---

## NEXT STEPS (For Next Session)

### Priority 1: Centerline Paths for Free Endpoints
**Problem:** Free→anchored routing doesn't get centerlines because `from.shapeBounds` is null.

**Solution:** Generate a dummy negligible AABB for free start positions:
```typescript
function createDummyAABB(pos: [number, number]): AABB {
  return { x: pos[0] - 1, y: pos[1] - 1, w: 2, h: 2 };
}

// In buildNonUniformGrid:
const startBounds = from.shapeBounds ?? createDummyAABB(from.position);
const endBounds = to.shapeBounds ?? createDummyAABB(to.position);

if (startBounds && endBounds) {
  facing = computeFacingSides(startBounds, endBounds, approachOffset);
}
```

This enables centerline computation for ALL routing cases uniformly.

### Priority 2: Facing Side Blocking for Anchored Endpoints
**Problem:** When start/end is anchored to a shape's facing side (e.g., anchor on North, which faces the other shape), the route can currently travel PARALLEL along that facing side.

**Solution:** Block the facing side grid line except for the anchor point:
- If start is on facing side: block all cells on that Y line except start cell
- If end is on facing side: block all cells on that Y line except goal cell

**Implementation location:** `createCellGrid()` in `routing-grid.ts`

```typescript
// After normal blocking, add facing side blocking:
if (facing.hasYCenterline && cellY === facing.startFacingY) {
  // Block unless this is the start cell
  if (!isStartCell) blocked = true;
}
if (facing.hasYCenterline && cellY === facing.endFacingY) {
  // Block unless this is the goal cell
  if (!isGoalCell) blocked = true;
}
// Similar for X-axis facing sides
```

### Priority 3: A* Segment Intersection Blocking (CRITICAL BUG)
**Problem:** Current cell blocking is useless! A* only checks if CELLS are blocked, not if SEGMENTS between cells intersect obstacles. When start/goal are far apart, routes go straight through shapes.

**Why it happens:** The grid is sparse (non-uniform), so there may be no grid lines inside a shape. A* finds a path from cell A to cell B without knowing a shape is in between.

**Solution:** In `getNeighbors()` or `computeMoveCost()`, check if the segment from current cell to neighbor intersects any obstacle:

```typescript
function segmentIntersectsAABB(
  x1: number, y1: number,
  x2: number, y2: number,
  aabb: AABB
): boolean {
  // Line-rectangle intersection test
  // ...
}

// In getNeighbors or astar loop:
for (const neighbor of getNeighbors(grid, current.cell)) {
  if (neighbor.blocked) continue;

  // NEW: Check segment intersection with obstacles
  if (obstacles.some(obs => segmentIntersectsAABB(
    current.cell.x, current.cell.y,
    neighbor.x, neighbor.y,
    obs
  ))) {
    continue; // Skip this neighbor - path goes through obstacle
  }

  // ... rest of A* logic
}
```

**Note:** This requires passing obstacle list to the A* function or storing it in the Grid structure.

---

## Files Modified (Current Session)

| File | Changes |
|------|---------|
| `client/src/lib/connectors/routing-astar.ts` | Added `computeFreeStartDirection()`, updated integration |
| `client/src/lib/connectors/routing-grid.ts` | Deleted `computeFreeToAnchoredFacing()`, fixed dispatch |
| `client/src/lib/connectors/shape-utils.ts` | Removed padding from `computeShapeToShapeSpatial()` |

---

## Testing Checklist

After completing next steps, verify:

1. **Free → Anchored (head-on, H-dominant):** Z-route (HVH) with centerline
2. **Free → Anchored (head-on, V-dominant):** L-route (go N/S first)
3. **Free → Anchored (adjacent):** Clean L-route toward anchor
4. **Free → Anchored (opposite, contained):** Wrap around N or S
5. **Anchored → Anchored:** Centerline between facing sides
6. **Inside padding starts:** Escape direction still works
7. **Far shapes:** Route doesn't go through obstacles (segment blocking)

---

## Architecture Notes

### Direction Seeding Flow
```
from.isAnchored?
├─ YES → use from.outwardDir (fixed by shape attachment)
└─ NO (free endpoint)
    ├─ startInsidePadding? → computePreferredFirstDir() (escape logic)
    └─ outside padding → computeFreeStartDirection() (spatial logic)
```

### Centerline Grid Flow (After Dummy AABB Fix)
```
1. Get startBounds (real or dummy AABB)
2. Get endBounds (real or dummy AABB)
3. computeShapeToShapeSpatial(startBounds, endBounds) → spatial relation
4. computeFacingSides(startBounds, endBounds, offset) → centerlines
5. Build grid with centerlines instead of facing sides
6. Block facing side lines if start/end is on them
```

### A* Blocking Flow (After Segment Intersection Fix)
```
For each neighbor in getNeighbors():
  1. Skip if cell.blocked (inside shape bounds)
  2. Skip if segment(current→neighbor) intersects any obstacle AABB
  3. Otherwise, add to open set with appropriate cost
```
