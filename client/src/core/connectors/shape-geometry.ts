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

import { fillFrameCenter, frameCenter } from '../geometry/bounds';
import type { FrameTuple, Point } from '../types/geometry';
import { directionFromDelta, directionVector } from './connector-utils';
import type { Dir } from './types';

// ============================================================================
// ATOMS
// ============================================================================

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export { frameCenter };

/** Fill `out` with the world point of normalized `anchor` against `frame`. */
export function fillAnchorPoint(anchor: Point, frame: FrameTuple, out: Point): void {
  out[0] = frame[0] + anchor[0] * frame[2];
  out[1] = frame[1] + anchor[1] * frame[3];
}

/** Fill `out` with the unit cardinal vector for `dir`. */
export function fillCardinal(dir: Dir, out: Point): void {
  const v = directionVector(dir);
  out[0] = v[0];
  out[1] = v[1];
}

/** Write the unit-normalized `(x, y)` into `out`. Returns `false` on zero-magnitude (out untouched). */
function normalize2dInto(x: number, y: number, out: Point): boolean {
  const len = Math.hypot(x, y);
  if (len < 1e-12) return false;
  out[0] = x / len;
  out[1] = y / len;
  return true;
}

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
 * **Cardinal midpoint fast path.** The 4 N/E/S/W midpoint anchors short-circuit
 * the per-shape math: rect edge-midpoint = ellipse cardinal point = diamond
 * vertex, all sharing world position and cardinal outward normal. This is also
 * what fixes diamond vertices — the per-edge classifier would otherwise flip
 * a left-vertex anchor to N or S on a stretched-wide diamond (the projected
 * edge's normal `(-h, -w)/L` is dominated by `w`).
 *
 * Defensive fallbacks (write frame center + outward `(1, 0)` and return E):
 *   - frame width or height < 0.001
 *   - anchor exactly at `(0.5, 0.5)` — only legitimate for straight center snaps
 *     (interior, no projection needed); reaching this for elbow indicates
 *     stale/cross-type data.
 */
export function projectAnchorToEdge(anchor: Point, frame: FrameTuple, shapeType: string, outEdge: Point, outNormal: Point): Dir {
  if (frame[2] < 0.001 || frame[3] < 0.001 || (anchor[0] === 0.5 && anchor[1] === 0.5)) {
    fillFrameCenter(frame, outEdge);
    fillCardinal('E', outNormal);
    return 'E';
  }
  const midDir = cardinalMidpointDir(anchor[0], anchor[1]);
  if (midDir !== null) {
    fillAnchorPoint(anchor, frame, outEdge);
    fillCardinal(midDir, outNormal);
    return midDir;
  }
  if (shapeType === 'ellipse') return projectAnchorEllipse(anchor, frame, outEdge, outNormal);
  if (shapeType === 'diamond') return projectAnchorDiamond(anchor, frame, outEdge, outNormal);
  return projectAnchorRect(anchor, frame, outEdge, outNormal);
}

const MIDPOINT_EPS = 1e-9;

/**
 * Match `(ax, ay)` to one of the 4 cardinal midpoints — N=(0.5,0), E=(1,0.5),
 * S=(0.5,1), W=(0,0.5) — within `MIDPOINT_EPS`. Returns `null` otherwise. The
 * snap layer writes these values exactly via `midpointFor` → `normalizedFromEdge`;
 * the epsilon covers drift through serialization or transform math.
 */
function cardinalMidpointDir(ax: number, ay: number): Dir | null {
  const halfX = ax > 0.5 - MIDPOINT_EPS && ax < 0.5 + MIDPOINT_EPS;
  if (halfX) {
    if (ay < MIDPOINT_EPS) return 'N';
    if (ay > 1 - MIDPOINT_EPS) return 'S';
  }
  const halfY = ay > 0.5 - MIDPOINT_EPS && ay < 0.5 + MIDPOINT_EPS;
  if (halfY) {
    if (ax < MIDPOINT_EPS) return 'W';
    if (ax > 1 - MIDPOINT_EPS) return 'E';
  }
  return null;
}

/**
 * Rect / roundedRect: snap the closer normalized coord to 0 or 1.
 * Tie-break order W → E → N → S resolves corners deterministically (`(0,0)` → W).
 */
function projectAnchorRect(anchor: Point, frame: FrameTuple, outEdge: Point, outNormal: Point): Dir {
  const ax = clamp01(anchor[0]);
  const ay = clamp01(anchor[1]);

  let side: Dir = 'W';
  let best = ax;
  const dE = 1 - ax;
  if (dE < best) {
    side = 'E';
    best = dE;
  }
  if (ay < best) {
    side = 'N';
    best = ay;
  }
  if (1 - ay < best) side = 'S';

  // Snap perpendicular axis to 0/1; tangential axis keeps the clamped anchor coord.
  outEdge[0] = frame[0] + (side === 'W' ? 0 : side === 'E' ? 1 : ax) * frame[2];
  outEdge[1] = frame[1] + (side === 'N' ? 0 : side === 'S' ? 1 : ay) * frame[3];
  fillCardinal(side, outNormal);
  return side;
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
  const ux = 2 * anchor[0] - 1;
  const uy = 2 * anchor[1] - 1;
  const ulen = Math.hypot(ux, uy);
  const unx = ulen < 1e-9 ? 1 : ux / ulen;
  const uny = ulen < 1e-9 ? 0 : uy / ulen;

  outEdge[0] = x + rx + rx * unx;
  outEdge[1] = y + ry + ry * uny;

  normalize2dInto(unx / rx, uny / ry, outNormal);
  return directionFromDelta(outNormal[0], outNormal[1]);
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
    const t = clamp01(((ax - sx) * dx + (ay - sy) * dy) / 0.5); // |dir|² = 0.5
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
  normalize2dInto(nx, ny, outNormal);
  return directionFromDelta(outNormal[0], outNormal[1]);
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
 *
 * Per-shape `*ExitT` helpers are pure scalar math: take 8 frame/ray scalars,
 * return the forward `t` along the ray (or `NaN` on miss). The destructure
 * and the world-point write `origin + t·direction` happen here, once.
 */
export function rayShapeExitPoint(origin: Point, direction: Point, frame: FrameTuple, shapeType: string, outPoint: Point): boolean {
  if (frame[2] < 0.001 || frame[3] < 0.001) return false;
  const [ox, oy] = origin;
  const [dx, dy] = direction;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false;
  const [x, y, w, h] = frame;

  const t =
    shapeType === 'ellipse'
      ? rayEllipseExitT(ox, oy, dx, dy, x, y, w, h)
      : shapeType === 'diamond'
        ? rayDiamondExitT(ox, oy, dx, dy, x, y, w, h)
        : rayRectExitT(ox, oy, dx, dy, x, y, w, h);
  if (Number.isNaN(t)) return false;

  outPoint[0] = ox + t * dx;
  outPoint[1] = oy + t * dy;
  return true;
}

/** Where a ray exits a 1D `[near, far]` slab. `Infinity` if the ray is parallel. */
function slabExit(near: number, far: number, origin: number, dir: number): number {
  if (dir > 1e-12) return (far - origin) / dir;
  if (dir < -1e-12) return (near - origin) / dir;
  return Infinity;
}

/** Smallest forward (>1e-9) real root of `a·t² + b·t + c = 0`. `NaN` on miss. */
function smallestPositiveRoot(a: number, b: number, c: number): number {
  const disc = b * b - 4 * a * c;
  if (disc < 0) return NaN;
  const sqrtD = Math.sqrt(disc);
  const tNear = (-b - sqrtD) / (2 * a);
  const tFar = (-b + sqrtD) / (2 * a);
  return tNear > 1e-9 ? tNear : tFar > 1e-9 ? tFar : NaN;
}

/** Ray vs axis-aligned rectangle — slab method, smallest forward axis-exit. */
function rayRectExitT(ox: number, oy: number, dx: number, dy: number, x: number, y: number, w: number, h: number): number {
  const t = Math.min(slabExit(x, x + w, ox, dx), slabExit(y, y + h, oy, dy));
  return t === Infinity || t <= 1e-9 ? NaN : t;
}

/** Ray vs ellipse — quadratic in unit-circle coords; smallest forward root. */
function rayEllipseExitT(ox: number, oy: number, dx: number, dy: number, x: number, y: number, w: number, h: number): number {
  const rx = w / 2;
  const ry = h / 2;
  // Normalize so the ellipse becomes the unit circle |p|² = 1.
  const u = (ox - x - rx) / rx;
  const v = (oy - y - ry) / ry;
  const du = dx / rx;
  const dv = dy / ry;
  return smallestPositiveRoot(du * du + dv * dv, 2 * (u * du + v * dv), u * u + v * v - 1);
}

/** Ray vs diamond — Cramer's rule across the 4 vertex-to-vertex segments. */
function rayDiamondExitT(ox: number, oy: number, dx: number, dy: number, x: number, y: number, w: number, h: number): number {
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

  return bestT === Infinity ? NaN : bestT;
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
