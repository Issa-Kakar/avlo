# Connector Tool Routing System - Technical Summary

## Overview

Orthogonal connector routing system using A* Manhattan pathfinding with non-uniform grids.
Two-mode dispatch: Z-routing (simple) for free unsnapped endpoints, A* (obstacle-aware) for anchored.

**Current Status**: Preview-only implementation. Only `free→anchored` routing works.
`anchored→free` and `anchored→anchored` NOT YET IMPLEMENTED.

---

## File Map (9 files)

```
client/src/lib/connectors/
├── routing.ts          (54L)   Main dispatch: Z-route vs A*
├── routing-astar.ts    (577L)  A* pathfinding, direction seeding, bend penalties
├── routing-grid.ts     (341L)  Non-uniform grid construction, dynamic blocking
├── routing-zroute.ts   (201L)  Simple HVH/VHV 3-segment paths
├── constants.ts        (222L)  Screen vs world constants, cost config
├── shape-utils.ts      (125L)  Dir type, frame extraction, midpoint helpers
├── snap.ts             (398L)  Snapping with hysteresis, spatial queries
└── index.ts            (51L)   Module exports

client/src/lib/tools/
└── ConnectorTool.ts    (432L)  Tool gesture handling, preview, commit

client/src/renderer/layers/
└── connector-preview.ts (363L) Overlay rendering: polyline, arrows, dots
```

---

## Core Data Types

### Terminal (routing endpoint)
```typescript
interface Terminal {
  position: [number, number];     // World coords
  outwardDir: Dir;                // N|E|S|W - jetty extends this way
  isAnchored: boolean;            // Snapped to shape?
  hasCap: boolean;                // Has arrow cap? (affects offset)
  shapeBounds?: AABB;             // For obstacle blocking
  t?: number;                     // Edge position 0-1 (hysteresis)
}
```

### GridCell
```typescript
interface GridCell {
  x: number;      // World X
  y: number;      // World Y
  xi: number;     // Grid index X
  yi: number;     // Grid index Y
  blocked: boolean; // Inside obstacle?
}
```

### AStarNode
```typescript
interface AStarNode {
  cell: GridCell;
  g: number;              // Cost from start
  h: number;              // Manhattan heuristic
  f: number;              // g + h
  parent: AStarNode | null;
  arrivalDir: Dir | null; // For bend penalty
}
```

---

## Routing Dispatch Logic

```
computeRoute(from, to, strokeWidth)
│
├─ if (!to.isAnchored):
│  └─ computeZRoute()     → Simple HVH/VHV (no obstacles)
│
└─ if (to.isAnchored):
   └─ computeAStarRoute() → Full A* with grid
```

**Current limitation**: Only dispatches on `to.isAnchored`. Start anchor logic incomplete.
**Current Implementation Status:**
- ✅ Free start → Free end: Z-route
- ✅ Free start → Anchored end: A* with single obstacle
- ⏳ Anchored start → Free end: Not Implemented, currently just Z-route (needs direction enforcement)
- ⏳ Anchored start → Anchored end: A* with TWO obstacles (not implemented)
---

## Z-Routing (Free Endpoints)

Used when cursor NOT snapped. Simple 3-segment path:

```
Horizontal exit (E/W) → HVH:
  [from] → [fromApproach] → [midX, fromY] → [midX, toY] → [toApproach] → [to]

Vertical exit (N/S) → VHV:
  [from] → [fromApproach] → [fromX, midY] → [toX, midY] → [toApproach] → [to]
```

**Midline calculation**: `(fromApproach + toApproach) / 2`

Drag direction inferred with hysteresis (1.05× margin to switch axis).

---

## A* Routing Pipeline

### Step 1: Compute Approach Points
```typescript
approachPoint = position + outwardVector × jettyOffset

jettyOffset = {
  !isAnchored: 0                              // Free endpoints
  isAnchored && !hasCap: CORNER_RADIUS (20)   // Anchored, no arrow
  isAnchored && hasCap: CORNER_RADIUS + MIN_STRAIGHT + arrowLength  // Full offset
}
```

### Step 2: Check Position Context
```typescript
startInsidePadding = isInsidePaddedRegion(from.position, to.shapeBounds)
// True if: inside padded AABB BUT outside shape bounds
// This is the "corridor zone" requiring special handling
```

### Step 3: Build Non-Uniform Grid

Grid lines placed at:
1. **From endpoint**: Approach point (single axis if anchored, both if free)
2. **To endpoint**: Anchor position + padding boundary intersection
3. **Obstacle bounds**: Full padding boundary lines (4 lines per shape)
4. **Midpoints**: `(fromApproach + toApproach) / 2` for flexibility

### Step 4: Create Cell Grid with Dynamic Blocking

```typescript
if (startInsidePadding) {
  // ESCAPE MODE: Small blocking (shape + stroke inflation)
  // Creates corridor between shape edge and padding boundary
  blockedBounds = shapeBounds + strokeWidth*0.5+1
} else {
  // NORMAL MODE: Full padded blocking
  blockedBounds = shapeBounds + approachOffset
}

// Cells STRICTLY inside blockedBounds are blocked
// Boundary cells are valid (routing corridor)
// Start/goal never blocked
```

### Step 5: Direction Seeding (Conditional)

```typescript
preferredFirstDir = {
  from.isAnchored: from.outwardDir                    // Always seed
  startInsidePadding: computePreferredFirstDir(...)   // Escape direction
  else: null                                          // Let A* decide
}
```

`computePreferredFirstDir` handles 3 cases:
- **Same side** (start N padding → snap N): Return N (escape outward)
- **Opposite side** (start S padding → snap N): Return E/W toward target X
- **Adjacent side** (start S padding → snap W): Return W (direct L-route)

### Step 6: Run A*

```typescript
while (!openSet.isEmpty()) {
  current = openSet.pop();
  if (current === goal) return reconstructPath();

  for (neighbor of getNeighbors(current)) {
    if (neighbor.blocked) continue;

    moveDir = getDirection(current, neighbor);
    moveCost = computeMoveCost(current, neighbor, arrivalDir, moveDir);

    // FIRST_DIR_BONUS: -500 if first move matches preferredFirstDir
    if (!parent && preferredFirstDir && moveDir === preferredFirstDir) {
      moveCost -= FIRST_DIR_BONUS;
    }

    // Update if better path found
    if (tentativeG < existingG) {
      openSet.push(neighborNode);
    }
  }
}
```

### Step 7: Simplify Path
Remove collinear intermediate points. Compute signature (HVH, VHV, HVHV, etc.).

---

## Cost Configuration

```typescript
COST_CONFIG = {
  BEND_PENALTY: 1000,           // Heavy penalty for turns
  CONTINUATION_BONUS: 10,       // Disabled 
  SHORT_SEGMENT_PENALTY: 50,    // Disabled currently
  APPROACH_MISMATCH_PENALTY: 2000,  // Disabled (creates weird routes)
  FIRST_DIR_BONUS: 500,         // Applied on first move if matches preference
}
```

**Key insight**: A* strongly prefers fewer turns.

---

## Offset Calculations (World Units)

```typescript
CORNER_RADIUS_W = 24           // Arc rendering radius
MIN_STRAIGHT_SEGMENT_W = 6     // Stroke straightens before arrow
ARROW_MIN_LENGTH_W = 10        // Minimum arrow length
ARROW_LENGTH_FACTOR = 4        // arrowLength = max(10, strokeWidth×4)

approachOffset = CORNER_RADIUS + MIN_STRAIGHT + arrowLength
               = 20 + 6 + max(10, strokeWidth×4)
               = 36-50 depending on strokeWidth (2-6)
```

---

## Grid Line Placement (Current)

For `free→anchored` routing:

```
X Lines:
├─ from.position[0]           (free start)
├─ to.position[0]             (anchor X)
├─ to.shapeBounds padding boundaries (left, right)
└─ midX = (fromApproach.x + toApproach.x) / 2

Y Lines:
├─ from.position[1]           (free start)
├─ goalY at padding boundary  (computed from to.outwardDir)
├─ to.shapeBounds padding boundaries (top, bottom)
└─ midY = (fromApproach.y + toApproach.y) / 2
```

**PROBLEM**: Midline is between approach points, not between FACING SIDES.
This is incorrect for centerline-preferring behavior.

---

## Tool Lifecycle (ConnectorTool.ts)

### State Machine
- `idle`: Hover mode, showing anchor dots on nearby shapes
- `creating`: Actively drawing from start to cursor/target

### begin(worldX, worldY)
1. Freeze settings (color, width, opacity)
2. Check for snap at cursor position
3. If snapped: Create anchored `from` terminal
4. If free: Create free `from` terminal (outwardDir=E default)
5. Initialize `to` at same position
6. Call `updateRoute()`

### move(worldX, worldY)
1. If idle: Update `hoverSnap` for dot preview
2. If creating: Update `to` terminal
   - If snapped: Set `to.shapeBounds`, `to.outwardDir = snap.side`
   - If free: Infer `dragDir`, update `from.outwardDir` for free starts
3. Call `updateRoute()`

### end()
1. Validate distance > 5 world units
2. Call `commitConnector()` → Y.Doc transaction
3. `holdPreviewForOneFrame()` → prevents flash
4. Reset state

---

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

### The Insight from NEW_PROMPT.MD

**Corridor segments vs wrap segments are different.**

```
[Start]→→→→↓
       A   ↓ B         ← CORRIDOR TRANSIT (has freedom)
           →→→→→↓ C    ← CORRIDOR TRANSIT
                ↓ D    ← WRAP SEGMENT (must hug)
                ↑ E
             [End]←
```

Segments B and C are in the **corridor** - they don't HAVE to hug.
Segment D is the **wrap** - it MUST use the far edge.

The centerline is only meaningful when a corridor exists.

---

# SUGGESTIONS FOR CENTERLINE BEHAVIOR

## Approach 1: Corridor Detection + Edge Cost Modifiers

### Step 1: Classify Spatial Relationship
```typescript
// Determine relative positions using padded bounds
const endIsRight = endBounds.left > startBounds.right;
const endIsLeft = endBounds.right < startBounds.left;
const overlapX = !endIsRight && !endIsLeft;

const endIsBelow = endBounds.top > startBounds.bottom;
const endIsAbove = endBounds.bottom < startBounds.top;
const overlapY = !endIsBelow && !endIsAbove;
```

### Step 2: Detect Corridor
```typescript
function detectCorridor(exitDir, enterDir, startBounds, endBounds) {
  // Corridor exists when there's a gap between FACING sides

  if (isHorizontal(exitDir)) {
    const facingStart = exitDir === 'E' ? startBounds.right + padding : startBounds.left - padding;
    const facingEnd = enterDir === 'W' ? endBounds.left - padding : endBounds.right + padding;
    const gap = Math.abs(facingEnd - facingStart);

    if (gap > MIN_CORRIDOR_WIDTH) {
      return {
        exists: true,
        axis: 'x',  // Vertical centerline
        facingStart,
        facingEnd,
        centerline: (facingStart + facingEnd) / 2
      };
    }
  }
  // Similar for vertical corridors...
}
```

### Step 3: Label Edges by Role
```typescript
type EdgeRole = 'CORRIDOR_CENTERLINE' | 'CORRIDOR_FACING' | 'WRAP_REQUIRED' | 'NORMAL';

function classifyEdgeRole(edge, corridor, wrapInfo) {
  if (!corridor.exists) return 'NORMAL';

  if (edge.isVertical && corridor.axis === 'x') {
    if (Math.abs(edge.x - corridor.centerline) < EPSILON) {
      return 'CORRIDOR_CENTERLINE';
    }
    if (edge.x === corridor.facingStart || edge.x === corridor.facingEnd) {
      return 'CORRIDOR_FACING';
    }
  }

  if (edge.x === wrapInfo.requiredLine) {
    return 'WRAP_REQUIRED';
  }

  return 'NORMAL';
}
```

### Step 4: Apply Cost Modifiers
```typescript
function getEdgeCost(edge, baseLength) {
  switch (edge.role) {
    case 'CORRIDOR_CENTERLINE':
      return baseLength * 0.5;   // Strong preference
    case 'CORRIDOR_FACING':
      return baseLength * 2.0;   // Discourage
    case 'WRAP_REQUIRED':
      return baseLength;         // Normal (it's necessary)
    default:
      return baseLength;
  }
}
```

---

## Approach 2: Dynamic AABB "Growing" Toward Centerline

Instead of standard grid, create **two dynamic AABBs** where facing sides "grow" to meet at centerline.

```
Standard Grid:           Dynamic Grid:

|     |  mid  |     |    |         mid         |
|start|       |end  |    |    ← facing sides   |
|pad  |       |pad  |    |      merged here    |

Start left, end right    Only centerline exists
facing lines separate    for vertical transit
```

### Implementation
```typescript
function buildDynamicGrid(from, to, corridor) {
  const xLines = [];

  if (corridor.exists && corridor.axis === 'x') {
    // DON'T add facing padding lines as through-routes
    // Only add centerline for vertical corridor transit
    xLines.push(corridor.centerline);

    // Still need wrap line if required
    if (wrapRequired) {
      xLines.push(wrapLine);
    }

    // Start position still needed as origin
    // But limit its connectivity
  } else {
    // No corridor - standard grid
    xLines.push(facingStart, facingEnd, ...);
  }
}
```

**Pros**: Guarantees centerline usage, simpler A*
**Cons**: Must ensure graph remains solvable, tricky edge connectivity

---

## Approach 3: Strategy Pre-Selection (Before A*)

Separate concerns:
1. **Topology selection** (before A*): "This is East→West opposing with corridor, use X-centerline"
2. **Path optimization** (during A*): Find shortest path using that topology

```typescript
function selectRoutingStrategy(from, to, startBounds, endBounds) {
  const dirRelation = classifyDirections(from.outwardDir, to.outwardDir);

  switch (dirRelation) {
    case 'OPPOSING_HORIZONTAL':
      if (hasCorridorAhead(from, to)) {
        return { type: 'CENTERLINE', axis: 'x', value: computeFacingCenterline() };
      }
      return { type: 'WRAP', side: pickWrapSide() };

    case 'SAME_DIRECTION':
      // No centerline useful, but corridor segments still exist
      return {
        type: 'WRAP',
        corridorPreference: 'CENTERLINE_WHERE_POSSIBLE'
      };

    case 'PERPENDICULAR':
      if (canDirectL(from, to)) {
        return { type: 'DIRECT_L' };
      }
      return { type: 'CENTERLINE', axis: pickBridgeAxis() };
  }
}
```

Then apply strategy to grid construction:
```typescript
if (strategy.type === 'CENTERLINE') {
  // Only include centerline for corridor axis
  // Remove/penalize facing lines
}
```

---

## Approach 4: Forced Waypoint (Simplest Conceptually)

When centerline strategy selected, route in two phases:

```typescript
if (strategy.type === 'CENTERLINE') {
  const waypoint = { x: centerline, y: (from.y + to.y) / 2 };

  const path1 = astar(start, waypoint);
  const path2 = astar(waypoint, goal);

  return concatenate(path1, path2);
}
```

**Pros**: Dead simple, guaranteed centerline usage
**Cons**: May create suboptimal paths, doesn't handle obstacle on centerline

---

## Recommended Architecture Refactor

### Unify Into Single Dense File
Current split is too fragmented. Combine into `routing-engine.ts`:

```typescript
// routing-engine.ts (~800 lines)
export {
  // Types
  Terminal, Grid, RoutingStrategy, EdgeRole,

  // Strategy selection
  classifyDirections,
  detectCorridor,
  selectRoutingStrategy,

  // Grid construction
  buildGrid,

  // A* core
  runAStar,

  // Main entry
  computeRoute
}
```

### Add Semantic Labels
```typescript
type DirRelation =
  | 'OPPOSING_HORIZONTAL'  // Exit E, Enter W (or vice versa)
  | 'OPPOSING_VERTICAL'    // Exit S, Enter N (or vice versa)
  | 'SAME_HORIZONTAL'      // Exit E, Enter E (wrap only required if aligned and overlapping directly )
  | 'SAME_VERTICAL'        // Exit S, Enter S
  | 'PERPENDICULAR';       // Exit E, Enter N (L possible)

type SpatialRelation =
  | 'END_RIGHT_OF_START'
  | 'END_LEFT_OF_START'
  | 'OVERLAP_X'
  | 'END_BELOW_START'
  | 'END_ABOVE_START'
  | 'OVERLAP_Y';
```

### Track Edge/Segment Information
Choose one approach:
- **Labeling**: Mark edges with roles, adjust costs in A*
- **Pruning**: Remove facing line edges when centerline alternative exists

---

## Implementation Priority

1. **Fix midline calculation**: Use facing sides, not approach points
2. **Add corridor detection**: Classify when centerline is meaningful
3. **Edge labeling**: CENTERLINE vs FACING vs WRAP
4. **Cost modifiers**: Prefer centerline, discourage facing lines
5. **Test anchor→anchor**: Need two obstacles in grid
6. **Semantic labels**: Make code readable (END_RIGHT, OPPOSING_HORIZONTAL, etc.)

---

## Key Insight Summary

**Centerline preference is about WHERE THE VERTICAL/HORIZONTAL TRANSIT HAPPENS, not about the total path shape.**

In corridor zones, we have freedom. In wrap zones, we don't.

The algorithm should:
1. Detect corridors (gaps between facing sides)
2. Identify which segments are corridor transit vs wrap
3. Apply centerline preference only to corridor segments
4. Let wrap segments hug as needed

This separation makes the problem tractable—we're not asking A* to discover aesthetics,
we're making them explicit through edge classification and cost modifiers.
