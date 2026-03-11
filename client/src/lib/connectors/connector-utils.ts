/**
 * Connector Utilities
 *
 * Provides:
 * - Shape frame extraction and midpoint calculation
 * - Direction helpers (isHorizontal, isVertical, oppositeDir)
 * - Bounds conversion utilities
 * - Direction resolution for free endpoints
 * - Path simplification utilities
 *
 * @module lib/connectors/connector-utils
 */

import type { FrameTuple, ObjectHandle, Snapshot } from '@avlo/shared';
import { getStart, getEnd, getStartAnchor, getEndAnchor, getFrame } from '@avlo/shared';
import { getTextFrame } from '@/lib/text/text-system';
import { getCodeFrame } from '@/lib/code/code-system';
import type { Dir, AABB, Bounds } from './types';
import { isAnchorInterior } from './types';
import { EDGE_CLEARANCE_W, computeApproachOffset } from './constants';

/**
 * Get midpoints for shape type (handles rounded diamond geometry).
 *
 * For rect/ellipse/roundedRect: frame edge centers
 * For diamond: visual apex of each rounded corner (accounts for corner radius)
 *
 * Diamond rendering uses arcTo with radius = min(20, min(w,h) * 0.1).
 * For stretched diamonds, the vertex angles become acute/obtuse, causing
 * the visual tip to be significantly inset from the mathematical vertex.
 *
 * @param frame - Frame tuple [x, y, w, h]
 * @param shapeType - Shape type ('rect', 'ellipse', 'diamond', etc.)
 * @returns Record mapping each direction to its midpoint [x, y]
 */
export function getShapeTypeMidpoints(
  frame: FrameTuple,
  shapeType: string,
): Record<Dir, [number, number]> {
  if (shapeType === 'diamond') {
    return getDiamondApexMidpoints(frame);
  }

  // rect, ellipse, roundedRect: frame edge centers (inlined getMidpoints)
  const [x, y, w, h] = frame;
  return {
    N: [x + w / 2, y],
    E: [x + w, y + h / 2],
    S: [x + w / 2, y + h],
    W: [x, y + h / 2],
  };
}

/**
 * Compute visual apex positions for a rounded diamond.
 *
 * For a rounded corner, the visual "tip" is the apex of the inscribed arc,
 * which is inset from the mathematical vertex by:
 *   d_apex = radius * (1/sin(halfAngle) - 1)
 *
 * where halfAngle is half the angle between the two edges meeting at the vertex.
 *
 * @param frame - Frame tuple [x, y, w, h]
 * @returns Midpoint positions at the visual apex of each rounded corner
 */
function getDiamondApexMidpoints(frame: FrameTuple): Record<Dir, [number, number]> {
  const [x, y, w, h] = frame;

  // Corner radius matches rendering in object-cache.ts
  const radius = Math.min(20, Math.min(w, h) * 0.1);

  // For very small radius, just use mathematical vertices (inlined getMidpoints)
  if (radius < 0.5) {
    return {
      N: [x + w / 2, y],
      E: [x + w, y + h / 2],
      S: [x + w / 2, y + h],
      W: [x, y + h / 2],
    };
  }

  // Mathematical vertices (frame edge centers)
  const cx = x + w / 2;
  const cy = y + h / 2;

  // Compute corner angles using dot product of edge vectors
  // At top/bottom: edges have slopes ±(h/2)/(w/2), giving cos(θ) = (h²-w²)/(h²+w²)
  // At left/right: edges have slopes ±(w/2)/(h/2), giving cos(θ) = (w²-h²)/(h²+w²)
  const h2 = h * h;
  const w2 = w * w;
  const sumSq = h2 + w2;

  // Top/Bottom vertex angle
  const cosTheta_TB = (h2 - w2) / sumSq;
  const theta_TB = Math.acos(Math.max(-1, Math.min(1, cosTheta_TB)));
  const halfTheta_TB = theta_TB / 2;

  // Left/Right vertex angle
  const cosTheta_LR = (w2 - h2) / sumSq;
  const theta_LR = Math.acos(Math.max(-1, Math.min(1, cosTheta_LR)));
  const halfTheta_LR = theta_LR / 2;

  // Apex offset = radius * (csc(halfAngle) - 1)
  // Clamp to prevent extreme values for very acute angles
  const sinHalf_TB = Math.sin(halfTheta_TB);
  const sinHalf_LR = Math.sin(halfTheta_LR);

  // Ensure sin values aren't too small (would cause huge offsets)
  const minSin = 0.1; // ~6° half-angle minimum
  const d_apex_TB = radius * (1 / Math.max(sinHalf_TB, minSin) - 1);
  const d_apex_LR = radius * (1 / Math.max(sinHalf_LR, minSin) - 1);

  // Clamp apex offset to reasonable bounds (at most radius * 2)
  const maxOffset = radius * 2;
  const offset_TB = Math.min(d_apex_TB, maxOffset);
  const offset_LR = Math.min(d_apex_LR, maxOffset);

  // Apex positions: vertex + offset toward center
  return {
    N: [cx, y + offset_TB], // top apex moves down
    E: [x + w - offset_LR, cy], // right apex moves left
    S: [cx, y + h - offset_TB], // bottom apex moves up
    W: [x + offset_LR, cy], // left apex moves right
  };
}

/**
 * Get opposite direction.
 *
 * @param dir - Input direction
 * @returns Opposite direction
 */
export function oppositeDir(dir: Dir): Dir {
  const map: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  return map[dir];
}

/**
 * Check if a direction is horizontal (E or W).
 *
 * @param dir - Direction to check
 * @returns true if horizontal
 */
export function isHorizontal(dir: Dir): boolean {
  return dir === 'E' || dir === 'W';
}

/**
 * Check if a direction is vertical (N or S).
 *
 * @param dir - Direction to check
 * @returns true if vertical
 */
export function isVertical(dir: Dir): boolean {
  return dir === 'N' || dir === 'S';
}

/**
 * Get unit vector for a cardinal direction.
 *
 * @param dir - Cardinal direction
 * @returns Unit vector [dx, dy] pointing in that direction
 */
export function directionVector(dir: Dir): [number, number] {
  switch (dir) {
    case 'N':
      return [0, -1];
    case 'E':
      return [1, 0];
    case 'S':
      return [0, 1];
    case 'W':
      return [-1, 0];
  }
}

// ============================================================================
// EDGE-BASED BOUNDS HELPERS
// ============================================================================

/**
 * Convert AABB {x,y,w,h} to edge-based Bounds.
 *
 * @param aabb - Shape bounds in x,y,w,h format
 * @returns Edge-based bounds
 */
export function toBounds(aabb: AABB): Bounds {
  return {
    left: aabb.x,
    top: aabb.y,
    right: aabb.x + aabb.w,
    bottom: aabb.y + aabb.h,
  };
}

/**
 * Create point-bounds where all edges converge to a single point.
 * Used for free (non-anchored) endpoints in routing context.
 *
 * @param pos - World position [x, y]
 * @returns Bounds collapsed to a point
 */
export function pointBounds(pos: [number, number]): Bounds {
  return {
    left: pos[0],
    top: pos[1],
    right: pos[0],
    bottom: pos[1],
  };
}

/**
 * Check if bounds is a point (all sides equal).
 * Point-bounds don't get padding applied - they stay at their position.
 *
 * @param b - Bounds to check
 * @returns true if all edges converge to a point
 */
export function isPointBounds(b: Bounds): boolean {
  return b.left === b.right && b.top === b.bottom;
}

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Remove collinear points from orthogonal path.
 *
 * For H/V-only paths, removes intermediate points that lie on the same
 * horizontal or vertical line as their neighbors.
 *
 * @param points - Input path
 * @returns Simplified path without collinear intermediate points
 */
export function simplifyOrthogonal(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Check if collinear (all on same horizontal or vertical line)
    const sameX = Math.abs(prev[0] - curr[0]) < 0.001 && Math.abs(curr[0] - next[0]) < 0.001;
    const sameY = Math.abs(prev[1] - curr[1]) < 0.001 && Math.abs(curr[1] - next[1]) < 0.001;

    if (!sameX && !sameY) {
      result.push(curr);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

/**
 * Compute route signature from simplified path.
 *
 * Encodes path as sequence of H (horizontal) and V (vertical) segments,
 * with consecutive duplicates removed. E.g., "HVH", "VHV", "HV".
 *
 * @param points - Simplified path points
 * @returns Signature string
 */
export function computeSignature(points: [number, number][]): string {
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
  return sig.replace(/(.)(\1)+/g, '$1');
}

// ============================================================================
// DIRECTION RESOLUTION FOR FREE ENDPOINTS
// ============================================================================

/**
 * Resolve start direction for FREE→ANCHORED cases.
 *
 * Computes direction from spatial relationship between free start point
 * and target shape anchor. All values computed ONCE for efficiency.
 *
 * Decision tree:
 * 1. Inside full padding: opposite wraps toward target, else escape (anchorDir)
 * 2. Same side: L-route checks sliver first, then Z/L both go toward shape
 * 3. Opposite + contained: wrap around via shape center
 * 4. Adjacent / opposite-clear: sliver escape, then anchorDir
 *
 * Key insight: Z-route and L-route return identical directions (toward shape
 * on primary axis). The only difference is L-route checks sliver escape first.
 *
 * @param fromPos - Start position (free endpoint)
 * @param toTerminal - Target info with position, outwardDir, and shapeBounds
 * @param strokeWidth - Connector stroke width
 * @returns Direction for from.outwardDir
 */
export function resolveFreeStartDir(
  fromPos: [number, number],
  toTerminal: { position: [number, number]; outwardDir: Dir; shapeBounds: AABB },
  strokeWidth: number,
): Dir {
  const { x, y, w, h } = toTerminal.shapeBounds;
  const [fx, fy] = fromPos;
  const [tx, ty] = toTerminal.position;
  const anchorDir = toTerminal.outwardDir;
  const offset = computeApproachOffset(strokeWidth);

  // Padded bounds
  const padLeft = x - offset;
  const padRight = x + w + offset;
  const padTop = y - offset;
  const padBottom = y + h + offset;

  // Position flags
  const leftOf = fx < x;
  const rightOf = fx > x + w;
  const above = fy < y;
  const below = fy > y + h;

  // Containment (strict for full padding, non-strict for sliver)
  const inPadX = fx > padLeft && fx < padRight;
  const inPadY = fy > padTop && fy < padBottom;
  const inShape = !leftOf && !rightOf && !above && !below;
  const inFullPad = inPadX && inPadY && !inShape;
  const nearX = fx >= padLeft && fx <= padRight;
  const nearY = fy >= padTop && fy <= padBottom;

  // Deltas and dominant axis
  const dx = tx - fx;
  const dy = ty - fy;
  const hDominant = Math.abs(dx) >= Math.abs(dy);
  const anchorIsH = anchorDir === 'E' || anchorDir === 'W';

  // Spatial relationship
  const sameSide =
    (anchorDir === 'N' && above) ||
    (anchorDir === 'S' && below) ||
    (anchorDir === 'E' && rightOf) ||
    (anchorDir === 'W' && leftOf);
  const oppSide =
    (anchorDir === 'N' && below) ||
    (anchorDir === 'S' && above) ||
    (anchorDir === 'E' && leftOf) ||
    (anchorDir === 'W' && rightOf);

  // Compute sliver escape ONCE (anchor axis determines check priority)
  let sliverDir: Dir | null = null;
  if (nearX || nearY) {
    if (anchorIsH) {
      if (leftOf && nearY) sliverDir = 'W';
      else if (rightOf && nearY) sliverDir = 'E';
      else if (above && nearX) sliverDir = 'N';
      else if (below && nearX) sliverDir = 'S';
    } else {
      if (above && nearX) sliverDir = 'N';
      else if (below && nearX) sliverDir = 'S';
      else if (leftOf && nearY) sliverDir = 'W';
      else if (rightOf && nearY) sliverDir = 'E';
    }
  }

  // === INSIDE FULL PADDING ===
  if (inFullPad) {
    if (oppSide) {
      // Wrap toward target position on perpendicular axis
      return !anchorIsH ? (fx < tx ? 'E' : 'W') : fy < ty ? 'S' : 'N';
    }
    return anchorDir; // same side or adjacent: escape outward
  }

  // === OUTSIDE FULL PADDING ===

  // Same side: L-route (axis mismatch) checks sliver, then both Z/L go toward shape
  if (sameSide) {
    if (anchorIsH !== hDominant && sliverDir) return sliverDir;
    return hDominant ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
  }

  // Opposite + contained: wrap around via shape center
  if (oppSide && nearX && nearY) {
    return anchorIsH ? (fy < y + h / 2 ? 'N' : 'S') : fx < x + w / 2 ? 'W' : 'E';
  }

  // Adjacent or opposite-not-contained: sliver escape, else anchorDir
  return sliverDir ?? anchorDir;
}

/**
 * Compute end direction for ANCHORED→FREE cases.
 *
 * Uses primary axis + sign from anchor position to free endpoint.
 * No hysteresis (unlike inferDragDirection).
 *
 * @param fromPos - Anchored snap position
 * @param toPos - Free cursor position
 * @returns Direction for to.outwardDir
 */
export function computeFreeEndDir(fromPos: [number, number], toPos: [number, number]): Dir {
  const dx = toPos[0] - fromPos[0];
  const dy = toPos[1] - fromPos[1];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const axis = ax >= ay ? 'H' : 'V';
  return axis === 'H' ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
}

/**
 * Infer drag direction for free endpoint.
 * Uses hysteresis to prevent jitter when cursor moves near axis boundaries.
 *
 * @param from - Start position
 * @param cursor - Current cursor position
 * @param prevDir - Previous direction (for hysteresis)
 * @param hysteresisRatio - Ratio required to switch axis (default 1.04)
 * @returns Inferred direction
 */
export function inferDragDirection(
  from: [number, number],
  cursor: [number, number],
  prevDir: Dir | null,
  hysteresisRatio: number = 1.04,
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
    const prevH = isHorizontal(prevDir);
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

// ============================================================================
// ANCHOR HELPERS
// ============================================================================

/**
 * Apply normalized anchor to frame, returning endpoint position with edge clearance.
 *
 * Normalized anchor [nx, ny] is in [0-1, 0-1] space relative to frame.
 * The edge position is computed, then offset outward by EDGE_CLEARANCE_W.
 *
 * Note: Uses EDGE_CLEARANCE_W only (not computeApproachOffset) because:
 * - The approach offset (CORNER_RADIUS + arrowLength + EDGE_CLEARANCE) is for A* grid
 * - Here we just need visual clearance from the shape edge
 *
 * @param anchor - Normalized anchor position [0-1, 0-1]
 * @param frame - Frame tuple [x, y, w, h]
 * @param side - Edge direction (determines offset direction)
 * @returns World position with edge clearance applied
 */
export function applyAnchorToFrame(
  anchor: [number, number],
  frame: FrameTuple,
  side: Dir,
): [number, number] {
  const [nx, ny] = anchor;
  const [x, y, w, h] = frame;
  const posX = x + nx * w;
  const posY = y + ny * h;

  // Interior anchors: return position directly (no edge offset)
  if (isAnchorInterior(anchor)) return [posX, posY];

  // Edge anchors: apply edge clearance offset in outward direction
  const [dx, dy] = directionVector(side);
  return [posX + dx * EDGE_CLEARANCE_W, posY + dy * EDGE_CLEARANCE_W];
}

/**
 * Get the ON-EDGE position for a connector endpoint (no clearance offset).
 *
 * For anchored endpoints: interpolates normalized anchor within the current shape frame.
 * For free endpoints: returns the stored position directly.
 *
 * This is used for:
 * - Endpoint dot rendering (dots appear ON the shape edge)
 * - Endpoint dot hit testing
 *
 * Unlike `applyAnchorToFrame`, this does NOT apply EDGE_CLEARANCE_W offset.
 *
 * @param handle - The connector's ObjectHandle
 * @param endpoint - Which endpoint ('start' or 'end')
 * @param snapshot - Current snapshot for shape frame lookup
 */
export function getEndpointEdgePosition(
  handle: ObjectHandle,
  endpoint: 'start' | 'end',
  snapshot: Snapshot,
): [number, number] {
  const yMap = handle.y;
  const storedPos = endpoint === 'start' ? getStart(yMap) : getEnd(yMap);
  const anchor = endpoint === 'start' ? getStartAnchor(yMap) : getEndAnchor(yMap);

  if (!anchor) {
    // Free endpoint: stored position IS the edge position
    return storedPos ?? [0, 0];
  }

  // Anchored: look up shape frame and interpolate normalized anchor
  const shapeHandle = snapshot.objectsById.get(anchor.id);
  if (!shapeHandle) return storedPos ?? [0, 0];

  const frame =
    shapeHandle.kind === 'text'
      ? getTextFrame(shapeHandle.id)
      : shapeHandle.kind === 'code'
        ? getCodeFrame(shapeHandle.id)
        : getFrame(shapeHandle.y);
  if (!frame) return storedPos ?? [0, 0];

  const [nx, ny] = anchor.anchor;
  const [x, y, w, h] = frame;
  return [x + nx * w, y + ny * h];
}

// ============================================================================
// SHAPE EDGE INTERSECTION (for straight connectors)
// ============================================================================

/**
 * Find where a ray from an interior point toward a target exits a convex shape.
 *
 * Used by straight connectors with interior anchors: the visible line stops at the
 * shape edge, and a dashed guide continues to the interior anchor.
 *
 * @returns Intersection point and side, or null if no valid intersection
 */
export function computeShapeEdgeIntersection(
  shapeType: string,
  frame: FrameTuple,
  interiorPoint: [number, number],
  target: [number, number],
): { point: [number, number]; side: Dir } | null {
  const [x, y, w, h] = frame;
  if (w < 0.001 || h < 0.001) return null;

  const [ix, iy] = interiorPoint;
  const dx = target[0] - ix;
  const dy = target[1] - iy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;

  switch (shapeType) {
    case 'ellipse':
      return rayEllipseIntersection(x, y, w, h, ix, iy, dx, dy);
    case 'diamond':
      return rayDiamondIntersection(x, y, w, h, ix, iy, dx, dy);
    default: // rect, roundedRect
      return rayRectIntersection(x, y, w, h, ix, iy, dx, dy);
  }
}

/** Ray vs axis-aligned rectangle. Take smallest positive t. */
function rayRectIntersection(
  x: number,
  y: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): { point: [number, number]; side: Dir } | null {
  let bestT = Infinity;
  let bestSide: Dir = 'N';

  const edges: { val: number; axis: 'x' | 'y'; side: Dir }[] = [
    { val: x, axis: 'x', side: 'W' },
    { val: x + w, axis: 'x', side: 'E' },
    { val: y, axis: 'y', side: 'N' },
    { val: y + h, axis: 'y', side: 'S' },
  ];

  for (const e of edges) {
    const d = e.axis === 'x' ? dx : dy;
    const o = e.axis === 'x' ? ox : oy;
    if (Math.abs(d) < 1e-12) continue;
    const t = (e.val - o) / d;
    if (t <= 1e-9 || t >= bestT) continue;

    // Check cross-axis range
    const cross = e.axis === 'x' ? oy + t * dy : ox + t * dx;
    const [cMin, cMax] = e.axis === 'x' ? [y, y + h] : [x, x + w];
    if (cross >= cMin - 0.001 && cross <= cMax + 0.001) {
      bestT = t;
      bestSide = e.side;
    }
  }

  if (bestT === Infinity) return null;
  return { point: [ox + bestT * dx, oy + bestT * dy], side: bestSide };
}

/** Ray vs ellipse. Solve quadratic in parameter t. */
function rayEllipseIntersection(
  x: number,
  y: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): { point: [number, number]; side: Dir } | null {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  // Substituting P(t) = (ox + t*dx, oy + t*dy) into ellipse equation
  const a = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  const b = 2 * (((ox - cx) * dx) / (rx * rx) + ((oy - cy) * dy) / (ry * ry));
  const c = (ox - cx) ** 2 / (rx * rx) + (oy - cy) ** 2 / (ry * ry) - 1;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b + sqrtDisc) / (2 * a);
  const t2 = (-b - sqrtDisc) / (2 * a);

  // Take smallest positive t
  let t = Infinity;
  if (t1 > 1e-9 && t1 < t) t = t1;
  if (t2 > 1e-9 && t2 < t) t = t2;
  if (t === Infinity) return null;

  const px = ox + t * dx;
  const py = oy + t * dy;

  // Side from quadrant
  const angle = Math.atan2(py - cy, px - cx);
  const normAngle = (angle + Math.PI * 2) % (Math.PI * 2);
  let side: Dir;
  if (normAngle < Math.PI / 4 || normAngle >= (Math.PI * 7) / 4) side = 'E';
  else if (normAngle < (Math.PI * 3) / 4) side = 'S';
  else if (normAngle < (Math.PI * 5) / 4) side = 'W';
  else side = 'N';

  return { point: [px, py], side };
}

/** Ray vs diamond (4 diagonal segments). */
function rayDiamondIntersection(
  x: number,
  y: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
): { point: [number, number]; side: Dir } | null {
  const top: [number, number] = [x + w / 2, y];
  const right: [number, number] = [x + w, y + h / 2];
  const bottom: [number, number] = [x + w / 2, y + h];
  const left: [number, number] = [x, y + h / 2];

  const segments: { p1: [number, number]; p2: [number, number]; side: Dir }[] = [
    { p1: top, p2: right, side: 'E' },
    { p1: right, p2: bottom, side: 'S' },
    { p1: bottom, p2: left, side: 'W' },
    { p1: left, p2: top, side: 'N' },
  ];

  let bestT = Infinity;
  let bestSide: Dir = 'N';

  for (const seg of segments) {
    const ex = seg.p2[0] - seg.p1[0];
    const ey = seg.p2[1] - seg.p1[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;

    const t = ((seg.p1[0] - ox) * ey - (seg.p1[1] - oy) * ex) / denom;
    const u = ((seg.p1[0] - ox) * dy - (seg.p1[1] - oy) * dx) / denom;

    if (t > 1e-9 && t < bestT && u >= -0.001 && u <= 1.001) {
      bestT = t;
      bestSide = seg.side;
    }
  }

  if (bestT === Infinity) return null;
  return { point: [ox + bestT * dx, oy + bestT * dy], side: bestSide };
}
