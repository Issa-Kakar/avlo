# Connector Routing System - Complete Technical Reference

## Overview

The connector tool implements orthogonal (Manhattan) routing with centerline preference, shape snapping, and obstacle avoidance. Routes are aesthetically pleasing: they use centerlines between shapes rather than hugging one shape's edge.

**Design Principles:**
1. **Centerline routing** - Routes prefer the midpoint between facing shape sides
2. **Always-seed direction** - First move direction is always computed (no cursor-drag inference)
3. **Stub effect** - Routes approach anchors perpendicular, never parallel along facing sides
4. **Obstacle by construction** - Grid cells inside obstacles are blocked; A* never visits them
5. **Segment midpoint checking** - For sparse grids, prevents routes from "jumping over" shapes

---

## File Structure

```
client/src/lib/connectors/
├── constants.ts       # SNAP_CONFIG (screen px), ROUTING_CONFIG (world), COST_CONFIG (A*)
├── shape-utils.ts     # Dir type, spatial helpers, classification functions
├── snap.ts            # Shape snapping with edge detection and midpoint hysteresis
├── routing.ts         # Entry point: dispatches to Z-route or A*
├── routing-zroute.ts  # Simple HVH/VHV 3-segment routing for free endpoints
├── routing-grid.ts    # Non-uniform grid construction with centerlines
└── routing-astar.ts   # A* pathfinding with direction seeding

client/src/lib/tools/
└── ConnectorTool.ts   # Main tool implementing PointerTool interface

client/src/renderer/layers/
└── connector-preview.ts  # Preview rendering with rounded corners and arrows
```

---

## Core Data Structures

### Terminal (Endpoint Definition)
```typescript
interface Terminal {
  position: [number, number];   // World coordinates
  outwardDir: Dir;              // Direction extending from this point (N/E/S/W)
  isAnchored: boolean;          // Snapped to shape?
  hasCap: boolean;              // Has arrow cap? (affects offset)
  shapeBounds?: AABB;           // Shape bounds for obstacle blocking
  t?: number;                   // Edge position parameter (0-1)
}
```

### Dir (Cardinal Direction)
```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
```

### FacingSides (Centerline Computation)
```typescript
interface FacingSides {
  startFacingX: number | null;  // Start shape's facing X padding line
  endFacingX: number | null;    // End shape's facing X padding line
  centerlineX: number | null;   // Midpoint between ACTUAL edges (not padded)
  hasXCenterline: boolean;      // True if X centerline exists
  // Same for Y axis...
}
```

---

## Routing Dispatch (`routing.ts`)

```
computeRoute(from, to, prevSignature, strokeWidth)
├── Both free → computeZRoute()      (simple 3-segment, no obstacles)
├── Either anchored → computeAStarRoute()  (obstacle avoidance)
```

**Endpoint Combinations:**
| From | To | Algorithm | Obstacles |
|------|-----|-----------|-----------|
| Free | Free | Z-route | None |
| Free | Anchored | A* | to.shapeBounds |
| Anchored | Free | A* | from.shapeBounds |
| Anchored | Anchored | A* | Both shapes |

---

## Z-Routing (`routing-zroute.ts`)

Simple 3-segment routing when **both** endpoints are free. No obstacle avoidance needed.

**Route Shape:**
- **HVH** (horizontal exit): `from → midX → to` via horizontal-vertical-horizontal
- **VHV** (vertical exit): `from → midY → to` via vertical-horizontal-vertical

**Selection:** Based on `from.outwardDir`:
- E/W → HVH
- N/S → VHV

**Midpoint:** `(fromApproach + toApproach) / 2` on the appropriate axis.

---

## A* Routing (`routing-astar.ts`)

Used when **either** endpoint is anchored to a shape. Provides obstacle avoidance.

### Pipeline
1. **Compute approach points** - Offset from terminal based on cap and anchor status
2. **Compute goal position** - For anchored endpoints, at padding boundary intersection
3. **Collect obstacles** - Both `from.shapeBounds` and `to.shapeBounds`
4. **Check startInsidePadding** - Whether start is in the padded corridor
5. **Build non-uniform grid** - With centerlines and facing side blocking
6. **Find start/goal cells** - Nearest cells in grid
7. **Compute direction hints** - ALWAYS seed first direction
8. **Run A*** - With segment midpoint checking
9. **Assemble path** - `[from.position, ...gridPath, to.position]`
10. **Simplify** - Remove collinear points

### Approach Offset Formula
```
approachOffset = CORNER_RADIUS_W + MIN_STRAIGHT_SEGMENT_W + arrowLength(strokeWidth)
```
For strokeWidth 2: `24 + 0 + 10 = 34` world units

This ensures room for: arc corner, straight segment, and arrow head.

### Segment Midpoint Intersection Check

A* checks if each segment's **midpoint** is inside an obstacle. This prevents routes from "jumping over" shapes in sparse grids.

```typescript
// For each neighbor expansion:
const segmentBlocked = obstacles.some(obs =>
  segmentMidpointInObstacle(current.x, current.y, neighbor.x, neighbor.y, obs, strokeInflation)
);
if (segmentBlocked) continue; // Skip this neighbor
```

**Why midpoint, not full segment?**
- Full segment checks create false positives at boundaries (corner clipping)
- Midpoint is sufficient for H/V-only segments: if a segment crosses an obstacle, its midpoint is inside
- Midpoint naturally allows start/goal cells in padding corridors

---

## Grid Construction (`routing-grid.ts`)

### Grid Line Placement Philosophy

Lines exist only at meaningful routing positions:
- **Endpoint positions** (anchor or free point coordinates)
- **Padding boundaries** (shape edge + approachOffset)
- **Centerlines** (midpoint between facing shape edges)
- **Goal positions** (for cell finding)

### Facing Sides Computation

When two shapes face each other, we compute which sides "look at" each other:

```
┌─────────┐                    ┌─────────┐
│  Start  │ ←── facing ───→   │   End   │
│  Shape  │  (right faces     │  Shape  │
└─────────┘     left)          └─────────┘
```

**Key rule:** Centerline uses ACTUAL shape edges, not padded boundaries:
```typescript
// For endIsRightOf case:
const actualStartEdge = startBounds.x + startBounds.w;  // Right edge (no padding)
const actualEndEdge = endBounds.x;                       // Left edge (no padding)
result.centerlineX = (actualStartEdge + actualEndEdge) / 2;  // TRUE midpoint
```

### Three Facing Sides Functions

1. **`computeFacingSides(startBounds, endBounds, offset)`** - Anchored→Anchored
2. **`computeFacingSidesFromPoint(startPos, endBounds, anchorDir, offset)`** - Free→Anchored
3. **`computeFacingSidesToPoint(startBounds, endPos, startDir, offset, fromApproach)`** - Anchored→Free

### Centerline Only When Z-Route Valid

For Free→Anchored and Anchored→Free, centerline is only computed when:
1. Start/end is "beyond" the shape's padded facing side (same-side scenario)
2. Primary axis matches anchor axis (Z-route valid)

**Example:** Anchor is East, free point is to the right of shape
- If dominant axis is H (horizontal) → Z-route valid → create X centerline
- If dominant axis is V (vertical) → L-route needed → no centerline

```typescript
const primaryAxis: 'H' | 'V' = ax >= ay ? 'H' : 'V';
const zRouteValid = (startDirIsHorizontal && primaryAxis === 'H') ||
                    (!startDirIsHorizontal && primaryAxis === 'V');
```

### Grid Line Merging

When a centerline exists, facing side lines are **merged** into the single centerline:

```typescript
if (facing.hasXCenterline) {
  xLines.push(facing.centerlineX);       // Single centerline
  xLines.push(exteriorSideOnly);         // Only exterior (non-facing) side
} else {
  xLines.push(leftPadding, rightPadding); // Both padding boundaries
}
```

**Why this works:** By removing facing side lines, A* has no alternative but to use the centerline.

---

## Facing Side Cell Blocking (Stub Effect)

Cells along facing side lines are blocked **except** the anchor cell. This prevents routes from traveling parallel along facing sides.

```
WITHOUT blocking:              WITH blocking:
[Start]→→→→→↓                  [Start]→→→→→→→→↓
            ↓                              ↓  (centerline)
     ↓←←←←←←↓ (hugging)                    ↓
     ↓                                     ↓
     ←←←[End]                              ←[End]  (stub)
```

### Blocking Rules

| Scenario | What's Blocked |
|----------|----------------|
| `toHasShape` | Block `endFacingX/Y` except goal cell |
| `fromHasShape && toHasShape` | Also block `startFacingX/Y` except start cell |
| `fromHasShape && !toHasShape` (anchored→free) | Block `endFacingX/Y` (free point's line) to force Z-route |

**Anchored→Free Z-Route Forcing:**

Without special handling, A* chooses VH L-routes (1 bend) over VHV Z-routes (2 bends) due to bend penalty. Blocking `endFacingY` (goal's Y coordinate) except the goal cell forces the route through the centerline.

---

## Direction Seeding System

Direction is **ALWAYS** seeded - no cursor-drag inference for first direction.

### Three Cases

```typescript
if (from.isAnchored) {
  preferredFirstDir = from.outwardDir;           // Fixed by shape attachment
} else if (startInsidePadding) {
  preferredFirstDir = computePreferredFirstDir(from.position, to);  // Escape logic
} else {
  preferredFirstDir = computeFreeStartDirection(from, to, strokeWidth);  // Spatial
}
```

### `computeFreeStartDirection()` - Free Start Outside Padding

Three sub-cases based on spatial relationship:

**1. SAME SIDE (Z-route possible)**
- Start is on same side as anchor's OPPOSITE (e.g., start LEFT, anchor WEST)
- Z-route only valid when primary axis matches anchor axis
- Otherwise: L-route on perpendicular axis

**2. OPPOSITE SIDE (wrap around)**
- Start is on same side AS the anchor (e.g., start LEFT, anchor EAST - behind shape)
- If contained in padded bounds: wrap around via shortest path (N or S)

**3. ADJACENT SIDE (L-route)**
- Go directly toward anchor
- Check for sliver escape first

### `computePreferredFirstDir()` - Start Inside Padding

Three sub-cases:
1. **SAME SIDE**: In N padding → snap to N → escape N (away from shape)
2. **OPPOSITE SIDE**: In S padding → snap to N → go E/W toward target X
3. **ADJACENT SIDE**: In S padding → snap to W → go W directly

### `computeSliverZoneEscape()` - Sliver Zones

A "sliver zone" is when start is within padded range on one axis but outside the shape:

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

**Logic:** Escape OUTWARD on the axis where we're outside the shape, prioritizing based on anchor direction.

---

## Snapping System (`snap.ts`)

### Snap Target
```typescript
interface SnapTarget {
  shapeId: string;
  side: Dir;
  t: number;           // Position along edge (0-1, 0.5 = midpoint)
  isMidpoint: boolean;
  position: [number, number];
  isInside: boolean;
}
```

### Snap Priority (Nested Shapes)
1. Sort candidates by area ascending (smallest = most nested first)
2. Among equal-area, prefer higher z-order (ULID descending)
3. Pick first valid snap target

### Snap Modes

| Location | Behavior |
|----------|----------|
| Deep inside shape | Midpoints only (nearest of N/E/S/W) |
| Near edge | Snap to edge, midpoints are sticky |
| Outside edge radius | No snap |

### Midpoint Hysteresis
- **Snap in threshold:** 14px (enter midpoint lock)
- **Snap out threshold:** 20px (exit midpoint lock)
- Prevents jitter when cursor hovers near midpoint

### Shape-Type Awareness
- **rect/roundedRect:** Edge is the frame boundary
- **ellipse:** Closest point on ellipse perimeter, side determined by angle
- **diamond:** Four diagonal edges, mapped to N/E/S/W based on quadrant

---

## ConnectorTool (`ConnectorTool.ts`)

### State Machine
```typescript
type Phase = 'idle' | 'creating';
```

### Gesture Flow

```
idle:
  └─ Shows anchor dots on hovered shapes (via hoverSnap)
  └─ findBestSnapTarget() on every move

begin(pointerId, worldX, worldY):
  └─ Check snap at cursor
  ├─ Snap found: from = anchored terminal with shapeBounds
  └─ No snap: from = free terminal, outwardDir = 'E' (refined in move)
  └─ Initialize to = free terminal at same position
  └─ updateRoute()

move(worldX, worldY):
  └─ Check snap at cursor
  ├─ Snap found: to = anchored terminal with shapeBounds
  │   └─ dragDir reset to null
  └─ No snap: to = free terminal
      └─ Update dragDir via inferDragDirection()
      └─ If from is free: update from.outwardDir = dragDir
  └─ updateRoute()

end():
  └─ Commit if valid (dist > 5px, points >= 2)
  └─ resetState()
```

### Terminal Construction in updateRoute()

```typescript
// From terminal
const fromTerminal: Terminal = {
  position: this.from.position,
  outwardDir: this.from.outwardDir,
  isAnchored: this.from.isAnchored,
  hasCap: false,  // startCap = 'none'
  shapeBounds: fromShapeBounds,  // Fetched from snapshot if anchored
};

// To terminal (shapeBounds already set in move() for anchored)
const toTerminal: Terminal = {
  position: this.to.position,
  outwardDir: this.to.outwardDir,
  isAnchored: this.to.isAnchored,
  hasCap: true,  // endCap = 'arrow'
  shapeBounds: this.to.shapeBounds,
};
```

### Commit Schema
```typescript
connectorMap.set('fromX', fromX);
connectorMap.set('fromY', fromY);
connectorMap.set('toX', toX);
connectorMap.set('toY', toY);

// If anchored:
connectorMap.set('fromShapeId', shapeId);
connectorMap.set('fromSide', side);
connectorMap.set('fromT', t);

// Waypoints (intermediate points)
connectorMap.set('waypoints', routedPoints.slice(1, -1));

// Styling
connectorMap.set('color', color);
connectorMap.set('width', width);
connectorMap.set('endCap', 'arrow');
```

---

## Preview Rendering (`connector-preview.ts`)

### ConnectorPreview Interface
```typescript
interface ConnectorPreview {
  kind: 'connector';
  points: [number, number][];
  color, width, opacity: ...;
  startCap, endCap: 'none' | 'arrow';

  // Snap state (dots appear when snapped)
  snapShapeId: string | null;
  snapShapeFrame: [number, number, number, number] | null;
  snapShapeType: string | null;
  activeMidpointSide: Dir | null;

  // Endpoint states
  fromIsAttached, toIsAttached: boolean;
  fromPosition, toPosition: [number, number] | null;
  showCursorDot: boolean;
}
```

### Rendering Pipeline
1. **Compute end trim** - Where polyline stops for arrow head
2. **Draw rounded polyline** - `arcTo` for corners, clamped radius
3. **Draw arrow heads** - Filled triangles at original positions
4. **Draw shape anchor dots** - 4 midpoints, blue when active
5. **Draw endpoint dots** - Blue if attached, white if free

### Polyline Trim for Arrows

The polyline is trimmed before the arrow head to avoid overlap:
```typescript
const availableForTrim = segmentLength - actualCornerRadius;
const actualTrim = Math.min(arrowLength, availableForTrim);
```

The arrow head fills the gap between trimmed polyline and endpoint.

### Corner Radius Clamping
```typescript
const maxR = Math.min(cornerRadius, lenIn / 2, lenOut / 2);
if (maxR < 2) {
  ctx.lineTo(curr[0], curr[1]);  // Sharp corner
} else {
  ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);
}
```

---

## Constants (`constants.ts`)

### Screen-Space (CSS pixels)
```typescript
SNAP_CONFIG = {
  EDGE_SNAP_RADIUS_PX: 12,   // Snap to edge within this
  MIDPOINT_SNAP_IN_PX: 14,   // Enter midpoint lock
  MIDPOINT_SNAP_OUT_PX: 20,  // Exit midpoint lock
  INSIDE_DEPTH_PX: 10,       // Force midpoint-only when deep inside
  DOT_RADIUS_PX: 7,          // Anchor dot size
  ENDPOINT_RADIUS_PX: 7,     // Endpoint dot size
}
```

### World-Space (world units)
```typescript
ROUTING_CONFIG = {
  CORNER_RADIUS_W: 24,       // Arc radius for rounded corners
  MIN_STRAIGHT_SEGMENT_W: 0, // Straight segment before arrow
  ARROW_LENGTH_FACTOR: 4,    // Arrow scales with stroke
  ARROW_WIDTH_FACTOR: 3,
  ARROW_MIN_LENGTH_W: 10,
  ARROW_MIN_WIDTH_W: 8,
}
```

### A* Costs
```typescript
COST_CONFIG = {
  BEND_PENALTY: 1000,        // Penalty per direction change
  // Other costs (CONTINUATION_BONUS, etc.) currently disabled
}
```

---

## Key Invariants

1. **Centerline uses actual edges** - Not padded boundaries
2. **Facing sides merged** - When centerline exists, grid has single centerline instead of two facing lines
3. **Z-route requires axis match** - Primary axis must match anchor axis
4. **Stubs via cell blocking** - Facing side cells blocked except anchor
5. **Midpoint check, not full segment** - For sparse grid obstacle detection
6. **Always seed direction** - No cursor-drag inference for anchored routing
7. **approachOffset = corner + straight + arrow** - Sufficient room for geometry
8. **Start/goal never blocked** - Even if inside obstacle inflation zone

---

## Testing Scenarios

### Z-Route Validation
1. **Free→Anchored (H-dominant, E anchor):** HVH with X centerline
2. **Free→Anchored (V-dominant, E anchor):** VH L-route (no centerline)
3. **Anchored→Free (N anchor, drag north, V-dominant):** VHV with Y centerline
4. **Anchored→Free (N anchor, drag east, H-dominant):** VH L-route

### Centerline Usage
1. **Anchored→Anchored (shapes separated):** Route uses centerline
2. **Shapes overlapping on one axis:** No centerline on that axis

### Stub Effect
1. Route should NOT travel parallel along facing side
2. Route should enter anchor perpendicular

### Obstacle Avoidance
1. **Anchored→Anchored:** Both shapes blocked, route wraps around
2. **Start inside padding:** Escapes correctly based on spatial relationship

---

## Known Limitations (Future Work)

1. **No sticky connectors** - Shapes move, connectors don't follow (yet)
2. **Start inside shape** - Behavior undefined (planned)
3. **"End inside padding" for same-side** - Edge case handling (planned)
4. **Code cleanup needed** - Utils extraction, AABB naming, function consolidation
