# Connector Tool - Slice 1 Implementation Plan

## Executive Summary

This document plans the **first incremental slice** of the connector tool implementation. The scope is:

1. **Drawing connectors** with orthogonal routing (start point → cursor/target)
2. **Shape hovering/snapping** with midpoint anchor dots
3. **Preview rendering** for both the connector line and anchor dots
4. **Committing** the connector to Y.Doc on pointer-up

**Out of scope for this slice:**
- SelectTool integration (dragging shapes updates connectors)
- Editing existing connectors (endpoint dragging)
- Connector endpoint preview dots when selected (that's SelectTool territory)
- Y.Array reverse mapping on shapes (`connectedConnectorIds`)
- Manual waypoint editing

---

## Part 1: Data Model

### 1.1 Y.Map Connector Schema

Based on the user's requirements and existing patterns, the connector Y.Map schema:

```typescript
// Stored in Y.Doc: root.objects.get(connectorId)
interface ConnectorYData {
  id: string;                           // ULID
  kind: 'connector';                    // ObjectKind discriminant

  // Explicit endpoint positions (ALWAYS stored)
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;

  // Optional anchor info (null for free endpoints)
  // If attached: shapeId + side + t
  fromShapeId?: string;                 // null = free endpoint
  fromSide?: 'N' | 'E' | 'S' | 'W';
  fromT?: number;                       // 0-1 along edge, 0.5 = midpoint

  toShapeId?: string;
  toSide?: 'N' | 'E' | 'S' | 'W';
  toT?: number;

  // Waypoints (intermediate points between from/to)
  // Derived from routing, auto-computed on commit
  // Format: [[x, y], [x, y], ...]
  // Full path reconstructed at render time: [from, ...waypoints, to]
  waypoints?: [number, number][];

  // Styling
  color: string;
  width: number;
  opacity: number;
  endCap: 'arrow' | 'none';             // Arrow at end (default: 'arrow')
  startCap: 'arrow' | 'none';           // Arrow at start (default: 'none')

  // Metadata
  ownerId: string;
  createdAt: number;

  // NOTE: Do NOT store 'points' array - it's redundant.
  // Full path = [fromX/fromY, ...waypoints, toX/toY]
  // Reconstruct at render time to avoid data duplication.
}
```

**Key decisions:**
1. **Always store fromX/fromY and toX/toY** - even when attached to shapes, we cache the computed world positions. This simplifies hit testing and bbox computation.
2. **Optional anchor metadata** - `fromShapeId/toShapeId` with side/t enables re-routing when shapes move.
3. **waypoints are derived** - computed by routing algorithm, stored for rendering. In "auto" mode, regenerated on shape move.

### 1.2 Local Tool State (Not in Y.Map)

```typescript
type Dir = 'N' | 'E' | 'S' | 'W';

// Terminal describes an endpoint during interaction
type Terminal =
  | { kind: 'world'; x: number; y: number; outDir?: Dir }  // Free endpoint
  | { kind: 'shape'; shapeId: string; side: Dir; t: number; isSnapped: boolean };

interface ConnectorToolState {
  phase: 'idle' | 'creating' | 'hovering';
  pointerId: number | null;

  // During creation
  from: Terminal | null;
  to: Terminal | null;

  // Live routing
  routedPoints: [number, number][];     // Full path including endpoints + waypoints
  prevRouteSignature: string | null;    // For stability ('HV', 'VHV', etc.)

  // Hover state (idle phase)
  hoverShapeId: string | null;
  hoverAttach: SnapTarget | null;       // Current snap candidate
  prevAttach: SnapTarget | null;        // Previous attach (for hysteresis)

  // Frozen settings (captured at begin())
  frozenColor: string;
  frozenWidth: number;
  frozenOpacity: number;
}
```

---

## Part 2: Enhanced ConnectorPreview Type

The existing `ConnectorPreview` in `types.ts` is too simple. We need to extend it to support anchor dot rendering:

```typescript
// In client/src/lib/tools/types.ts

interface ConnectorPreview {
  kind: 'connector';

  // Main connector path (world coords)
  points: [number, number][];

  // Styling
  color: string;
  width: number;
  opacity: number;
  startCap: 'arrow' | 'none';
  endCap: 'arrow' | 'none';

  // === Anchor visualization ===
  // DESIGN: These are ONLY set when actually snapped, not just hovering nearby.
  // If snapShapeId is set, the user WILL connect to this shape on release.

  // Shape we're snapped to (null = not snapped, dots won't show)
  snapShapeId: string | null;
  snapShapeFrame: [number, number, number, number] | null;  // [x, y, w, h]
  snapShapeType: string | null;  // 'rect' | 'ellipse' | 'diamond' for proper dot placement

  // Which midpoint is active (snapped to t=0.5)
  activeMidpointSide: 'N' | 'E' | 'S' | 'W' | null;

  // Source endpoint state (blue if attached, white if free)
  fromIsAttached: boolean;
  fromPosition: [number, number] | null;

  // Target endpoint state
  toIsAttached: boolean;
  toPosition: [number, number] | null;

  // During creation: show cursor dot?
  showCursorDot: boolean;

  bbox: null;  // Always null for overlay
}
```

---

## Part 3: Snapping System

### 3.1 Constants (Screen-Space Thresholds)

```typescript
// In new file: client/src/lib/connectors/constants.ts

/**
 * Screen-space snap thresholds.
 *
 * DESIGN DECISION: Anchor dots ONLY appear when snapping would occur.
 * No separate "hover preview" zone - if you see dots, you'll connect there.
 * This prevents the confusing UX of seeing dots but not actually snapping.
 */
export const SNAP_CONFIG = {
  /** Distance to snap to edge - dots appear within this radius */
  EDGE_SNAP_RADIUS_PX: 12,

  /** Distance to snap into midpoint (slightly larger than edge) */
  MIDPOINT_SNAP_IN_PX: 14,

  /** Distance to unstick from midpoint (hysteresis prevents jitter) */
  MIDPOINT_SNAP_OUT_PX: 20,

  /** Depth inside shape before forcing midpoint-only mode */
  INSIDE_DEPTH_PX: 8,

  /** Anchor dot visual radius */
  DOT_RADIUS_PX: 5,

  /** Connector endpoint handle radius */
  ENDPOINT_RADIUS_PX: 6,
};

/** Orthogonal routing config */
export const ROUTING_CONFIG = {
  /** Jetty length (stub before first turn) in world units */
  JETTY_PX: 16,

  /** Corner radius for arcTo rendering */
  CORNER_RADIUS_PX: 10,

  /** Dogleg offset when shapes are behind each other */
  DOGLEG_PX: 40,
};

// Convert screen px to world units
export function pxToWorld(px: number, scale: number): number {
  return px / scale;
}
```

### 3.2 Snap Target Type

```typescript
interface SnapTarget {
  shapeId: string;
  side: 'N' | 'E' | 'S' | 'W';
  t: number;                    // 0-1 along edge
  isMidpoint: boolean;          // true if snapped to t=0.5
  position: [number, number];   // World coords of snap point
  isInside: boolean;            // Cursor inside shape?
}
```

### 3.3 Shape Frame Utilities

```typescript
// In new file: client/src/lib/connectors/shape-utils.ts

import type { ObjectHandle } from '@avlo/shared';

type Dir = 'N' | 'E' | 'S' | 'W';

interface ShapeFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Extract frame from shape handle */
function getShapeFrame(handle: ObjectHandle): ShapeFrame | null {
  if (handle.kind !== 'shape' && handle.kind !== 'text') return null;
  const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
  if (!frame) return null;
  return { x: frame[0], y: frame[1], w: frame[2], h: frame[3] };
}

/** Get midpoint positions for all 4 edges */
function getMidpoints(frame: ShapeFrame): Record<Dir, [number, number]> {
  return {
    N: [frame.x + frame.w / 2, frame.y],
    E: [frame.x + frame.w, frame.y + frame.h / 2],
    S: [frame.x + frame.w / 2, frame.y + frame.h],
    W: [frame.x, frame.y + frame.h / 2],
  };
}

/** Get position along edge for given t */
function getEdgePosition(frame: ShapeFrame, side: Dir, t: number): [number, number] {
  const clampedT = Math.max(0, Math.min(1, t));
  switch (side) {
    case 'N': return [frame.x + frame.w * clampedT, frame.y];
    case 'S': return [frame.x + frame.w * clampedT, frame.y + frame.h];
    case 'W': return [frame.x, frame.y + frame.h * clampedT];
    case 'E': return [frame.x + frame.w, frame.y + frame.h * clampedT];
  }
}

/** Get outward direction vector for a side */
function getOutwardVector(side: Dir): [number, number] {
  switch (side) {
    case 'N': return [0, -1];
    case 'S': return [0, 1];
    case 'W': return [-1, 0];
    case 'E': return [1, 0];
  }
}

/** Get opposite direction */
function oppositeDir(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return map[dir];
}
```

### 3.4 Snap Computation Algorithm

```typescript
// In client/src/lib/connectors/snap.ts

import { SNAP_CONFIG, pxToWorld } from './constants';
import { getShapeFrame, getMidpoints, getEdgePosition } from './shape-utils';
import { pointInRect, pointInDiamond } from '@/lib/geometry/hit-test-primitives';
import { useCameraStore } from '@/stores/camera-store';
import { getCurrentSnapshot } from '@/canvas/room-runtime';

interface SnapContext {
  cursorWorld: [number, number];
  scale: number;
  prevAttach: SnapTarget | null;  // For hysteresis
}

/**
 * Find the best snap target among all shapes.
 * Uses spatial index for efficiency.
 *
 * PRIORITY LOGIC (matches SelectTool pattern):
 * 1. Sort candidates by area ascending (smallest = most nested first)
 * 2. Among equal-area candidates, prefer higher z-order (ULID descending)
 * 3. Pick the first valid snap target
 *
 * This ensures clicking inside nested shapes snaps to the inner one.
 */
function findBestSnapTarget(ctx: SnapContext): SnapTarget | null {
  const { cursorWorld, scale, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;

  // Query spatial index - use edge snap radius (NOT hover radius)
  // We only return a snap target if we'd actually snap, not just hover
  const edgeRadius = pxToWorld(SNAP_CONFIG.EDGE_SNAP_RADIUS_PX, scale);

  const snapshot = getCurrentSnapshot();
  const results = snapshot.spatialIndex.query({
    minX: cx - edgeRadius,
    minY: cy - edgeRadius,
    maxX: cx + edgeRadius,
    maxY: cy + edgeRadius,
  });

  // Filter to shapes and text only (connectable)
  const handles = results
    .map(entry => snapshot.objectsById.get(entry.id))
    .filter(h => h && (h.kind === 'shape' || h.kind === 'text'));

  if (handles.length === 0) return null;

  // Build candidates with area for sorting
  type Candidate = { handle: typeof handles[0]; frame: ShapeFrame; area: number };
  const candidates: Candidate[] = [];

  for (const handle of handles) {
    if (!handle) continue;
    const frame = getShapeFrame(handle);
    if (!frame) continue;
    candidates.push({ handle, frame, area: frame.w * frame.h });
  }

  // Sort by area ascending (smallest first), then ULID descending (topmost first)
  candidates.sort((a, b) => {
    if (a.area !== b.area) return a.area - b.area;  // Smallest first
    return a.handle!.id > b.handle!.id ? -1 : 1;    // Topmost first (higher ULID = newer)
  });

  // Find first valid snap (respects nesting order)
  for (const { handle, frame } of candidates) {
    if (!handle) continue;
    const shapeType = (handle.y.get('shapeType') as string) || 'rect';
    const snap = computeSnapForShape(handle.id, frame, shapeType, ctx);
    if (snap) return snap;
  }

  return null;
}

/**
 * Compute snap target for a single shape.
 * Implements the UX spec:
 * - Inside shape (deep): only midpoints
 * - Outside/near edge: snap to edge, midpoints are sticky
 *
 * SHAPE-TYPE AWARE: Handles rect, ellipse, diamond correctly.
 */
function computeSnapForShape(
  shapeId: string,
  frame: ShapeFrame,
  shapeType: string,
  ctx: SnapContext
): SnapTarget | null {
  const { cursorWorld, scale, prevAttach } = ctx;
  const [cx, cy] = cursorWorld;

  // Convert thresholds
  const edgeSnapW = pxToWorld(SNAP_CONFIG.EDGE_SNAP_RADIUS_PX, scale);
  const midInW = pxToWorld(SNAP_CONFIG.MIDPOINT_SNAP_IN_PX, scale);
  const midOutW = pxToWorld(SNAP_CONFIG.MIDPOINT_SNAP_OUT_PX, scale);
  const insideDepthW = pxToWorld(SNAP_CONFIG.INSIDE_DEPTH_PX, scale);

  // Check if inside shape (shape-type aware)
  const isInside = pointInsideShape(cx, cy, frame, shapeType);

  // Compute depth inside (approximate - use distance to nearest edge)
  let insideDepth = 0;
  if (isInside) {
    const edgeResult = findNearestEdgePoint(cx, cy, frame, shapeType);
    insideDepth = edgeResult?.dist ?? 0;
  }

  const forceMidpointsOnly = isInside && insideDepth > insideDepthW;

  // Get midpoints (on actual shape perimeter, not just frame corners)
  const midpoints = getShapeMidpoints(frame, shapeType);

  // Find nearest midpoint
  type DirType = 'N' | 'E' | 'S' | 'W';
  let nearestMidSide: DirType = 'N';
  let nearestMidDist = Infinity;
  for (const [side, pos] of Object.entries(midpoints) as [DirType, [number, number]][]) {
    const dist = Math.hypot(cx - pos[0], cy - pos[1]);
    if (dist < nearestMidDist) {
      nearestMidDist = dist;
      nearestMidSide = side;
    }
  }

  // CASE 1: Deep inside - only snap to midpoints
  if (forceMidpointsOnly) {
    return {
      shapeId,
      side: nearestMidSide,
      t: 0.5,
      isMidpoint: true,
      position: midpoints[nearestMidSide],
      isInside: true,
    };
  }

  // CASE 2: Outside or near edge - find nearest edge point
  const edgeSnap = findNearestEdgePoint(cx, cy, frame, shapeType);
  if (!edgeSnap || edgeSnap.dist > edgeSnapW) {
    // Too far from any edge
    return null;
  }

  // Check midpoint stickiness (hysteresis)
  const wasPreviouslyMidpoint =
    prevAttach?.shapeId === shapeId &&
    prevAttach?.isMidpoint &&
    prevAttach?.side === nearestMidSide;

  const distToNearestMid = nearestMidDist;
  const shouldStayMidpoint = wasPreviouslyMidpoint && distToNearestMid <= midOutW;
  const shouldEnterMidpoint = distToNearestMid <= midInW;

  if (shouldStayMidpoint || shouldEnterMidpoint) {
    return {
      shapeId,
      side: nearestMidSide,
      t: 0.5,
      isMidpoint: true,
      position: midpoints[nearestMidSide],
      isInside,
    };
  }

  // Snap to edge point (not midpoint)
  return {
    shapeId,
    side: edgeSnap.side,
    t: edgeSnap.t,
    isMidpoint: false,
    position: [edgeSnap.x, edgeSnap.y],
    isInside,
  };
}

/**
 * Check if point is inside shape (shape-type aware).
 * Reuses patterns from SelectTool's hit testing.
 */
function pointInsideShape(cx: number, cy: number, frame: ShapeFrame, shapeType: string): boolean {
  const { x, y, w, h } = frame;

  switch (shapeType) {
    case 'diamond': {
      const top: [number, number] = [x + w / 2, y];
      const right: [number, number] = [x + w, y + h / 2];
      const bottom: [number, number] = [x + w / 2, y + h];
      const left: [number, number] = [x, y + h / 2];
      return pointInDiamond(cx, cy, top, right, bottom, left);
    }

    case 'ellipse': {
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      if (rx < 0.001 || ry < 0.001) return false;
      const dx = (cx - ecx) / rx;
      const dy = (cy - ecy) / ry;
      return (dx * dx + dy * dy) <= 1;
    }

    case 'rect':
    case 'roundedRect':
    default:
      return pointInRect(cx, cy, x, y, w, h);
  }
}

/**
 * Get midpoints on actual shape perimeter (not just frame).
 * For rect: frame edge midpoints
 * For ellipse: points on ellipse at 0°, 90°, 180°, 270°
 * For diamond: diamond vertex midpoints (which are frame edge midpoints)
 */
function getShapeMidpoints(frame: ShapeFrame, shapeType: string): Record<'N' | 'E' | 'S' | 'W', [number, number]> {
  const { x, y, w, h } = frame;

  // For all current shape types, midpoints happen to be at frame edge centers
  // (ellipse at 0°/90°/180°/270° = frame edge centers)
  // (diamond vertices = frame edge centers)
  // (rect = frame edge centers)
  return {
    N: [x + w / 2, y],
    E: [x + w, y + h / 2],
    S: [x + w / 2, y + h],
    W: [x, y + h / 2],
  };
}

/**
 * Find nearest point on shape edge (shape-type aware).
 * Uses patterns from SelectTool's shapeEdgeHitTest.
 */
function findNearestEdgePoint(
  cx: number, cy: number,
  frame: ShapeFrame,
  shapeType: string
): { side: 'N' | 'E' | 'S' | 'W'; t: number; x: number; y: number; dist: number } | null {
  type DirType = 'N' | 'E' | 'S' | 'W';
  const { x, y, w, h } = frame;

  switch (shapeType) {
    case 'diamond': {
      // Diamond edges: top→right→bottom→left→top
      const top: [number, number] = [x + w / 2, y];
      const right: [number, number] = [x + w, y + h / 2];
      const bottom: [number, number] = [x + w / 2, y + h];
      const left: [number, number] = [x, y + h / 2];

      const edges: { side: DirType; p1: [number, number]; p2: [number, number] }[] = [
        { side: 'N', p1: left, p2: top },      // NW edge → treated as N
        { side: 'E', p1: top, p2: right },     // NE edge → treated as E
        { side: 'S', p1: right, p2: bottom },  // SE edge → treated as S
        { side: 'W', p1: bottom, p2: left },   // SW edge → treated as W
      ];

      return findNearestOnEdges(cx, cy, edges);
    }

    case 'ellipse': {
      // For ellipse: find closest point on perimeter
      const ecx = x + w / 2;
      const ecy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;

      if (rx < 0.001 || ry < 0.001) return null;

      // Angle from center to cursor
      const angle = Math.atan2((cy - ecy) / ry, (cx - ecx) / rx);

      // Point on ellipse at that angle
      const px = ecx + rx * Math.cos(angle);
      const py = ecy + ry * Math.sin(angle);
      const dist = Math.hypot(cx - px, cy - py);

      // Determine side based on angle
      let side: DirType;
      const normAngle = ((angle + Math.PI * 2) % (Math.PI * 2));
      if (normAngle < Math.PI / 4 || normAngle >= Math.PI * 7 / 4) {
        side = 'E';
      } else if (normAngle < Math.PI * 3 / 4) {
        side = 'S';
      } else if (normAngle < Math.PI * 5 / 4) {
        side = 'W';
      } else {
        side = 'N';
      }

      // t along that side (approximate - project onto side axis)
      let t = 0.5;
      if (side === 'N' || side === 'S') {
        t = (px - x) / w;
      } else {
        t = (py - y) / h;
      }

      return { side, t: Math.max(0, Math.min(1, t)), x: px, y: py, dist };
    }

    case 'rect':
    case 'roundedRect':
    default: {
      // Rectangle edges
      const edges: { side: DirType; p1: [number, number]; p2: [number, number] }[] = [
        { side: 'N', p1: [x, y], p2: [x + w, y] },
        { side: 'E', p1: [x + w, y], p2: [x + w, y + h] },
        { side: 'S', p1: [x, y + h], p2: [x + w, y + h] },
        { side: 'W', p1: [x, y], p2: [x, y + h] },
      ];

      return findNearestOnEdges(cx, cy, edges);
    }
  }
}

/** Helper: find nearest point among a list of edges */
function findNearestOnEdges(
  cx: number, cy: number,
  edges: { side: 'N' | 'E' | 'S' | 'W'; p1: [number, number]; p2: [number, number] }[]
): { side: 'N' | 'E' | 'S' | 'W'; t: number; x: number; y: number; dist: number } | null {
  type DirType = 'N' | 'E' | 'S' | 'W';
  let best: { side: DirType; t: number; x: number; y: number; dist: number } | null = null;

  for (const edge of edges) {
    const [x1, y1] = edge.p1;
    const [x2, y2] = edge.p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) continue;

    // Project cursor onto edge
    const t = Math.max(0, Math.min(1,
      ((cx - x1) * dx + (cy - y1) * dy) / (len * len)
    ));

    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const dist = Math.hypot(cx - px, cy - py);

    if (!best || dist < best.dist) {
      best = { side: edge.side, t, x: px, y: py, dist };
    }
  }

  return best;
}

export { findBestSnapTarget, computeSnapForShape, SnapTarget, pointInsideShape, getShapeMidpoints };
```

---

## Part 4: Orthogonal Routing Algorithm

### 4.1 Core Routing

```typescript
// In client/src/lib/connectors/routing.ts

import { ROUTING_CONFIG, pxToWorld } from './constants';
import { getOutwardVector, oppositeDir, getEdgePosition } from './shape-utils';
import type { ObjectHandle } from '@avlo/shared';
import { useCameraStore } from '@/stores/camera-store';
import { getCurrentSnapshot } from '@/canvas/room-runtime';

type Dir = 'N' | 'E' | 'S' | 'W';
type Axis = 'H' | 'V';

interface ResolvedEndpoint {
  anchor: [number, number];     // Actual endpoint position
  jetty: [number, number];      // Position after jetty offset
  outDir: Dir;                  // Direction pointing outward from endpoint
}

interface RouteResult {
  points: [number, number][];   // Full path including endpoints
  signature: string;            // e.g., 'H', 'HV', 'HVH'
}

/**
 * Compute orthogonal route between two endpoints.
 *
 * Algorithm:
 * 1. Resolve endpoint positions + directions
 * 2. Add jetty offsets
 * 3. Choose routing pattern (L, Z, or U)
 * 4. Return full path
 */
function computeRoute(
  from: { pos: [number, number]; dir: Dir },
  to: { pos: [number, number]; dir: Dir },
  prevSignature: string | null
): RouteResult {
  const scale = useCameraStore.getState().scale;
  const jettyW = pxToWorld(ROUTING_CONFIG.JETTY_PX, scale);
  const doglegW = pxToWorld(ROUTING_CONFIG.DOGLEG_PX, scale);

  // Compute jetty points
  const fromVec = getOutwardVector(from.dir);
  const toVec = getOutwardVector(to.dir);

  const fromJetty: [number, number] = [
    from.pos[0] + fromVec[0] * jettyW,
    from.pos[1] + fromVec[1] * jettyW,
  ];

  const toJetty: [number, number] = [
    to.pos[0] + toVec[0] * jettyW,
    to.pos[1] + toVec[1] * jettyW,
  ];

  // Generate route candidates between jetty points
  const candidates = generateRouteCandidates(fromJetty, toJetty, from.dir, to.dir, doglegW);

  // Pick best candidate (prefer fewer bends, shorter length, stability)
  const best = pickBestRoute(candidates, prevSignature);

  // Assemble full path: from → fromJetty → route → toJetty → to
  const fullPath: [number, number][] = [
    from.pos,
    fromJetty,
    ...best.midPoints,
    toJetty,
    to.pos,
  ];

  // Simplify: remove collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}

interface RouteCandidate {
  midPoints: [number, number][];
  bends: number;
  length: number;
  signature: string;
}

function generateRouteCandidates(
  s: [number, number],  // Start jetty
  t: [number, number],  // End jetty
  fromDir: Dir,
  toDir: Dir,
  dogleg: number
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  const fromH = fromDir === 'E' || fromDir === 'W';
  const toH = toDir === 'E' || toDir === 'W';

  // 1. Straight line (if aligned)
  if ((s[0] === t[0] && !fromH && !toH) || (s[1] === t[1] && fromH && toH)) {
    candidates.push({
      midPoints: [],
      bends: 0,
      length: Math.abs(s[0] - t[0]) + Math.abs(s[1] - t[1]),
      signature: fromH ? 'H' : 'V',
    });
  }

  // 2. L-route (single bend)
  // HV: horizontal first, then vertical
  candidates.push({
    midPoints: [[t[0], s[1]]],
    bends: 1,
    length: Math.abs(t[0] - s[0]) + Math.abs(t[1] - s[1]),
    signature: 'HV',
  });

  // VH: vertical first, then horizontal
  candidates.push({
    midPoints: [[s[0], t[1]]],
    bends: 1,
    length: Math.abs(t[0] - s[0]) + Math.abs(t[1] - s[1]),
    signature: 'VH',
  });

  // 3. Z-route (two bends) - HVH
  const midX = (s[0] + t[0]) / 2;
  candidates.push({
    midPoints: [[midX, s[1]], [midX, t[1]]],
    bends: 2,
    length: Math.abs(midX - s[0]) + Math.abs(t[1] - s[1]) + Math.abs(t[0] - midX),
    signature: 'HVH',
  });

  // 4. Z-route - VHV
  const midY = (s[1] + t[1]) / 2;
  candidates.push({
    midPoints: [[s[0], midY], [t[0], midY]],
    bends: 2,
    length: Math.abs(midY - s[1]) + Math.abs(t[0] - s[0]) + Math.abs(t[1] - midY),
    signature: 'VHV',
  });

  // 5. Dogleg routes (for when target is "behind" source)
  // HVH with offset
  candidates.push({
    midPoints: [[Math.max(s[0], t[0]) + dogleg, s[1]], [Math.max(s[0], t[0]) + dogleg, t[1]]],
    bends: 2,
    length: Infinity,  // Penalize
    signature: 'HVH+',
  });

  candidates.push({
    midPoints: [[Math.min(s[0], t[0]) - dogleg, s[1]], [Math.min(s[0], t[0]) - dogleg, t[1]]],
    bends: 2,
    length: Infinity,
    signature: 'HVH-',
  });

  return candidates;
}

function pickBestRoute(candidates: RouteCandidate[], prevSignature: string | null): RouteCandidate {
  // Score: lower is better
  // - Fewer bends is much better
  // - Shorter length is better
  // - Matching previous signature is slightly better (stability)

  return candidates.reduce((best, curr) => {
    const bestScore = scoreRoute(best, prevSignature);
    const currScore = scoreRoute(curr, prevSignature);
    return currScore < bestScore ? curr : best;
  });
}

function scoreRoute(route: RouteCandidate, prevSignature: string | null): number {
  let score = route.length;
  score += route.bends * 1000;  // Bend penalty dominates

  if (prevSignature && route.signature !== prevSignature) {
    score += 100;  // Stability penalty
  }

  return score;
}

function simplifyOrthogonal(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Check if collinear (all on same horizontal or vertical line)
    const sameX = prev[0] === curr[0] && curr[0] === next[0];
    const sameY = prev[1] === curr[1] && curr[1] === next[1];

    if (!sameX && !sameY) {
      result.push(curr);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

function computeSignature(points: [number, number][]): string {
  let sig = '';
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    if (Math.abs(dx) > Math.abs(dy)) {
      sig += 'H';
    } else if (Math.abs(dy) > Math.abs(dx)) {
      sig += 'V';
    }
  }
  // Deduplicate consecutive same chars
  return sig.replace(/(.)\1+/g, '$1');
}

export { computeRoute, RouteResult };
```

### 4.2 Direction Inference for Free Endpoints

When dragging to a free position (no shape snap), we infer the connector's entry direction:

```typescript
/**
 * Infer the entry direction for a free endpoint based on drag direction.
 * Uses hysteresis to prevent jitter.
 */
function inferDragDirection(
  from: [number, number],
  cursor: [number, number],
  prevDir: Dir | null,
  hysteresisRatio: number = 1.2
): Dir {
  const dx = cursor[0] - from[0];
  const dy = cursor[1] - from[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // Determine dominant axis
  let axis: 'H' | 'V';
  if (!prevDir) {
    axis = ax >= ay ? 'H' : 'V';
  } else {
    const prevH = prevDir === 'E' || prevDir === 'W';
    axis = prevH ? 'H' : 'V';

    // Check if we should switch (requires winning by hysteresis margin)
    if (prevH && ay > ax * hysteresisRatio) {
      axis = 'V';
    } else if (!prevH && ax > ay * hysteresisRatio) {
      axis = 'H';
    }
  }

  // Return direction based on axis and sign
  if (axis === 'H') {
    return dx >= 0 ? 'E' : 'W';
  } else {
    return dy >= 0 ? 'S' : 'N';
  }
}

export { computeRoute, RouteResult, inferDragDirection };
```

---

## Part 5: ConnectorTool Implementation

### 5.1 State Machine

```
                    ┌──────────────────────────────────────┐
                    │                                      │
    pointerdown     ▼                 pointerup            │
  ┌──────────────►CREATING────────────────────────────────┘
  │                 │
  │                 │ pointermove
  │                 ▼
IDLE◄──────────────CREATING (updating to position + routing)
  │
  │ pointermove (no gesture)
  ▼
HOVERING (show anchor dots on nearby shapes)
```

### 5.2 Full Implementation

```typescript
// client/src/lib/tools/ConnectorTool.ts

import type { PointerTool, PreviewData, ConnectorPreview } from './types';
import { useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { invalidateOverlay, holdPreviewForOneFrame } from '@/canvas/invalidation-helpers';
import { findBestSnapTarget, SnapTarget } from '@/lib/connectors/snap';
import { computeRoute, RouteResult } from '@/lib/connectors/routing';
import { getShapeFrame, getMidpoints, oppositeDir } from '@/lib/connectors/shape-utils';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { userProfileManager } from '@/lib/user-profile-manager';

type Dir = 'N' | 'E' | 'S' | 'W';

type Phase = 'idle' | 'creating';

interface Terminal {
  kind: 'world' | 'shape';
  x: number;
  y: number;
  dir: Dir;
  // Shape-specific
  shapeId?: string;
  side?: Dir;
  t?: number;
}

export class ConnectorTool implements PointerTool {
  private phase: Phase = 'idle';
  private pointerId: number | null = null;

  // Gesture state
  private from: Terminal | null = null;
  private to: Terminal | null = null;
  private routedPoints: [number, number][] = [];
  private prevRouteSignature: string | null = null;

  // Hover state (idle phase)
  private hoverSnap: SnapTarget | null = null;
  private prevSnap: SnapTarget | null = null;
  private dragDir: Dir | null = null;

  // Frozen settings
  private frozenColor: string = '#000000';
  private frozenWidth: number = 2;
  private frozenOpacity: number = 1;

  constructor() {}

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;

    this.pointerId = pointerId;
    this.phase = 'creating';

    // Freeze settings from store
    const settings = useDeviceUIStore.getState().drawingSettings;
    this.frozenColor = settings.color;
    this.frozenWidth = settings.size;
    this.frozenOpacity = settings.opacity;

    const scale = useCameraStore.getState().scale;

    // Check if starting on a shape
    const snap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: null,
    });

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
      // Free start point - default direction
      this.from = {
        kind: 'world',
        x: worldX,
        y: worldY,
        dir: 'E',  // Default, will be refined
      };
    }

    // Initialize 'to' at same position
    this.to = {
      kind: 'world',
      x: worldX,
      y: worldY,
      dir: 'W',  // Opposite of default from
    };

    this.dragDir = null;
    this.prevRouteSignature = null;
    this.updateRoute();

    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    const scale = useCameraStore.getState().scale;

    if (this.phase === 'idle') {
      // Hover mode - show anchor dots on nearby shapes
      const snap = findBestSnapTarget({
        cursorWorld: [worldX, worldY],
        scale,
        prevAttach: this.prevSnap,
      });

      this.hoverSnap = snap;
      this.prevSnap = snap;
      invalidateOverlay();
      return;
    }

    // Creating phase - update 'to' endpoint
    const snap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: this.prevSnap,
    });

    this.hoverSnap = snap;
    this.prevSnap = snap;

    if (snap) {
      // Snapped to shape
      this.to = {
        kind: 'shape',
        x: snap.position[0],
        y: snap.position[1],
        dir: oppositeDir(snap.side),  // Entry direction is opposite of side
        shapeId: snap.shapeId,
        side: snap.side,
        t: snap.t,
      };
      this.dragDir = null;  // Reset drag direction when snapped
    } else {
      // Free endpoint - infer direction from drag
      const fromPos: [number, number] = [this.from!.x, this.from!.y];
      const cursorPos: [number, number] = [worldX, worldY];

      this.dragDir = inferDragDirection(fromPos, cursorPos, this.dragDir);

      this.to = {
        kind: 'world',
        x: worldX,
        y: worldY,
        dir: oppositeDir(this.dragDir),  // Entry is opposite of travel direction
      };
    }

    this.updateRoute();
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (this.phase !== 'creating') {
      this.resetState();
      return;
    }

    // Commit connector to Y.Doc
    this.commitConnector();

    holdPreviewForOneFrame();
    this.resetState();
    invalidateOverlay();
  }

  cancel(): void {
    this.resetState();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    // Build ConnectorPreview
    const snapshot = getCurrentSnapshot();

    // Snap state (ONLY set when actually snapped - dots appear when snapped)
    let snapShapeId: string | null = null;
    let snapShapeFrame: [number, number, number, number] | null = null;
    let snapShapeType: string | null = null;

    if (this.hoverSnap) {
      const handle = snapshot.objectsById.get(this.hoverSnap.shapeId);
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          snapShapeId = this.hoverSnap.shapeId;
          snapShapeFrame = [frame.x, frame.y, frame.w, frame.h];
          snapShapeType = (handle.y.get('shapeType') as string) || 'rect';
        }
      }
    }

    return {
      kind: 'connector',
      points: this.routedPoints,
      color: this.frozenColor,
      width: this.frozenWidth,
      opacity: this.frozenOpacity,
      startCap: 'none',
      endCap: 'arrow',

      // Snap state (only set when actually snapped - dots appear when snapped)
      snapShapeId,
      snapShapeFrame,
      snapShapeType,
      activeMidpointSide: this.hoverSnap?.isMidpoint ? this.hoverSnap.side : null,

      // Endpoint states
      fromIsAttached: this.from?.kind === 'shape',
      fromPosition: this.from ? [this.from.x, this.from.y] : null,
      toIsAttached: this.to?.kind === 'shape',
      toPosition: this.to ? [this.to.x, this.to.y] : null,

      showCursorDot: this.phase === 'creating',

      bbox: null,
    } as ConnectorPreview;
  }

  onPointerLeave(): void {
    this.hoverSnap = null;
    this.prevSnap = null;
    invalidateOverlay();
  }

  onViewChange(): void {
    if (this.phase === 'creating') {
      this.updateRoute();
    }
    invalidateOverlay();
  }

  destroy(): void {
    this.cancel();
  }

  // === Private Methods ===

  private resetState(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.from = null;
    this.to = null;
    this.routedPoints = [];
    this.prevRouteSignature = null;
    this.dragDir = null;
    // Keep hoverSnap/prevSnap for hover behavior
  }

  private updateRoute(): void {
    if (!this.from || !this.to) {
      this.routedPoints = [];
      return;
    }

    // When snapped (L-case) vs free (drag direction)
    // L-case: Only use when BOTH endpoints are attached OR target is attached
    // This gives the "clean L" when you snap to a target

    const result = computeRoute(
      { pos: [this.from.x, this.from.y], dir: this.from.dir },
      { pos: [this.to.x, this.to.y], dir: this.to.dir },
      this.prevRouteSignature
    );

    this.routedPoints = result.points;
    this.prevRouteSignature = result.signature;
  }

  private commitConnector(): void {
    if (!this.from || !this.to || this.routedPoints.length < 2) return;

    const id = ulid();
    const userId = userProfileManager.getIdentity().userId;

    getActiveRoomDoc().mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const connectorMap = new Y.Map<unknown>();

      connectorMap.set('id', id);
      connectorMap.set('kind', 'connector');

      // Endpoint positions (always stored)
      connectorMap.set('fromX', this.from!.x);
      connectorMap.set('fromY', this.from!.y);
      connectorMap.set('toX', this.to!.x);
      connectorMap.set('toY', this.to!.y);

      // Anchor metadata (if attached)
      if (this.from!.kind === 'shape') {
        connectorMap.set('fromShapeId', this.from!.shapeId);
        connectorMap.set('fromSide', this.from!.side);
        connectorMap.set('fromT', this.from!.t);
      }

      if (this.to!.kind === 'shape') {
        connectorMap.set('toShapeId', this.to!.shapeId);
        connectorMap.set('toSide', this.to!.side);
        connectorMap.set('toT', this.to!.t);
      }

      // Waypoints (intermediate points, excluding endpoints)
      // Full path reconstructed at render time: [from, ...waypoints, to]
      if (this.routedPoints.length > 2) {
        const waypoints = this.routedPoints.slice(1, -1);
        connectorMap.set('waypoints', waypoints);
      }
      // NOTE: We do NOT store 'points' - reconstruct from endpoints + waypoints

      // Styling
      connectorMap.set('color', this.frozenColor);
      connectorMap.set('width', this.frozenWidth);
      connectorMap.set('opacity', this.frozenOpacity);
      connectorMap.set('endCap', 'arrow');
      connectorMap.set('startCap', 'none');

      // Metadata
      connectorMap.set('ownerId', userId);
      connectorMap.set('createdAt', Date.now());

      objects.set(id, connectorMap);
    });
  }
}
```

---

## Part 6: Preview Rendering

> **⚠️ COORDINATE SPACE CORRECTION (See CONNECTOR_TOOL_CHANGELOG.md)**
>
> The code samples below have been partially corrected. Key rules:
> - **Arrow heads, corner radius:** Use world-space constants from `ROUTING_CONFIG` directly (e.g., `ROUTING_CONFIG.ARROW_LENGTH_W`)
> - **Anchor/endpoint dots:** Use screen-space via `pxToWorld()` (UI affordances like selection handles)
>
> Match the pattern from `object-cache.ts` which uses `arrowLength = 10` (fixed world units).

### 6.1 New Connector Preview Layer

Create a new file for connector preview rendering:

```typescript
// client/src/renderer/layers/connector-preview.ts

import type { ConnectorPreview } from '@/lib/tools/types';
import { SNAP_CONFIG, ROUTING_CONFIG, pxToWorld } from '@/lib/connectors/constants';
import { getMidpoints } from '@/lib/connectors/shape-utils';

/**
 * Draw connector preview on overlay canvas.
 *
 * Handles:
 * 1. Main connector polyline with arcTo corners
 * 2. Arrow head at end
 * 3. Shape anchor dots (4 midpoints)
 * 4. Endpoint dots (blue if attached, white if free)
 */
export function drawConnectorPreview(
  ctx: CanvasRenderingContext2D,
  preview: ConnectorPreview,
  scale: number
): void {
  if (preview.points.length < 2) return;

  const {
    points,
    color,
    width,
    opacity,
    endCap,
    snapShapeFrame,
    snapShapeType,
    activeMidpointSide,
    fromIsAttached,
    toIsAttached,
    showCursorDot,
  } = preview;

  ctx.save();
  ctx.globalAlpha = opacity;

  // 1. Draw main polyline with rounded corners
  drawRoundedPolyline(ctx, points, color, width, scale);

  // 2. Draw arrow head at end
  if (endCap === 'arrow' && points.length >= 2) {
    drawArrowHead(ctx, points, color, scale);
  }

  ctx.restore();

  // 3. Draw shape anchor dots (ONLY when snapped - dots = will connect here)
  if (snapShapeFrame) {
    drawShapeAnchorDots(ctx, snapShapeFrame, snapShapeType || 'rect', activeMidpointSide, scale);
  }

  // 4. Draw endpoint dots
  if (preview.fromPosition) {
    drawEndpointDot(ctx, preview.fromPosition, fromIsAttached, scale);
  }
  if (preview.toPosition && showCursorDot) {
    drawEndpointDot(ctx, preview.toPosition, toIsAttached, scale);
  }
}

function drawRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  width: number,
  scale: number
): void {
  const cornerRadius = pxToWorld(ROUTING_CONFIG.CORNER_RADIUS_PX, scale);

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Compute available segment lengths
    const lenIn = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const lenOut = Math.hypot(next[0] - curr[0], next[1] - curr[1]);

    // Clamp radius to fit available space
    const maxR = Math.min(cornerRadius, lenIn / 2, lenOut / 2);

    if (maxR < 2) {
      // Too small for rounding
      ctx.lineTo(curr[0], curr[1]);
    } else {
      // Use arcTo for smooth corner
      ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);
    }
  }

  // Final segment
  ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
  ctx.stroke();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  scale: number
): void {
  const tip = points[points.length - 1];
  const prev = points[points.length - 2];

  // Arrow dimensions (screen-consistent)
  const arrowLengthW = pxToWorld(12, scale);
  const arrowWidthW = pxToWorld(8, scale) / 2;

  // Direction vector
  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;  // Perpendicular
  const py = ux;

  // Arrow base point
  const baseX = tip[0] - ux * arrowLengthW;
  const baseY = tip[1] - uy * arrowLengthW;

  // Arrow wing points
  const left: [number, number] = [baseX + px * arrowWidthW, baseY + py * arrowWidthW];
  const right: [number, number] = [baseX - px * arrowWidthW, baseY - py * arrowWidthW];

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(left[0], left[1]);
  ctx.lineTo(right[0], right[1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw anchor dots at shape midpoints.
 * For all shape types, midpoints are at frame edge centers:
 * - rect: edge midpoints
 * - ellipse: 0°/90°/180°/270° on ellipse = edge midpoints
 * - diamond: vertices are at edge midpoints
 */
function drawShapeAnchorDots(
  ctx: CanvasRenderingContext2D,
  frame: [number, number, number, number],
  _shapeType: string,  // Reserved for future shape-specific dot placement
  activeSide: 'N' | 'E' | 'S' | 'W' | null,
  scale: number
): void {
  const [x, y, w, h] = frame;
  const dotRadius = pxToWorld(SNAP_CONFIG.DOT_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(1.5, scale);

  // For all current shape types, midpoints are at frame edge centers
  // (This works for rect, ellipse at cardinal points, and diamond vertices)
  const midpoints: Record<'N' | 'E' | 'S' | 'W', [number, number]> = {
    N: [x + w / 2, y],
    E: [x + w, y + h / 2],
    S: [x + w / 2, y + h],
    W: [x, y + h / 2],
  };

  ctx.lineWidth = strokeWidth;

  for (const [side, pos] of Object.entries(midpoints) as ['N' | 'E' | 'S' | 'W', [number, number]][]) {
    const isActive = side === activeSide;

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], dotRadius, 0, Math.PI * 2);

    ctx.fillStyle = isActive ? 'rgba(59, 130, 246, 1)' : 'white';
    ctx.fill();

    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
    ctx.stroke();
  }
}

function drawEndpointDot(
  ctx: CanvasRenderingContext2D,
  position: [number, number],
  isAttached: boolean,
  scale: number
): void {
  const dotRadius = pxToWorld(SNAP_CONFIG.ENDPOINT_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(1.5, scale);

  ctx.beginPath();
  ctx.arc(position[0], position[1], dotRadius, 0, Math.PI * 2);

  ctx.fillStyle = isAttached ? 'rgba(59, 130, 246, 1)' : 'white';
  ctx.fill();

  ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}
```

### 6.2 Integrate into OverlayRenderLoop

Add connector preview handling to `OverlayRenderLoop.ts`:

```typescript
// In OverlayRenderLoop.ts, inside the preview switch/if block:

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

---

## Part 7: Shape Selection Highlight (No Handles)

When hovering a shape during connector creation, we want to highlight it like it's selected but **without resize handles**. The preview rendering already handles this via `hoverShapeFrame` - we draw the midpoint anchor dots which effectively highlight the shape.

For additional visual feedback (optional), we could add a subtle highlight stroke around the shape:

```typescript
// In drawShapeAnchorDots, before drawing dots:
// Draw subtle highlight around shape
ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
ctx.lineWidth = pxToWorld(2, scale);
ctx.strokeRect(x, y, w, h);
```

---

## Part 10: Key UX Behaviors

### Snapping Behavior
1. **Approach shape edge** → show 4 white midpoint dots
2. **Snap to edge** → endpoint dot turns blue, connector attaches
3. **Snap to midpoint** → that midpoint dot merges with endpoint (both blue)
4. **Drag away from midpoint** → stays attached until leaving `MIDPOINT_SNAP_OUT_PX` radius (hysteresis)
5. **Cursor deep inside shape** → only midpoints available (no edge snap)

### Routing Behavior
1. **Both endpoints attached** → L-route if favorable, Z-route otherwise
2. **Target attached, source free** → L-route preferred when entering attached edge
3. **Target free (dragging)** → infer direction from drag, use Z-route
4. **Stability** → prefer previous route signature to prevent jitter

### Visual Feedback
1. **White dot** = free endpoint
2. **Blue dot** = attached endpoint
3. **4 white dots on shape** = shape is snapped target (dots ONLY appear when snapped)
4. **1 blue + 3 white dots** = one midpoint is snapped
5. **Rounded corners** = exaggerated arcTo feel (10-12px radius)
6. **Filled arrow** = solid triangle at endpoint

---

## Part 11: Integration Notes

### Existing System Compatibility
- Uses same `PointerTool` interface as other tools
- Uses same `getActiveRoomDoc().mutate()` pattern
- Uses same `invalidateOverlay()` pattern
- Uses same coordinate conversion (`useCameraStore`, `worldToCanvas`)
- Uses same spatial index query pattern from SelectTool

### What's NOT Changing
- `tool-registry.ts` - ConnectorTool already registered
- `device-ui-store.ts` - 'connector' tool type already exists
- `object-cache.ts` - existing connector rendering works (just polyline + arrow)
- RBush spatial index - connector bbox computed same as stroke

### Dependencies
- `hit-test-primitives.ts` - reuse `pointInRect`
- `camera-store.ts` - `useCameraStore.getState().scale`
- `room-runtime.ts` - `getCurrentSnapshot()`, `getActiveRoomDoc()`
- `invalidation-helpers.ts` - `invalidateOverlay()`, `holdPreviewForOneFrame()`

---
