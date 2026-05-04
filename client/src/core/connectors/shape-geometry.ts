/**
 * Pure shape geometry — rect / ellipse / diamond math with zero connector dependencies.
 *
 * Two pure projections cover every snap, route, and reroute path:
 *   - `projectAnchorToEdge(anchor, frame, shapeType, outEdge, outNormal): Dir`
 *     Normalized [0-1, 0-1] anchor → world edge point + outward normal + cardinal Dir
 *     derived from the world-space normal (so aspect ratio + shape type both auto-correct).
 *   - `rayShapeExitPoint(origin, direction, frame, shapeType, outPoint): boolean`
 *     Where a ray from an interior point exits the shape boundary.
 *
 * Plus a single midpoint atom (`midpointFor`) — N/E/S/W edge midpoints are identical
 * for every shape type (rect-inscribed diamonds, axis-aligned ellipses).
 *
 * **Non-re-entrance.** The internal helpers fill caller-owned out-tuples and use
 * stack-local scalars only — no module-level scratch leaks between calls. Caller
 * scratches in snap.ts / reroute-connector.ts must still avoid interleaving two
 * projections within one synchronous stack frame.
 *
 * @module core/connectors/shape-geometry
 */

import { frameCenter } from '../geometry/bounds';
import type { FrameTuple, Point } from '../types/geometry';
import type { Dir } from './types';

// ============================================================================
// ATOMS
// ============================================================================

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export { frameCenter };

/** Fill `out` with the world-space midpoint of `side` for any rect-inscribed shape. */
export function midpointFor(frame: FrameTuple, side: Dir, out: Point): void {
  const [x, y, w, h] = frame;
  switch (side) {
    case 'N':
      out[0] = x + w / 2;
      out[1] = y;
      return;
    case 'E':
      out[0] = x + w;
      out[1] = y + h / 2;
      return;
    case 'S':
      out[0] = x + w / 2;
      out[1] = y + h;
      return;
    case 'W':
      out[0] = x;
      out[1] = y + h / 2;
      return;
  }
}

// ============================================================================
// ANCHOR → EDGE PROJECTION
// ============================================================================

/**
 * Project a normalized anchor onto the shape's edge.
 *
 * Writes the world-space edge point into `outEdge` and the unit outward normal
 * into `outNormal`. Returns the cardinal `Dir` derived from `outNormal` (dominant
 * axis; horizontal favored on ties). Side is **world-space**, so a "top-right"
 * anchor on a stretched-wide diamond classifies as N (the world normal is nearly
 * vertical), while the same anchor on a stretched-tall diamond classifies as E —
 * the right answer for routing in both cases.
 *
 * Defensive fallbacks (write frame center + outward `(1, 0)` and return E):
 *   - frame width or height < 0.001
 *   - anchor exactly at `(0.5, 0.5)` — only legitimate for straight center snaps
 *     (interior, no projection needed); reaching this for elbow indicates
 *     stale/cross-type data.
 */
export function projectAnchorToEdge(anchor: Point, frame: FrameTuple, shapeType: string, outEdge: Point, outNormal: Point): Dir {
  if (frame[2] < 0.001 || frame[3] < 0.001 || (anchor[0] === 0.5 && anchor[1] === 0.5)) {
    outEdge[0] = frame[0] + frame[2] / 2;
    outEdge[1] = frame[1] + frame[3] / 2;
    outNormal[0] = 1;
    outNormal[1] = 0;
    return 'E';
  }
  if (shapeType === 'ellipse') return projectAnchorEllipse(anchor, frame, outEdge, outNormal);
  if (shapeType === 'diamond') return projectAnchorDiamond(anchor, frame, outEdge, outNormal);
  return projectAnchorRect(anchor, frame, outEdge, outNormal);
}

/**
 * Rect / roundedRect: snap the closer normalized coord to 0 or 1.
 * Tie-break order W → E → N → S resolves corners deterministically (`(0,0)` → W).
 */
function projectAnchorRect(anchor: Point, frame: FrameTuple, outEdge: Point, outNormal: Point): Dir {
  const ax = clamp01(anchor[0]);
  const ay = clamp01(anchor[1]);
  const dN = ay;
  const dS = 1 - ay;
  const dW = ax;
  const dE = 1 - ax;
  const [x, y, w, h] = frame;

  let side: Dir;
  if (dW <= dE && dW <= dN && dW <= dS) side = 'W';
  else if (dE <= dN && dE <= dS) side = 'E';
  else if (dN <= dS) side = 'N';
  else side = 'S';

  switch (side) {
    case 'W':
      outEdge[0] = x;
      outEdge[1] = y + ay * h;
      outNormal[0] = -1;
      outNormal[1] = 0;
      return 'W';
    case 'E':
      outEdge[0] = x + w;
      outEdge[1] = y + ay * h;
      outNormal[0] = 1;
      outNormal[1] = 0;
      return 'E';
    case 'N':
      outEdge[0] = x + ax * w;
      outEdge[1] = y;
      outNormal[0] = 0;
      outNormal[1] = -1;
      return 'N';
    case 'S':
      outEdge[0] = x + ax * w;
      outEdge[1] = y + h;
      outNormal[0] = 0;
      outNormal[1] = 1;
      return 'S';
  }
}

/**
 * Ellipse: parametric projection from center along the centered, normalized
 * anchor direction. Outward normal divides component-wise by (rx, ry) then
 * normalizes — this is the geometric ellipse outward, not the radial direction.
 */
function projectAnchorEllipse(anchor: Point, frame: FrameTuple, outEdge: Point, outNormal: Point): Dir {
  const [x, y, w, h] = frame;
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const ux = 2 * anchor[0] - 1;
  const uy = 2 * anchor[1] - 1;
  const ulen = Math.hypot(ux, uy);
  let unx: number;
  let uny: number;
  if (ulen < 1e-9) {
    unx = 1;
    uny = 0;
  } else {
    unx = ux / ulen;
    uny = uy / ulen;
  }

  outEdge[0] = cx + rx * unx;
  outEdge[1] = cy + ry * uny;

  const nxRaw = unx / rx;
  const nyRaw = uny / ry;
  const nlen = Math.hypot(nxRaw, nyRaw);
  outNormal[0] = nxRaw / nlen;
  outNormal[1] = nyRaw / nlen;

  return cardinalFromNormal(outNormal);
}

/**
 * Diamond: parametric projection in normalized space onto the closest of four
 * edges (W→N, N→E, E→S, S→W; CCW in screen coords with y-down). The world
 * outward normal per edge — derived from CW rotation of the world tangent —
 * encodes the diamond's aspect ratio, so the cardinal flips between N/S and
 * E/W as the frame stretches.
 */
function projectAnchorDiamond(anchor: Point, frame: FrameTuple, outEdge: Point, outNormal: Point): Dir {
  const ax = anchor[0];
  const ay = anchor[1];

  // Each edge: start + direction in normalized [0, 1]² space; |direction|² = 0.5.
  // 0 NW (W→N): start (0, 0.5), dir (0.5, -0.5)
  // 1 NE (N→E): start (0.5, 0), dir (0.5,  0.5)
  // 2 SE (E→S): start (1, 0.5), dir (-0.5, 0.5)
  // 3 SW (S→W): start (0.5, 1), dir (-0.5, -0.5)
  let bestEdge = 0;
  let bestDist = Infinity;
  let bestPx = 0;
  let bestPy = 0;

  for (let i = 0; i < 4; i++) {
    const sx = i === 0 ? 0 : i === 1 ? 0.5 : i === 2 ? 1 : 0.5;
    const sy = i === 0 ? 0.5 : i === 1 ? 0 : i === 2 ? 0.5 : 1;
    const dx = i < 2 ? 0.5 : -0.5;
    const dy = i === 0 || i === 3 ? -0.5 : 0.5;
    let t = ((ax - sx) * dx + (ay - sy) * dy) / 0.5; // |dir|² = 0.5
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = sx + t * dx;
    const py = sy + t * dy;
    const distSq = (ax - px) ** 2 + (ay - py) ** 2;
    if (distSq < bestDist) {
      bestDist = distSq;
      bestEdge = i;
      bestPx = px;
      bestPy = py;
    }
  }

  const [x, y, w, h] = frame;
  outEdge[0] = x + bestPx * w;
  outEdge[1] = y + bestPy * h;

  // CW rotation of world tangent (p2-p1) for each CCW-ordered edge gives outward.
  // 0 NW: (-h, -w)   1 NE: ( h, -w)   2 SE: ( h,  w)   3 SW: (-h,  w)
  const nx = bestEdge === 0 || bestEdge === 3 ? -h : h;
  const ny = bestEdge < 2 ? -w : w;
  const nlen = Math.hypot(nx, ny);
  outNormal[0] = nx / nlen;
  outNormal[1] = ny / nlen;

  return cardinalFromNormal(outNormal);
}

/** Dominant-axis cardinal from a unit world normal; horizontal wins on ties. */
function cardinalFromNormal(n: Point): Dir {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  if (ax >= ay) return n[0] >= 0 ? 'E' : 'W';
  return n[1] >= 0 ? 'S' : 'N';
}

// ============================================================================
// RAY × SHAPE EXIT
// ============================================================================

/**
 * Find where a ray from `origin` along `direction` exits a convex shape's
 * boundary. Writes the exit point into `outPoint`; returns `false` when the
 * shape is degenerate, the direction is zero, or no forward intersection exists.
 *
 * Used by straight connectors with interior anchors — the visible line stops at
 * the shape edge; a dashed guide covers the interior segment.
 */
export function rayShapeExitPoint(origin: Point, direction: Point, frame: FrameTuple, shapeType: string, outPoint: Point): boolean {
  if (frame[2] < 0.001 || frame[3] < 0.001) return false;
  if (Math.abs(direction[0]) < 1e-9 && Math.abs(direction[1]) < 1e-9) return false;

  if (shapeType === 'ellipse') return rayEllipseExit(origin, direction, frame, outPoint);
  if (shapeType === 'diamond') return rayDiamondExit(origin, direction, frame, outPoint);
  return rayRectExit(origin, direction, frame, outPoint);
}

/** Ray vs axis-aligned rectangle — smallest positive t across four edges. */
function rayRectExit(origin: Point, direction: Point, frame: FrameTuple, out: Point): boolean {
  const [ox, oy] = origin;
  const [dx, dy] = direction;
  const [x, y, w, h] = frame;
  let bestT = Infinity;

  if (Math.abs(dy) >= 1e-12) {
    const tN = (y - oy) / dy;
    if (tN > 1e-9 && tN < bestT) {
      const cross = ox + tN * dx;
      if (cross >= x - 0.001 && cross <= x + w + 0.001) bestT = tN;
    }
    const tS = (y + h - oy) / dy;
    if (tS > 1e-9 && tS < bestT) {
      const cross = ox + tS * dx;
      if (cross >= x - 0.001 && cross <= x + w + 0.001) bestT = tS;
    }
  }
  if (Math.abs(dx) >= 1e-12) {
    const tW = (x - ox) / dx;
    if (tW > 1e-9 && tW < bestT) {
      const cross = oy + tW * dy;
      if (cross >= y - 0.001 && cross <= y + h + 0.001) bestT = tW;
    }
    const tE = (x + w - ox) / dx;
    if (tE > 1e-9 && tE < bestT) {
      const cross = oy + tE * dy;
      if (cross >= y - 0.001 && cross <= y + h + 0.001) bestT = tE;
    }
  }

  if (bestT === Infinity) return false;
  out[0] = ox + bestT * dx;
  out[1] = oy + bestT * dy;
  return true;
}

/** Ray vs ellipse — solve quadratic in parameter t. */
function rayEllipseExit(origin: Point, direction: Point, frame: FrameTuple, out: Point): boolean {
  const [ox, oy] = origin;
  const [dx, dy] = direction;
  const [x, y, w, h] = frame;
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;

  const a = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  const b = 2 * (((ox - cx) * dx) / (rx * rx) + ((oy - cy) * dy) / (ry * ry));
  const c = (ox - cx) ** 2 / (rx * rx) + (oy - cy) ** 2 / (ry * ry) - 1;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b + sqrtDisc) / (2 * a);
  const t2 = (-b - sqrtDisc) / (2 * a);

  let t = Infinity;
  if (t1 > 1e-9 && t1 < t) t = t1;
  if (t2 > 1e-9 && t2 < t) t = t2;
  if (t === Infinity) return false;

  out[0] = ox + t * dx;
  out[1] = oy + t * dy;
  return true;
}

/** Ray vs diamond — Cramer's rule across the 4 vertex-to-vertex segments. */
function rayDiamondExit(origin: Point, direction: Point, frame: FrameTuple, out: Point): boolean {
  const [ox, oy] = origin;
  const [dx, dy] = direction;
  const [x, y, w, h] = frame;

  const wx = x;
  const wy = y + h / 2;
  const nx = x + w / 2;
  const ny = y;
  const ex = x + w;
  const ey = y + h / 2;
  const sx = x + w / 2;
  const sy = y + h;

  let bestT = Infinity;
  bestT = raySegmentT(ox, oy, dx, dy, wx, wy, nx, ny, bestT);
  bestT = raySegmentT(ox, oy, dx, dy, nx, ny, ex, ey, bestT);
  bestT = raySegmentT(ox, oy, dx, dy, ex, ey, sx, sy, bestT);
  bestT = raySegmentT(ox, oy, dx, dy, sx, sy, wx, wy, bestT);

  if (bestT === Infinity) return false;
  out[0] = ox + bestT * dx;
  out[1] = oy + bestT * dy;
  return true;
}

/** Smallest forward `t` of ray vs segment, returning `bestT` unchanged on miss. */
function raySegmentT(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  bestT: number,
): number {
  const ex = p2x - p1x;
  const ey = p2y - p1y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return bestT;
  const t = ((p1x - ox) * ey - (p1y - oy) * ex) / denom;
  const u = ((p1x - ox) * dy - (p1y - oy) * dx) / denom;
  if (t > 1e-9 && t < bestT && u >= -0.001 && u <= 1.001) return t;
  return bestT;
}
