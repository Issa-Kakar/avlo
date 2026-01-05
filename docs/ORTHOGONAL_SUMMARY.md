# Orthogonal Connector Routing - Implementation Summary

## Current State Overview

The connector tool implements orthogonal (Manhattan) routing with A* pathfinding for shape-snapped endpoints and simple Z-routing for free endpoints. The system is designed for a whiteboard application with shapes that connectors can attach to.

---

## File Structure

```
client/src/lib/connectors/
├── index.ts           # Re-exports all public APIs
├── constants.ts       # SNAP_CONFIG (screen-space), ROUTING_CONFIG (world-space), COST_CONFIG (A*)
├── shape-utils.ts     # Dir type, ShapeFrame, midpoint/edge helpers
├── snap.ts            # Shape snapping with edge detection and midpoint hysteresis
├── routing.ts         # Dispatcher: Z-route vs A* based on to.isAnchored
├── routing-zroute.ts  # Simple HVH/VHV 3-segment routing for free endpoints
├── routing-grid.ts    # Non-uniform grid construction with dynamic blocking
└── routing-astar.ts   # A* Manhattan pathfinding with bend penalties

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
  outwardDir: Dir;              // Direction jetty extends (N/E/S/W)
  isAnchored: boolean;          // Snapped to shape?
  hasCap: boolean;              // Has arrow cap? (affects offset)
  shapeBounds?: AABB;           // Shape bounds for obstacle blocking
  t?: number;                   // Edge position parameter (0-1)
}
```

### GridCell
```typescript
interface GridCell {
  x, y: number;       // World coordinates
  xi, yi: number;     // Grid indices
  blocked: boolean;   // Inside obstacle? (not routable)
}
```

### Dir (Cardinal Direction)
```typescript
type Dir = 'N' | 'E' | 'S' | 'W';
```

---

## Routing Pipeline

### 1. Route Dispatch (`routing.ts`)
```
computeRoute(from, to, prevSignature, strokeWidth)
  └─► to.isAnchored ? computeAStarRoute() : computeZRoute()
```

### 2. Z-Routing (Free Endpoint)
Used when `to.isAnchored === false`. Creates simple 3-segment paths:
- **HVH**: Horizontal exit → Vertical middle → Horizontal entry (when from.outwardDir is E/W)
- **VHV**: Vertical exit → Horizontal middle → Vertical entry (when from.outwardDir is N/S)

Midpoint calculation: `midX = (fromApproach.x + toApproach.x) / 2`

### 3. A* Routing (Snapped Endpoint)

#### Grid Construction (`routing-grid.ts`)
Lines are placed at:
1. **From endpoint**: Single axis if anchored (perpendicular to exit), both if free
2. **To endpoint**: Fixed axis at anchor + padding boundary intersection
3. **Obstacle bounds**: Padding boundary lines (NOT shape edge lines)
4. **Midpoint**: Between approach points

**Current midpoint calculation** (ISSUE):
```typescript
const midX = (fromApproach[0] + toApproach[0]) / 2;
const midY = (fromApproach[1] + toApproach[1]) / 2;
```
This doesn't account for "facing sides" of shapes.

#### Dynamic Blocking
- **If start inside padded region**: Block only `shape + strokeInflation` (creates escape corridor)
- **Otherwise**: Block full `shape + approachOffset` (normal behavior)

Boundary cells are NOT blocked (valid routing corridor).

#### A* Search (`routing-astar.ts`)
```
Cost = manhattan(a, b) + BEND_PENALTY(if direction change) - CONTINUATION_BONUS(if same dir)
     + FIRST_DIR_BONUS (if matches preferredFirstDir at start)
```

**Direction Seeding** (conditional):
- Anchored start → use `from.outwardDir`
- Inside padding → compute escape direction based on spatial relationship
- Outside padding → null (let A* decide)

**Three seeding cases when inside padding:**
1. **SAME SIDE**: Start in N padding, snap to N → escape away (return N)
2. **OPPOSITE SIDE**: Start in S padding, snap to N → go E/W toward target X
3. **ADJACENT SIDE**: Start in S padding, snap to W → go directly toward target (W)

---

## Key Constants

### Routing Geometry (World Units - Permanent)
```typescript
CORNER_RADIUS_W: 24     // Arc radius for rounded corners
MIN_STRAIGHT_SEGMENT_W: 6 // Straight segment before arrow
ARROW_LENGTH_FACTOR: 4   // Arrow scales with stroke
```

**Approach Offset Formula:**
```
approachOffset = CORNER_RADIUS_W + MIN_STRAIGHT_SEGMENT_W + arrowLength(strokeWidth)
```
For strokeWidth 2: 20 + 6 + 10 = 36 world units

### A* Costs
```typescript
BEND_PENALTY: 1000       // Penalty per direction change
CONTINUATION_BONUS: 10   // Disabled
FIRST_DIR_BONUS: 500     // Bonus for preferred first direction
APPROACH_MISMATCH_PENALTY: 2000  // (DISABLED - creates weird routes)
```

---

## Current Implementation Gaps

### 1. No Centerline Preference
The A* algorithm minimizes bends but has no mechanism to prefer centerline paths over hugging paths. Given equal bend counts, the algorithm just picks shortest distance.

**Example**: Approaching head-on (Exit E, Enter W), both paths have same bends:
```
HUGGING PATH:           CENTERLINE PATH:
[Start]→↓              [Start]→→→↓
        ↓                        ↓
        →→→[End]                 →[End]
```
Currently no preference - whichever is encountered first wins.

### 2. Incorrect Midline Calculation
Current: `midX = (fromApproach[0] + toApproach[0]) / 2`

This is the midpoint between approach points, NOT the midpoint of the corridor between facing shape sides. For anchor-to-anchor routing, the true centerline should be:
```
centerlineX = (fromShape.right + toShape.left) / 2  // for Exit E, Enter W
```

### 3. No "Facing Sides" Concept
The code doesn't distinguish between:
- **Facing sides**: Shape edges that face each other (define the corridor)
- **Wrap sides**: Far edges needed for same-direction wrapping

### 4. Missing Anchor-to-Anchor Routing
Only `to.shapeBounds` is used for blocking. `from.shapeBounds` is collected but not utilized in grid construction.

### 5. No Segment Classification
All grid edges are treated equally. No distinction between:
- **Corridor transit segments** (can use centerline)
- **Wrap segments** (must hug shape)
- **Jetty segments** (fixed approach/exit)

### 6. Direction Forced Only for Start
Free starts use `inferDragDirection()` but the direction isn't "forced" - it's just a preference. For anchor-to-anchor, both endpoints need enforced directions.

---

## ConnectorTool State Machine

```
Phase: 'idle' | 'creating'

idle:
  - Shows anchor dots on nearby shapes
  - hoverSnap tracks current snap target

creating:
  - from: ToolTerminal (fixed at begin)
  - to: ToolTerminal (updates on move)
  - Calls updateRoute() on every move
  - Commits on end() if valid
```

### Gesture Flow
```
begin(worldX, worldY)
  └─► Check snap at cursor
      ├─► Snap found: from = anchored terminal
      └─► No snap: from = free terminal at cursor

move(worldX, worldY)
  └─► Check snap at cursor
      ├─► Snap found: to = anchored terminal with shapeBounds
      └─► No snap: to = free terminal, infer dragDir
  └─► updateRoute()

end()
  └─► Commit if valid (dist > 5px, points >= 2)
```

---

## Preview Rendering

The preview includes:
1. **Polyline**: Routed path with rounded corners via `arcTo()`
2. **Arrow head**: Filled triangle, size scales with strokeWidth
3. **Anchor dots**: Blue dots at shape midpoints (only when snapped)
4. **Endpoint dot**: Shows cursor position during creation

Corner radius adapts to available segment length:
```typescript
actualRadius = Math.min(CORNER_RADIUS_W, availableSpace / 2)
```

Arrow rendering trims the polyline by `arrowLength` before drawing the head.
## Preview Rendering Pipeline

```typescript
interface ConnectorPreview {
  kind: 'connector';
  points: [number, number][];      // Full routed path
  color, width, opacity: ...;
  startCap, endCap: 'none'|'arrow';

  // Snap state (dots appear when snapped)
  snapShapeId, snapShapeFrame, snapShapeType: ...;
  activeMidpointSide: Dir | null;

  // Endpoint states
  fromIsAttached, fromPosition: ...;
  toIsAttached, toPosition: ...;

  showCursorDot: boolean;
}
```

Rendering steps:
1. Draw rounded polyline (arcTo corners, radius=20)
2. Trim polyline for arrow caps (compute end trim)
3. Draw arrow heads (filled triangles)
4. Draw anchor dots (blue=snapped, white=free)
5. Draw endpoint dots

---

## Current Limitations

1. **Start anchor not implemented**: Only free→anchored works
2. **Anchor→anchor not implemented**: No two-shape obstacle handling
3. **Centerline never preferred**: Bend penalty dominates, hugging chosen over centerline
4. **Midline calculated wrong**: Uses approach points, not facing sides
5. **No segment classification**: Can't distinguish corridor vs wrap segments
6. **No sticky connectors**: Shapes move, connectors don't follow
---

## THE CENTERLINE PROBLEM

### Current Behavior
A* with bend penalty always chooses minimum-bend paths. This causes:
- Head-on opposing directions: Path hugs one obstacle instead of centerline
- Same-direction wraps: Goes down at start padding, not at midline
- No aesthetic preference for symmetric/balanced paths

### Why This Happens
The grid has lines at:
- Start padding boundary
- End padding boundary
- Midline (between approach points)

A* sees all vertical lines as equal cost for vertical segments.
With bend penalty, it takes the first opportunity to turn rather than
going further to reach the centerline.
