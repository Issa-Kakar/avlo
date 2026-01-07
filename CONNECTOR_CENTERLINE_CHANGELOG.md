# Connector Routing System - Current State & Architecture

## Overview

This document describes the **current state** of the connector routing system after the centerline refactor. It serves as a handoff document for future sessions.

**Key Reference Documents:**
- `docs/ORTHOGONAL_SUMMARY.md` - Original baseline (describes what WAS)
- `docs/CENTERLINE_ROUTING_ROUGH_IDEA.md` - Design philosophy and algorithm details
- `docs/SEGMENT_INTERSECTION_FIX_PLAN.md` - Next implementation task (blocking fix)

---

## End Goal

Create an orthogonal connector routing system that:

1. **Uses centerlines** between facing shapes instead of hugging one shape's padding boundary
2. **Always seeds direction** for predictable, aesthetic routes (no cursor-drag inference)
3. **Creates stubs** at anchor points (routes enter perpendicular, not parallel)
4. **Avoids obstacles** via segment intersection checking (not just cell blocking)
5. **Supports all endpoint combinations**: free→anchored, anchored→anchored, anchored→free

---

## What Changed from ORTHOGONAL_SUMMARY.md

### Before (Original State)

| Aspect | Original Behavior |
|--------|------------------|
| **Midline calculation** | `(fromApproach.x + toApproach.x) / 2` - midpoint between approach points |
| **Facing sides** | No concept - all padding lines treated equally |
| **Direction seeding** | Conditional: only for anchored start OR inside padding |
| **Grid lines** | All 4 padding boundaries added for each shape |
| **Blocking** | Only `to.shapeBounds` blocked, padding-based |
| **Segment checking** | None - A* only checks if cells are blocked |

### After (Current State)

| Aspect | New Behavior |
|--------|-------------|
| **Centerline calculation** | `(actualStartEdge + actualEndEdge) / 2` - midpoint between REAL geometry |
| **Facing sides** | Computed via `computeFacingSides()` based on spatial relationship |
| **Direction seeding** | ALWAYS seeds: anchored→outwardDir, inside→escape, outside→spatial |
| **Grid lines** | Facing sides MERGED into single centerline; only exterior sides kept |
| **Blocking** | Facing side cells blocked except anchor (stub effect) |
| **Segment checking** | **NOT YET IMPLEMENTED** - see next steps |

---

## Current Architecture

### File Structure

```
client/src/lib/connectors/
├── constants.ts       # SNAP_CONFIG, ROUTING_CONFIG, COST_CONFIG, offset helpers
├── shape-utils.ts     # Dir type, spatial helpers, classification functions
├── routing.ts         # Entry point: dispatches to Z-route or A*
├── routing-zroute.ts  # Simple HVH/VHV for free endpoints
├── routing-grid.ts    # Non-uniform grid construction with centerlines
└── routing-astar.ts   # A* pathfinding with direction seeding
```

### Routing Dispatch (`routing.ts`)

```typescript
if (!to.isAnchored) {
  return computeZRoute(from, to, strokeWidth);  // Free end → simple 3-segment
} else {
  return computeAStarRoute(from, to, strokeWidth);  // Snapped end → A* with obstacles
}
```

**Note:** Currently anchored→free uses Z-route. The segment intersection fix will change this to use A* when `from.shapeBounds` exists.

---

## Centerline System

### Facing Sides Concept

When two shapes are positioned relative to each other, certain sides "face" each other:

```
┌─────────┐                    ┌─────────┐
│  Start  │ ←── facing ───→   │   End   │
│  Shape  │    (these sides   │  Shape  │
└─────────┘     look at       └─────────┘
     ↑          each other)        ↑
   right                         left
   side                          side
```

The **centerline** is the midpoint between the actual shape edges (NOT padded boundaries).

### `computeFacingSides()` in `routing-grid.ts`

**Location:** Lines 104-187

**Purpose:** Compute which sides of two shapes face each other and calculate centerlines.

**Inputs:**
- `startBounds: AABB` - Start shape (or null for free endpoint)
- `endBounds: AABB` - End shape (or null for free endpoint)
- `approachOffset: number` - Padding distance

**Outputs:** `FacingSides` interface:
```typescript
interface FacingSides {
  // X-axis (vertical lines)
  startFacingX: number | null;   // Start shape's facing X (e.g., right padding)
  endFacingX: number | null;     // End shape's facing X (e.g., left padding)
  centerlineX: number | null;    // Midpoint between actual edges
  hasXCenterline: boolean;

  // Y-axis (horizontal lines)
  startFacingY: number | null;   // Start shape's facing Y
  endFacingY: number | null;     // End shape's facing Y
  centerlineY: number | null;    // Midpoint between actual edges
  hasYCenterline: boolean;
}
```

**Key insight:** Centerline uses ACTUAL shape edges, not padded boundaries:
```typescript
// For endIsRightOf case:
const actualStartEdge = startBounds.x + startBounds.w;  // Right edge (no padding)
const actualEndEdge = endBounds.x;                       // Left edge (no padding)
result.centerlineX = (actualStartEdge + actualEndEdge) / 2;  // TRUE midpoint
```

### `computeFacingSidesFromPoint()` in `routing-grid.ts`

**Location:** Lines 205-256

**Purpose:** Compute centerline from a FREE point to an ANCHORED shape. Used for free→anchored Z-route scenarios.

**Logic:**
- Only generates centerline when start is "beyond" the shape's facing side
- For horizontal anchor (E/W): check if point X is beyond the shape's padded X boundary
- For vertical anchor (N/S): check if point Y is beyond the shape's padded Y boundary

```typescript
// For anchor facing West:
const shapeFacingX = x - approachOffset;  // Left padding boundary
const startBeyondFacing = px < shapeFacingX;  // Point is further left

if (startBeyondFacing) {
  result.centerlineX = (px + x) / 2;  // Midpoint between point and actual edge
  result.hasXCenterline = true;
}
```

### Grid Line Merging

**Location:** `buildNonUniformGrid()` lines 518-556

When a centerline exists, the grid construction **merges** the two facing side lines into a single centerline:

```typescript
if (facing.hasXCenterline) {
  // MERGE: Use centerline instead of both facing sides
  xLines.push(facing.centerlineX!);

  // Add only the EXTERIOR (non-facing) side of end shape
  if (facing.endFacingX === x - approachOffset) {
    xLines.push(x + w + approachOffset);  // Right (exterior)
  } else {
    xLines.push(x - approachOffset);      // Left (exterior)
  }
} else {
  // No centerline: add both padding boundaries
  xLines.push(x - approachOffset, x + w + approachOffset);
}
```

**Why this works:** By removing the facing side lines and only keeping the centerline, A* is FORCED to use the centerline - there's no alternative path through the corridor.

---

## Facing Side Cell Blocking (Stub Effect)

### `blockFacingSideCells()` in `routing-grid.ts`

**Location:** Lines 386-422

**Purpose:** Block all cells along the facing side line EXCEPT the anchor cell. This creates a "stub" effect where routes can reach the anchor but cannot travel parallel along the facing side.

```
WITHOUT blocking:              WITH blocking:

[Start]→→→→→↓                  [Start]→→→→→→→→↓
            ↓                              ↓  (centerline)
     ↓←←←←←←↓ (hugging)                    ↓
     ↓                                     ↓
     ←←←[End]                              ←[End]  (stub)
```

**Implementation:**
```typescript
if (facing.hasXCenterline && facing.endFacingX !== null) {
  const xi = xLines.findIndex(x => Math.abs(x - facing.endFacingX!) < eps);
  if (xi >= 0) {
    for (let yi = 0; yi < yLines.length; yi++) {
      const cell = cells[yi][xi];
      // Don't block the goal cell itself
      if (Math.abs(cell.y - toApproach[1]) >= eps) {
        cell.blocked = true;
      }
    }
  }
}
```

---

## Direction Seeding System

### Always-On Seeding

**Location:** `computeAStarRoute()` lines 699-714

Direction is ALWAYS seeded, ensuring predictable routes regardless of cursor movement:

```typescript
let preferredFirstDir: Dir | null = null;

if (from.isAnchored) {
  // Anchored start: use outwardDir (fixed by shape attachment)
  preferredFirstDir = from.outwardDir;
} else if (startInsidePadding) {
  // Inside padded zone: use escape direction logic
  preferredFirstDir = computePreferredFirstDir(from.position, to);
} else {
  // Free start outside padding: compute based on spatial relationship
  preferredFirstDir = computeFreeStartDirection(from, to, strokeWidth);
}
```

### `computeFreeStartDirection()` in `routing-astar.ts`

**Location:** Lines 219-308

**Purpose:** Compute first direction for FREE endpoints based on spatial relationship to target shape (NOT cursor drag direction).

**Three cases:**

1. **SAME SIDE (Z-route possible)**
   - Start is on same side as anchor's OPPOSITE (e.g., start LEFT of shape, anchor WEST)
   - Z-route only valid when primary axis matches anchor axis
   - Otherwise: L-route on perpendicular axis

2. **OPPOSITE SIDE (wrap around)**
   - Start is on same side AS the anchor (e.g., start LEFT, anchor EAST - behind shape)
   - If contained in padded bounds: wrap around via shortest path (N or S)

3. **ADJACENT SIDE (L-route)**
   - Go directly toward anchor
   - Check for sliver escape first

### `computeSliverZoneEscape()` in `routing-astar.ts`

**Location:** Lines 161-201

**Purpose:** Handle "sliver zones" - when start is within the padded corridor on one axis but outside the shape.

```
       withinPaddedY but outside shape X
                    │
        ┌───────────▼───────────┐
        │   · · · · · · · · ·   │ ← padded Y boundary
        │   · ┌───────────┐ ·   │
        │   · │   SHAPE   │ ·   │
withinPaddedX → │           │ ← withinPaddedX
but outside   · │           │ ·   but outside
  shape Y     · └───────────┘ ·     shape Y
        │   · · · · · · · · ·   │
        └───────────────────────┘
```

**Logic:**
- If outside BOTH padded ranges: no escape needed (return null)
- If in a sliver zone: escape OUTWARD on the axis where we're outside the shape
- Priority given based on anchor direction (horizontal anchor → prioritize horizontal escape)

**Critical fix:** Must return `null` only if BOTH axes are outside padded range. Previously would return null incorrectly for corner cases.

### `computePreferredFirstDir()` in `routing-astar.ts`

**Location:** Lines 88-142

**Purpose:** Compute escape direction when starting INSIDE the full padded region.

**Three sub-cases:**
1. **SAME SIDE**: Start in N padding → snap to N → escape N (away from shape)
2. **OPPOSITE SIDE**: Start in S padding → snap to N → go E/W toward target X
3. **ADJACENT SIDE**: Start in S padding → snap to W → go W directly

---

## Spatial Helpers (`shape-utils.ts`)

### `computeShapeToShapeSpatial()`

**Location:** Lines 256-274

Returns spatial relationship between two shapes using ACTUAL bounds (no padding):

```typescript
interface ShapeToShapeSpatial {
  endIsRightOf: boolean;   // end.x > start.x + start.w
  endIsLeftOf: boolean;    // end.x + end.w < start.x
  overlapX: boolean;       // neither right nor left
  endIsBelow: boolean;     // end.y > start.y + start.h
  endIsAbove: boolean;     // end.y + end.h < start.y
  overlapY: boolean;       // neither above nor below
}
```

### `computePointToShapeSpatial()`

**Location:** Lines 204-226

Returns spatial relationship between a point and a shape, including padded range checks:

```typescript
interface PointToShapeSpatial {
  pointIsLeftOf: boolean;
  pointIsRightOf: boolean;
  pointIsAbove: boolean;
  pointIsBelow: boolean;
  withinPaddedXRange: boolean;
  withinPaddedYRange: boolean;
}
```

---

## Current Cell Blocking Strategy

**Location:** `createCellGrid()` lines 296-371

### Dynamic Blocking (WILL BE SIMPLIFIED)

Currently uses two modes based on `startInsidePadding`:

1. **If starting inside padded region:** Block shape + strokeInflation only (smaller)
2. **Otherwise:** Block full padded bounds (larger)

### Why This Will Change

The segment intersection fix will simplify this:
- Only block cells strictly inside shape bounds + strokeInflation
- Remove the `startInsidePadding` conditional
- Segment intersection checks will prevent routes from crossing shapes

---

## Known Issues (To Be Fixed)

### 1. Segment Intersection Not Checked

**Problem:** A* only checks if cells are blocked. With sparse grids, routes can "jump over" shapes.

**Solution:** See `docs/SEGMENT_INTERSECTION_FIX_PLAN.md`

### 2. Only One Obstacle Supported

**Problem:** Only `to.shapeBounds` is used for blocking. `from.shapeBounds` is ignored.

**Solution:** Pass both shapes as obstacles to grid construction and A*.

### 3. Anchored→Free Uses Z-Route

**Problem:** When start is anchored, Z-route ignores the start shape obstacle.

**Solution:** Use A* when either endpoint has shapeBounds.

---

## Files Modified from Baseline

| File | Key Changes |
|------|-------------|
| `routing-astar.ts` | Added `computeFreeStartDirection()`, `computeSliverZoneEscape()`, always-on seeding |
| `routing-grid.ts` | Added `computeFacingSides()`, `computeFacingSidesFromPoint()`, `blockFacingSideCells()`, grid line merging |
| `shape-utils.ts` | Added `computeShapeToShapeSpatial()`, `computePointToShapeSpatial()`, classification helpers |
| `routing.ts` | Unchanged (dispatch logic) |
| `routing-zroute.ts` | Unchanged |
| `constants.ts` | Unchanged |

---

## Testing Scenarios

### Direction Seeding

1. **Free → Anchored (head-on, H-dominant):** Should Z-route (HVH) with centerline
2. **Free → Anchored (head-on, V-dominant):** Should L-route (V first)
3. **Free → Anchored (adjacent):** Should L-route directly toward anchor
4. **Free → Anchored (opposite, contained):** Should wrap around (N or S)
5. **Sliver zone start:** Should escape outward first

### Centerline Usage

1. **Anchored → Anchored (shapes separated):** Route should use centerline, not hug
2. **Free → Anchored (same side):** Route should use centerline for Z-route

### Stub Effect

1. **Anchored → Anchored:** Route should NOT travel parallel along facing side
2. **Free → Anchored:** Route should enter anchor cell perpendicular

---

## Next Session Tasks

See `docs/SEGMENT_INTERSECTION_FIX_PLAN.md` for full implementation details:

1. Add `segmentIntersectsAABB()` function
2. Pass obstacles array to A* algorithm
3. Check segment intersection in neighbor expansion loop
4. Support two obstacles (from.shapeBounds + to.shapeBounds)
5. Update routing dispatch for anchored→free
6. Add `computeFacingSidesToPoint()` for anchored→free centerlines
7. Simplify cell blocking (remove startInsidePadding conditional)
