# Connector Tool Implementation Audit

**Date:** 2024-12-25
**Purpose:** Comprehensive technical audit of the current connector tool implementation for routing algorithm redesign planning.

---

## Changelog

### 2024-12-25: A* Manhattan Routing Redesign

**Files Added:**
- `routing-zroute.ts` - Simple 3-segment Z-routing for unsnapped endpoints
- `routing-grid.ts` - Non-uniform grid construction with obstacle blocking
- `routing-astar.ts` - A* pathfinding with direction seeding and cost function
- `CONNECTOR_ROUTING_REDESIGN.md` - Implementation plan document

**Files Modified:**
- `routing.ts` - Now dispatcher between Z-route and A* based on snap state
- `constants.ts` - Added `COST_CONFIG` and `OBSTACLE_PADDING_W`
- `ConnectorTool.ts` - Added `computeFromOutwardDirOnSnap()` for optimal direction

**Key Fixes:**

1. **Blocking Bug (toJetty was blocked):**
   - Root cause: `OBSTACLE_PADDING_W = 38` > `JETTY_W = 16`
   - The toJetty cell was inside the padded blocked zone
   - Fix: Block only shape interior, not padded region. Grid lines at padding for corridors.

2. **from.outwardDir Not Updated on Snap:**
   - Root cause: `from.outwardDir` kept old drag direction when snap occurred
   - Fix: Added `computeFromOutwardDirOnSnap()` to compute optimal direction

3. **from.outwardDir Direction Logic (Three Cases):**

   | Case | Condition | First Segment | Reason |
   |------|-----------|---------------|--------|
   | SAME SIDE | from on same side as snap | PERPENDICULAR (H for N/S) | No obstacle, align first |
   | OPPOSITE (beside) | from opposite, outside extent | PARALLEL (V for N/S) | Route around shape |
   | BEHIND SHAPE | from opposite, within extent | PERPENDICULAR | Can't go parallel, exit first |

**Known Issues (TODO):**
- **Padding/Offset:** Routes still hug shape frame too closely. Arrow tip overlaps route.
  - toJetty needs more offset (JETTY_W + ARROW_LENGTH + buffer)
  - Grid padding lines should enforce minimum distance from shape
- **A* vs Heuristic:** Could let A* choose first segment direction by including from.pos as a node

---

## Table of Contents

1. [File Structure Overview](#1-file-structure-overview)
2. [Data Model Analysis](#2-data-model-analysis)
3. [Snapping System (snap.ts)](#3-snapping-system-snapts)
4. [Routing Algorithm (routing.ts)](#4-routing-algorithm-routingts)
5. [ConnectorTool State Machine](#5-connectortool-state-machine)
6. [Preview Rendering Pipeline](#6-preview-rendering-pipeline)
7. [Coordinate Systems](#7-coordinate-systems)
8. [Routing Observations](#8-routing-observations)
9. [Data Flow Diagrams](#9-data-flow-diagrams)

---

## 1. File Structure Overview

```
client/src/lib/connectors/
├── constants.ts        # SNAP_CONFIG (screen-space) + ROUTING_CONFIG (world-space)
├── shape-utils.ts      # Dir type, ShapeFrame, edge/midpoint utilities
├── snap.ts             # findBestSnapTarget, computeSnapForShape, edge detection
├── routing.ts          # computeRoute, generateRouteCandidates, inferDragDirection
└── index.ts            # Re-exports

client/src/lib/tools/
├── types.ts            # ConnectorPreview interface
└── ConnectorTool.ts    # Main tool implementation

client/src/renderer/
├── OverlayRenderLoop.ts    # Integrates connector preview rendering
└── layers/
    └── connector-preview.ts # drawConnectorPreview, arrow heads, anchor dots
```

---

## 2. Data Model Analysis

### 2.1 ConnectorTool Internal State (Runtime Only)

```typescript
// Terminal interface - describes an endpoint during interaction
interface Terminal {
  kind: 'world' | 'shape';
  x: number;
  y: number;
  dir: Dir;  // 'N' | 'E' | 'S' | 'W'
  // Shape-specific (only when kind === 'shape')
  shapeId?: string;
  side?: Dir;
  t?: number;  // 0-1 along edge, 0.5 = midpoint
}

// Tool state
private phase: Phase = 'idle';           // 'idle' | 'creating'
private pointerId: number | null = null;
private from: Terminal | null = null;
private to: Terminal | null = null;
private routedPoints: [number, number][] = [];
private prevRouteSignature: string | null = null;
private hoverSnap: SnapTarget | null = null;
private prevSnap: SnapTarget | null = null;
private dragDir: Dir | null = null;
private frozenColor: string = '#000000';
private frozenWidth: number = 2;
private frozenOpacity: number = 1;
```

### 2.2 ConnectorPreview Interface (types.ts)

```typescript
interface ConnectorPreview {
  kind: 'connector';
  points: [number, number][];           // Full routed path
  color: string;
  width: number;
  opacity: number;
  startCap: 'arrow' | 'none';
  endCap: 'arrow' | 'none';

  // Snap visualization
  snapShapeId: string | null;
  snapShapeFrame: [number, number, number, number] | null;
  snapShapeType: string | null;
  activeMidpointSide: 'N' | 'E' | 'S' | 'W' | null;

  // Endpoint states
  fromIsAttached: boolean;
  fromPosition: [number, number] | null;
  toIsAttached: boolean;
  toPosition: [number, number] | null;
  showCursorDot: boolean;

  bbox: null;  // Always null for overlay previews
}
```

### 2.3 Y.Map Committed Data (What ConnectorTool.ts Writes)

```typescript
connectorMap.set('id', id);
connectorMap.set('kind', 'connector');
connectorMap.set('fromX', this.from.x);
connectorMap.set('fromY', this.from.y);
connectorMap.set('toX', this.to.x);
connectorMap.set('toY', this.to.y);

// Optional anchor metadata
if (this.from.kind === 'shape') {
  connectorMap.set('fromShapeId', this.from.shapeId);
  connectorMap.set('fromSide', this.from.side);
  connectorMap.set('fromT', this.from.t);
}
if (this.to.kind === 'shape') {
  connectorMap.set('toShapeId', this.to.shapeId);
  connectorMap.set('toSide', this.to.side);
  connectorMap.set('toT', this.to.t);
}

// Waypoints (NOT 'points')
if (this.routedPoints.length > 2) {
  const waypoints = this.routedPoints.slice(1, -1);
  connectorMap.set('waypoints', waypoints);
}

connectorMap.set('color', this.frozenColor);
connectorMap.set('width', this.frozenWidth);
connectorMap.set('opacity', this.frozenOpacity);
connectorMap.set('endCap', 'arrow');
connectorMap.set('startCap', 'none');
connectorMap.set('ownerId', userId);
connectorMap.set('createdAt', Date.now());
```

---

## 3. Snapping System (snap.ts)

### 3.1 Core Interfaces

```typescript
interface SnapTarget {
  shapeId: string;
  side: Dir;           // 'N' | 'E' | 'S' | 'W'
  t: number;           // 0-1 along edge
  isMidpoint: boolean; // true if snapped to t=0.5
  position: [number, number];
  isInside: boolean;
}

interface SnapContext {
  cursorWorld: [number, number];
  scale: number;
  prevAttach: SnapTarget | null;  // For hysteresis
}
```

### 3.2 findBestSnapTarget() Algorithm

1. Query spatial index with `EDGE_SNAP_RADIUS_PX` (12px screen-space)
2. Filter to shapes and text only (connectable objects)
3. Sort candidates by:
   - Area ascending (smallest first → nested shapes prioritized)
   - ULID descending (higher = newer = topmost)
4. Call `computeSnapForShape()` for each candidate until first valid snap

### 3.3 computeSnapForShape() Algorithm

**Thresholds (screen-space, converted via pxToWorld):**
- `EDGE_SNAP_RADIUS_PX`: 12px - Distance to snap to edge
- `MIDPOINT_SNAP_IN_PX`: 14px - Distance to enter midpoint snap
- `MIDPOINT_SNAP_OUT_PX`: 20px - Distance to exit midpoint snap (hysteresis)
- `INSIDE_DEPTH_PX`: 8px - Depth before forcing midpoint-only mode

**Logic flow:**
1. Check if cursor is inside shape (shape-type aware: rect/ellipse/diamond)
2. If deep inside (> `INSIDE_DEPTH_PX`): return nearest midpoint only
3. Find nearest edge point via `findNearestEdgePoint()`
4. If too far from edge (> `EDGE_SNAP_RADIUS_PX`): return null
5. Check midpoint hysteresis:
   - If previously on same midpoint and within `MIDPOINT_SNAP_OUT_PX`: stay on midpoint
   - If within `MIDPOINT_SNAP_IN_PX`: snap to midpoint
6. Otherwise: snap to edge point (not midpoint)

### 3.4 Shape-Specific Edge Detection

**Rectangle (`findNearestOnEdges`):**
- Projects cursor onto 4 edges (N/E/S/W)
- Returns closest edge point with side, t, position, distance

**Ellipse:**
- Uses `atan2` to find angle from center to cursor
- Computes point on ellipse perimeter at that angle
- Determines side based on angle quadrant (N/E/S/W)
- Approximates t by projecting onto side axis

**Diamond:**
- Defines 4 diagonal edges (NW→N, NE→E, SE→S, SW→W)
- Uses same `findNearestOnEdges` as rectangle

### 3.5 pointInsideShape() Implementation

```typescript
function pointInsideShape(cx, cy, frame, shapeType): boolean {
  switch (shapeType) {
    case 'diamond':
      return pointInDiamond(cx, cy, top, right, bottom, left);
    case 'ellipse':
      const dx = (cx - ecx) / rx;
      const dy = (cy - ecy) / ry;
      return dx * dx + dy * dy <= 1;
    case 'rect':
    case 'roundedRect':
    default:
      return pointInRect(cx, cy, x, y, w, h);
  }
}
```

---

## 4. Routing Algorithm (routing.ts)

### 4.1 Core Interfaces

```typescript
interface RouteResult {
  points: [number, number][];  // Full path
  signature: string;           // e.g., 'H', 'HV', 'HVH'
}

interface RouteEndpoint {
  pos: [number, number];
  dir: Dir;
  isAttached: boolean;
  shapeBounds?: { x, y, w, h };  // For self-intersection avoidance
}

interface RouteCandidate {
  midPoints: [number, number][];  // Between jetties
  bends: number;
  length: number;
  signature: string;
}
```

### 4.2 computeRoute() Algorithm

**Input:** `from: RouteEndpoint`, `to: RouteEndpoint`, `prevSignature: string | null`

**Steps:**

1. **Compute jetty points** (stubs extending from endpoints):
   ```typescript
   const jettyW = ROUTING_CONFIG.JETTY_W;  // 16 world units
   const fromJetty = from.pos + getOutwardVector(from.dir) * jettyW;
   const toJetty = to.pos + getOutwardVector(to.dir) * jettyW;
   ```

2. **Generate route candidates** between jetty points:
   - Straight (0 bends): Only if endpoints aligned on same axis
   - L-routes (1 bend): HV (horizontal then vertical), VH (vertical then horizontal)
   - Z-routes (2 bends): HVH, VHV (with midpoint at center)
   - Dogleg routes (2 bends): HVH+, HVH- (with offset beyond endpoints)

3. **Filter 1 - Free drag restriction:**
   - If `!to.isAttached`: Only allow 3-segment routes (HVH or VHV)
   - Chooses HVH if from.dir is horizontal, VHV if vertical

4. **Filter 2 - Self-intersection avoidance:**
   - If `to.shapeBounds` provided: Filter out routes that cross through target
   - Uses `pathCrossesRect()` to check each segment (skips final segment)

5. **Fallback:**
   - If all candidates filtered out: Generate dogleg candidates around shape bounds

6. **Pick best route:**
   - Score = `length + (bends * 1000) + (signature mismatch ? 100 : 0)`
   - Lower score wins

7. **Assemble and simplify:**
   ```typescript
   const fullPath = [from.pos, fromJetty, ...best.midPoints, toJetty, to.pos];
   const simplified = simplifyOrthogonal(fullPath);  // Remove collinear points
   ```

### 4.3 Route Candidate Generation Details

```typescript
function generateRouteCandidates(s, t, fromDir, toDir, dogleg): RouteCandidate[] {
  // s = start jetty, t = end jetty

  // 1. Straight (if aligned)
  if (aligned) { midPoints: [], bends: 0, signature: 'H' or 'V' }

  // 2. L-route HV
  { midPoints: [[t[0], s[1]]], bends: 1, signature: 'HV' }

  // 3. L-route VH
  { midPoints: [[s[0], t[1]]], bends: 1, signature: 'VH' }

  // 4. Z-route HVH
  const midX = (s[0] + t[0]) / 2;
  { midPoints: [[midX, s[1]], [midX, t[1]]], bends: 2, signature: 'HVH' }

  // 5. Z-route VHV
  const midY = (s[1] + t[1]) / 2;
  { midPoints: [[s[0], midY], [t[0], midY]], bends: 2, signature: 'VHV' }

  // 6. Dogleg HVH+ (offset right)
  { midPoints: [[max(s[0],t[0]) + dogleg, s[1]], [max(s[0],t[0]) + dogleg, t[1]]],
    bends: 2, length: Infinity, signature: 'HVH+' }

  // 7. Dogleg HVH- (offset left)
  { midPoints: [[min(s[0],t[0]) - dogleg, s[1]], [min(s[0],t[0]) - dogleg, t[1]]],
    bends: 2, length: Infinity, signature: 'HVH-' }
}
```

### 4.4 Self-Intersection Check (pathCrossesRect)

```typescript
function pathCrossesRect(path, rect, toJetty): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];

    // Skip final segment (toJetty → to.pos) - it's supposed to touch shape
    if (x1 === toJetty[0] && y1 === toJetty[1]) continue;

    // Vertical segment: X inside rect AND Y range crosses rect
    if (Math.abs(x1 - x2) < 0.001) {
      if (x1 > rect.x && x1 < rect.x + rect.w &&
          maxY > rect.y && minY < rect.y + rect.h) {
        return true;
      }
    }
    // Horizontal segment: Y inside rect AND X range crosses rect
    else {
      if (y1 > rect.y && y1 < rect.y + rect.h &&
          maxX > rect.x && minX < rect.x + rect.w) {
        return true;
      }
    }
  }
  return false;
}
```

### 4.5 inferDragDirection()

Used when endpoint is free (not snapped) to determine connector direction:

```typescript
function inferDragDirection(from, cursor, prevDir, hysteresisRatio = 1.2): Dir {
  const dx = cursor[0] - from[0];
  const dy = cursor[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // Determine dominant axis with hysteresis
  let axis: 'H' | 'V';
  if (!prevDir) {
    axis = ax >= ay ? 'H' : 'V';
  } else {
    const prevH = prevDir === 'E' || prevDir === 'W';
    axis = prevH ? 'H' : 'V';

    // Switch axis only if winning by hysteresis margin
    if (prevH && ay > ax * hysteresisRatio) axis = 'V';
    else if (!prevH && ax > ay * hysteresisRatio) axis = 'H';
  }

  return axis === 'H'
    ? (dx >= 0 ? 'E' : 'W')
    : (dy >= 0 ? 'S' : 'N');
}
```

### 4.6 Constants Used

```typescript
ROUTING_CONFIG = {
  JETTY_W: 16,           // World units - stub length before first turn
  CORNER_RADIUS_W: 8,    // World units - arcTo corner radius
  DOGLEG_W: 40,          // World units - offset when routing around shapes
  ARROW_LENGTH_FACTOR: 4,
  ARROW_WIDTH_FACTOR: 3,
  ARROW_MIN_LENGTH_W: 10,
  ARROW_MIN_WIDTH_W: 8,
}
```

---

## 5. ConnectorTool State Machine

### 5.1 Phases

```
IDLE ────────────────────────────────────────────────────────┐
  │                                                          │
  │ pointerdown (begin)                                      │
  ▼                                                          │
CREATING ──────────────────────────────────────────────────┐ │
  │                                                        │ │
  │ pointermove (move)                                     │ │
  │   └─ Update 'to' endpoint (snap or free)              │ │
  │   └─ Recompute route                                  │ │
  │   └─ invalidateOverlay()                              │ │
  │                                                        │ │
  │ pointerup (end)                                        │ │
  │   └─ commitConnector() if valid                       │ │
  │   └─ holdPreviewForOneFrame()                         │ │
  │   └─ resetState()                                      │ │
  └────────────────────────────────────────────────────────┘ │
                                                             │
  cancel()                                                   │
    └─ resetState() ─────────────────────────────────────────┘
```

### 5.2 begin() Implementation

```typescript
begin(pointerId, worldX, worldY) {
  // 1. Freeze settings from store
  const settings = useDeviceUIStore.getState().drawingSettings;
  this.frozenColor = settings.color;
  this.frozenWidth = settings.size;
  this.frozenOpacity = settings.opacity;

  // 2. Check if starting on a shape
  const snap = findBestSnapTarget({
    cursorWorld: [worldX, worldY],
    scale: useCameraStore.getState().scale,
    prevAttach: null,
  });

  // 3. Set 'from' terminal
  if (snap) {
    this.from = {
      kind: 'shape',
      x: snap.position[0],
      y: snap.position[1],
      dir: snap.side,  // Exit direction = the side
      shapeId: snap.shapeId,
      side: snap.side,
      t: snap.t,
    };
  } else {
    this.from = {
      kind: 'world',
      x: worldX,
      y: worldY,
      dir: 'E',  // Default direction
    };
  }

  // 4. Initialize 'to' at same position
  this.to = {
    kind: 'world',
    x: worldX,
    y: worldY,
    dir: 'W',  // Opposite of default 'from'
  };

  // 5. Compute initial route
  this.updateRoute();
  invalidateOverlay();
}
```

### 5.3 move() Implementation

```typescript
move(worldX, worldY) {
  const scale = useCameraStore.getState().scale;

  if (this.phase === 'idle') {
    // Hover mode - show anchor dots on nearby shapes
    this.hoverSnap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: this.prevSnap,
    });
    this.prevSnap = this.hoverSnap;
    invalidateOverlay();
    return;
  }

  // Creating phase
  const snap = findBestSnapTarget({...});
  this.hoverSnap = snap;
  this.prevSnap = snap;

  if (snap) {
    // Snapped to shape
    this.to = {
      kind: 'shape',
      x: snap.position[0],
      y: snap.position[1],
      dir: oppositeDir(snap.side),  // Entry direction
      shapeId: snap.shapeId,
      side: snap.side,
      t: snap.t,
    };
    this.dragDir = null;
  } else {
    // Free endpoint
    this.dragDir = inferDragDirection(
      [this.from.x, this.from.y],
      [worldX, worldY],
      this.dragDir
    );

    this.to = {
      kind: 'world',
      x: worldX,
      y: worldY,
      dir: oppositeDir(this.dragDir),
    };
  }

  this.updateRoute();
  invalidateOverlay();
}
```

### 5.4 updateRoute() Implementation

```typescript
private updateRoute() {
  if (!this.from || !this.to) {
    this.routedPoints = [];
    return;
  }

  // Get target shape bounds if snapped
  let toShapeBounds: {...} | undefined;
  if (this.to.kind === 'shape' && this.hoverSnap) {
    const handle = getCurrentSnapshot().objectsById.get(this.hoverSnap.shapeId);
    if (handle) {
      const frame = getShapeFrame(handle);
      if (frame) {
        toShapeBounds = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
      }
    }
  }

  const result = computeRoute(
    {
      pos: [this.from.x, this.from.y],
      dir: this.from.dir,
      isAttached: this.from.kind === 'shape',
    },
    {
      pos: [this.to.x, this.to.y],
      dir: this.to.dir,
      isAttached: this.to.kind === 'shape',
      shapeBounds: toShapeBounds,
    },
    this.prevRouteSignature
  );

  this.routedPoints = result.points;
  this.prevRouteSignature = result.signature;
}
```

### 5.5 getPreview() Implementation

Builds `ConnectorPreview` by:
1. Looking up `hoverSnap.shapeId` in snapshot to get frame/type
2. Setting snap visualization fields based on hoverSnap state
3. Setting endpoint attachment states from Terminal objects
4. Returning routedPoints as the path

---

## 6. Preview Rendering Pipeline

### 6.1 OverlayRenderLoop Integration (lines 328-338)

```typescript
} else if (previewToDraw?.kind === 'connector') {
  // Connector preview (world space)
  ctx.setTransform(
    vp.dpr * view.scale, 0,
    0, vp.dpr * view.scale,
    -view.pan.x * vp.dpr * view.scale,
    -view.pan.y * vp.dpr * view.scale
  );
  drawConnectorPreview(ctx, previewToDraw, view.scale);
}
```

### 6.2 connector-preview.ts Functions

**drawConnectorPreview():**
1. Draw main polyline with rounded corners (`drawRoundedPolyline`)
2. Draw arrow heads at endpoints (`drawArrowHead`)
3. Draw shape anchor dots if snapped (`drawShapeAnchorDots`)
4. Draw endpoint dots (`drawEndpointDot`)

**drawRoundedPolyline():**
```typescript
const cornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;  // 8 world units
ctx.beginPath();
ctx.moveTo(points[0][0], points[0][1]);

for (let i = 1; i < points.length - 1; i++) {
  const prev = points[i - 1];
  const curr = points[i];
  const next = points[i + 1];

  const lenIn = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
  const lenOut = Math.hypot(next[0] - curr[0], next[1] - curr[1]);
  const maxR = Math.min(cornerRadius, lenIn / 2, lenOut / 2);

  if (maxR < 2) {
    ctx.lineTo(curr[0], curr[1]);  // Sharp corner
  } else {
    ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);  // Rounded
  }
}

ctx.lineTo(last[0], last[1]);
ctx.stroke();
```

**drawArrowHead():**
```typescript
// Arrow size based on stroke width
const arrowLength = Math.max(ARROW_MIN_LENGTH_W, strokeWidth * ARROW_LENGTH_FACTOR);
const arrowWidth = Math.max(ARROW_MIN_WIDTH_W, strokeWidth * ARROW_WIDTH_FACTOR) / 2;

// Direction from second-to-last to last point
const dx = tip[0] - prev[0];
const dy = tip[1] - prev[1];
const len = Math.hypot(dx, dy);
const ux = dx / len;  // Unit vector
const uy = dy / len;
const px = -uy;  // Perpendicular
const py = ux;

// Arrow base point
const baseX = tip[0] - ux * arrowLength;
const baseY = tip[1] - uy * arrowLength;

// Arrow wing points
const left = [baseX + px * arrowWidth, baseY + py * arrowWidth];
const right = [baseX - px * arrowWidth, baseY - py * arrowWidth];

// Draw filled triangle
ctx.beginPath();
ctx.moveTo(tip[0], tip[1]);
ctx.lineTo(left[0], left[1]);
ctx.lineTo(right[0], right[1]);
ctx.closePath();
ctx.fill();
```

**drawShapeAnchorDots():**
- Draws 4 dots at frame edge midpoints (N/E/S/W)
- Active dot (snapped midpoint) is filled blue
- Other dots are white with blue stroke
- Dot size: `pxToWorld(DOT_RADIUS_PX, scale)` = 5px screen-space

**drawEndpointDot():**
- Blue fill if attached to shape, white if free
- Blue stroke always
- Size: `pxToWorld(ENDPOINT_RADIUS_PX, scale)` = 6px screen-space

---

## 7. Coordinate Systems

### 7.1 Screen-Space vs World-Space

| Constant Type | Space | Conversion | Purpose |
|---------------|-------|------------|---------|
| `SNAP_CONFIG.*` | Screen (px) | `pxToWorld(px, scale)` | Snap thresholds - consistent screen feel |
| `ROUTING_CONFIG.*_W` | World units | None | Permanent geometry in Y.Doc |
| Anchor dot sizes | Screen | `pxToWorld` | UI affordances |
| Arrow dimensions | World | None | Permanent geometry |

### 7.2 pxToWorld()

```typescript
function pxToWorld(px: number, scale: number): number {
  return px / scale;
}
```

This converts screen-space distances to world-space. Does not involve pan (translation-invariant).

### 7.3 Transform Applied in OverlayRenderLoop

```typescript
ctx.setTransform(
  vp.dpr * view.scale, 0,
  0, vp.dpr * view.scale,
  -view.pan.x * vp.dpr * view.scale,
  -view.pan.y * vp.dpr * view.scale
);
```

World coordinates are transformed to device pixels with DPR, scale, and pan applied.

---

## 8. Routing Observations

### 8.1 Routing Self-Intersection Check

**Current behavior:** `pathCrossesRect()` checks if segments cross through target shape interior.

**Issue:** The check is completely wrong, it never works. this could be from the jetty / endpoint coordination, or not recomputing the entire path vs the segmented approach, etc. many possibilities

### 8.2 Direction Assignment for 'from' Terminal

**Current:** When starting attached to shape, `from.dir = snap.side`
However: the jetty/connector routing arrow path is not aligned: the arrow direction during Z routing doesn't change the entire route, and thus the first segment and last segment are not updated when the arrow direction does.

---

## 9. Data Flow Diagrams

### 9.1 Preview Flow

```
User pointer event
    │
    ▼
CanvasRuntime.handlePointerMove(clientX, clientY)
    │
    ▼
screenToWorld(clientX, clientY) → (worldX, worldY)
    │
    ▼
connectorTool.move(worldX, worldY)
    │
    ├─► findBestSnapTarget() → SnapTarget | null
    │       │
    │       ▼
    │   computeSnapForShape() for each candidate
    │       │
    │       ▼
    │   findNearestEdgePoint() + midpoint hysteresis
    │
    ├─► Update this.to terminal (snapped or free)
    │
    ├─► inferDragDirection() if free
    │
    ├─► updateRoute()
    │       │
    │       ▼
    │   computeRoute(from, to, prevSignature)
    │       │
    │       ▼
    │   generateRouteCandidates(fromJetty, toJetty, ...)
    │       │
    │       ▼
    │   Filter candidates (free drag, self-intersection)
    │       │
    │       ▼
    │   pickBestRoute() → RouteResult
    │       │
    │       ▼
    │   simplifyOrthogonal() → routedPoints
    │
    └─► invalidateOverlay()

OverlayRenderLoop.frame()
    │
    ▼
getActivePreview() → ConnectorPreview
    │
    ▼
drawConnectorPreview(ctx, preview, scale)
    │
    ├─► drawRoundedPolyline()
    ├─► drawArrowHead()
    ├─► drawShapeAnchorDots()
    └─► drawEndpointDot()
```

### 9.2 Routing Decision Tree

```
computeRoute(from, to, prevSignature)
    │
    ▼
Generate 7 candidates:
    ├── Straight (if aligned)
    ├── HV (L-route)
    ├── VH (L-route)
    ├── HVH (Z-route)
    ├── VHV (Z-route)
    ├── HVH+ (dogleg right)
    └── HVH- (dogleg left)
    │
    ▼
if (!to.isAttached):
    Filter to only HVH or VHV (based on from.dir)
    │
    ▼
if (to.shapeBounds):
    Filter out routes where pathCrossesRect() returns true
    │
    ▼
if (candidates.length === 0):
    Generate dogleg candidates around shapeBounds
    │
    ▼
pickBestRoute(candidates, prevSignature)
    │
    ▼
Score = length + (bends * 1000) + (signature mismatch ? 100 : 0)
    │
    ▼
Return lowest-scored candidate
    │
    ▼
Assemble: [from.pos, fromJetty, ...midPoints, toJetty, to.pos]
    │
    ▼
simplifyOrthogonal() - remove collinear points
```

---

## Appendix A: Full File Listings

### A.1 Constants (constants.ts)

| Constant | Value | Space | Purpose |
|----------|-------|-------|---------|
| `EDGE_SNAP_RADIUS_PX` | 12 | Screen | Distance to snap to edge |
| `MIDPOINT_SNAP_IN_PX` | 14 | Screen | Distance to enter midpoint |
| `MIDPOINT_SNAP_OUT_PX` | 20 | Screen | Distance to exit midpoint |
| `INSIDE_DEPTH_PX` | 8 | Screen | Depth for midpoint-only mode |
| `DOT_RADIUS_PX` | 5 | Screen | Anchor dot visual radius |
| `ENDPOINT_RADIUS_PX` | 6 | Screen | Endpoint handle radius |
| `JETTY_W` | 16 | World | Stub length before first turn |
| `CORNER_RADIUS_W` | 8 | World | arcTo corner radius |
| `DOGLEG_W` | 40 | World | Offset for routing around shapes |
| `ARROW_LENGTH_FACTOR` | 4 | - | Arrow length = strokeWidth × factor |
| `ARROW_WIDTH_FACTOR` | 3 | - | Arrow width = strokeWidth × factor |
| `ARROW_MIN_LENGTH_W` | 10 | World | Minimum arrow length |
| `ARROW_MIN_WIDTH_W` | 8 | World | Minimum arrow width |

### A.2 Direction Utilities (shape-utils.ts)

| Function | Input | Output |
|----------|-------|--------|
| `getShapeFrame(handle)` | ObjectHandle | ShapeFrame \| null |
| `getMidpoints(frame)` | ShapeFrame | Record<Dir, [x,y]> |
| `getEdgePosition(frame, side, t)` | frame, side, t | [x, y] |
| `getOutwardVector(side)` | Dir | [dx, dy] unit vector |
| `oppositeDir(dir)` | Dir | opposite Dir |
| `isHorizontal(dir)` | Dir | boolean |
| `isVertical(dir)` | Dir | boolean |

---

## Changelog

### 2024-12-25: Direction Semantic Fixes (ConnectorTool.ts)

**Problem:** Three critical bugs caused incorrect routing and arrow direction.

**Fixes Applied:**

1. **Terminal Interface Refactor**
   - Renamed `dir` → `outwardDir` with clear semantic documentation
   - `outwardDir` = direction jetty extends (AWAY from shape)

2. **Critical Bug: `to.outwardDir` for Snapped Terminals (line 183)**
   - **Before:** `dir: oppositeDir(snap.side)` → toJetty extended INSIDE shape
   - **After:** `outwardDir: snap.side` → toJetty extends OUTSIDE shape
   - This was the root cause of routes passing through shapes

3. **Bug: `from.outwardDir` Never Updated During Drag (lines 196-199)**
   - **Added:** When dragging from free point, `from.outwardDir` now updates with `dragDir`
   - This fixes first segment not updating when direction changes during Z-route

**Result:** Free-drag Z-routing now works correctly. Snapped routing avoids shapes but needs A* implementation for optimal paths.

**Remaining Work:**
- A* Manhattan routing with non-uniform grid (obstacles excluded from grid, not filtered post-hoc)
- Arrow/path rendering: offset line behind arrow tip, smooth arc into arrow
- Arrow offset from shape boundary

---

*End of Audit Document*
