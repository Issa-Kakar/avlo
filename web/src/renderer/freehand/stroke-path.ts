/**
 * Freehand → path commands. Partitions a stroke at its elbows and caps each partition (the
 * elbow-partitioning that avoids "hot elbows" at sharp turns), emitting Canvas 2D path
 * commands instead of an SVG string. Credit: see `pipeline.ts` header.
 *
 *   SVG `M x y`           → sink.moveTo
 *   SVG smooth-quad `t`   → sink.quadraticCurveTo(prevTrackPoint, midpoint)  (see below)
 *   SVG arc `a r,r 0 0 1` → sink.arc(srcPoint, radius, startAngle, endAngle, false)
 *   SVG `Z`               → sink.closePath
 *
 * The SVG `t` (smooth-quadratic) chain resolves its implied control points to the actual
 * outline-track points; we emit them explicitly (control = previous track point, endpoint =
 * midpoint of consecutive track points) — no reflection bookkeeping needed. Full float
 * precision (no centi-integer rounding, which was only an SVG byte-size trick).
 *
 * The sink is a `CanvasPath` — either a `Path2D` (committed strokes: built once, cached) or a
 * `CanvasRenderingContext2D` (live preview / eraser trail: traced straight into the context
 * each frame, so no per-frame `Path2D` is allocated). Callers targeting a context must
 * `ctx.beginPath()` first and `ctx.fill()` after.
 *
 * Elbow partitioning is the "hot elbows" fix: at a sharp turn the stroke is cut and each side
 * rendered as its own capped shape. Each partition is a closed subpath with the same winding,
 * so a default nonzero fill unions them into one solid shape.
 */

import {
  buildTracks,
  computeRadii,
  ingest,
  inputX,
  inputY,
  loadSrcFromPipeline,
  loadSrcPartition,
  pointCount,
  pointX,
  pointY,
  radii,
  setParams,
  srcCount,
  srcRadius,
  srcX,
  srcY,
  trackLeftCount,
  trackLeftX,
  trackLeftY,
  trackRightCount,
  trackRightX,
  trackRightY,
} from './pipeline';
import { STROKE_OPTIONS_BASE, type StrokeInputPoint } from './types';

const TWO_PI = Math.PI * 2;
const IDENTITY_EASING = (t: number) => t;
// Eraser-trail radius easing (mirrors the old inline `-t*t + 2*t`).
const ERASER_EASING = (t: number) => -t * t + 2 * t;

/**
 * Trace a pen/highlighter stroke (constant width — no pressure/thinning) into `sink`.
 * Input points are `[x, y]`. `last` closes/caps the trailing end (false = live tail).
 */
export function traceStroke(sink: CanvasPath, points: readonly StrokeInputPoint[], size: number, last: boolean): void {
  setParams(
    size,
    STROKE_OPTIONS_BASE.thinning,
    STROKE_OPTIONS_BASE.smoothing,
    STROKE_OPTIONS_BASE.streamline,
    STROKE_OPTIONS_BASE.simulatePressure,
    IDENTITY_EASING,
    last,
  );
  buildInto(sink, points);
}

/**
 * Trace an eraser-style trail (velocity-tapered via simulated pressure) into `sink`. Input
 * points are `[x, y, pressure]`; `size` is the base diameter.
 */
export function traceEraserTrail(sink: CanvasPath, points: readonly StrokeInputPoint[], size: number): void {
  setParams(size, 0.5, 0.7, 0.4, true, ERASER_EASING, false);
  buildInto(sink, points);
}

/** Build a filled pen/highlighter outline as a standalone `Path2D` (for the geometry cache). */
export function strokeToPath2D(points: readonly StrokeInputPoint[], size: number, last: boolean): Path2D {
  const path = new Path2D();
  traceStroke(path, points, size, last);
  return path;
}

/** Run the pipeline (params already set) and emit the partitioned outline into `sink`. */
function buildInto(sink: CanvasPath, points: readonly StrokeInputPoint[]): void {
  ingest(points);
  if (pointCount === 0) return;
  computeRadii();
  partitionAtElbows(sink);
}

/**
 * Walk the stroke points in the pipeline buffers, cutting the stroke into partitions at
 * elbows, and render each into `sink`. An acute elbow uses the input point rather than the
 * streamlined point at the boundary (swooshiness in fast zaggy lines).
 */
function partitionAtElbows(sink: CanvasPath): void {
  const n = pointCount;
  if (n === 0) return;
  if (n <= 2) {
    loadSrcFromPipeline();
    renderPartitionInto(sink, false, 0, 0);
    return;
  }

  const ptX = pointX;
  const ptY = pointY;
  const rads = radii;

  let a = 0;
  let aElbow = false;
  let hasAnchor = false;
  let anchorX = 0;
  let anchorY = 0;

  let dx = ptX[1] - ptX[0];
  let dy = ptY[1] - ptY[0];
  let len = Math.sqrt(dx * dx + dy * dy);
  let prevVx = dx / len;
  let prevVy = dy / len;

  for (let i = 1; i < n - 1; i++) {
    dx = ptX[i + 1] - ptX[i];
    dy = ptY[i + 1] - ptY[i];
    len = Math.sqrt(dx * dx + dy * dy);
    const nextVx = dx / len;
    const nextVy = dy / len;
    const dpr = prevVx * nextVx + prevVy * nextVy;
    prevVx = nextVx;
    prevVy = nextVy;

    if (dpr < -0.8) {
      // Always treat such acute angles as elbows; use the extended input point as the elbow
      // point for swooshiness in fast zaggy lines.
      finishPartition(sink, a, aElbow, i, true, false, hasAnchor, anchorX, anchorY);
      a = i;
      aElbow = true;
      // The next partition's second point keeps the vector it had in the uncut stroke.
      hasAnchor = true;
      anchorX = ptX[i];
      anchorY = ptY[i];
      continue;
    }

    if (dpr > 0.7) {
      // Not an elbow.
      continue;
    }

    // Reasonably acute angle — an elbow only if it's close to its neighbors relative to the
    // radius (a hard elbow). The boundary point ends its partition twice over.
    const pdx = ptX[i] - ptX[i - 1];
    const pdy = ptY[i] - ptY[i - 1];
    const ndx = ptX[i + 1] - ptX[i];
    const ndy = ptY[i + 1] - ptY[i];
    const meanRadius = (rads[i - 1] + rads[i] + rads[i + 1]) / 3;
    if ((pdx * pdx + pdy * pdy + ndx * ndx + ndy * ndy) / (meanRadius * meanRadius) < 1.5) {
      finishPartition(sink, a, aElbow, i, false, true, hasAnchor, anchorX, anchorY);
      a = i;
      aElbow = false;
      hasAnchor = false;
    }
  }
  finishPartition(sink, a, aElbow, n - 1, false, false, hasAnchor, anchorX, anchorY);
}

/**
 * Clean up a partition's ends (drop inner points too close to the boundary points), load it
 * into the track-source buffers and render it. `bDup` marks a hard elbow whose end point is
 * duplicated.
 */
function finishPartition(
  sink: CanvasPath,
  a: number,
  aElbow: boolean,
  b: number,
  bElbow: boolean,
  bDup: boolean,
  hasAnchor: boolean,
  anchorX: number,
  anchorY: number,
): void {
  const ptX = pointX;
  const ptY = pointY;
  const rads = radii;

  const len = b - a + 1 + (bDup ? 1 : 0);
  let s = 0;
  let e = 0;

  // Clean up start of partition (remove points too close to the start).
  const startX = aElbow ? inputX[a] : ptX[a];
  const startY = aElbow ? inputY[a] : ptY[a];
  const startRadius = rads[a];
  while (len - s > 2) {
    const i = a + 1 + s;
    const dx = startX - ptX[i];
    const dy = startY - ptY[i];
    if (dx * dx + dy * dy < (((startRadius + rads[i]) / 2) * 0.5) ** 2) {
      // The surviving second point's vector keeps pointing at the spliced-out point.
      hasAnchor = true;
      anchorX = ptX[i];
      anchorY = ptY[i];
      s++;
    } else {
      break;
    }
  }

  // Clean up end of partition in the same fashion.
  const endX = bElbow ? inputX[b] : ptX[b];
  const endY = bElbow ? inputY[b] : ptY[b];
  const endRadius = rads[b];
  while (len - s - e > 2) {
    const i = bDup ? b - e : b - 1 - e;
    const dx = endX - ptX[i];
    const dy = endY - ptY[i];
    if (dx * dx + dy * dy < (((endRadius + rads[i]) / 2) * 0.5) ** 2) {
      e++;
    } else {
      break;
    }
  }

  const innerStart = a + 1 + s;
  const innerEnd = bDup ? b - e : b - 1 - e;
  loadSrcPartition(a, aElbow, innerStart, innerEnd, b, bElbow, bDup && e === 0);
  renderPartitionInto(sink, hasAnchor, anchorX, anchorY);
}

/** Render the partition currently loaded in the track-source buffers into `sink`. */
function renderPartitionInto(sink: CanvasPath, hasAnchor: boolean, anchorX: number, anchorY: number): void {
  const n = srcCount;
  if (n === 0) return;
  if (n === 1) {
    // A dot.
    const r = srcRadius[0];
    sink.moveTo(srcX[0] + r, srcY[0]);
    sink.arc(srcX[0], srcY[0], r, 0, TWO_PI);
    return;
  }

  buildTracks(hasAnchor, anchorX, anchorY);

  const lxs = trackLeftX;
  const lys = trackLeftY;
  const rxs = trackRightX;
  const rys = trackRightY;
  const leftCount = trackLeftCount;
  const rightCount = trackRightCount;

  // Left track: quadratics through the midpoints of consecutive track points.
  sink.moveTo(lxs[0], lys[0]);
  let prevX = lxs[0];
  let prevY = lys[0];
  for (let i = 1; i < leftCount; i++) {
    const px = lxs[i];
    const py = lys[i];
    sink.quadraticCurveTo(prevX, prevY, (prevX + px) * 0.5, (prevY + py) * 0.5);
    prevX = px;
    prevY = py;
  }

  // End cap: semicircle around the last source point.
  {
    const px = srcX[n - 1];
    const py = srcY[n - 1];
    const radius = srcRadius[n - 1];
    // Cap vector points from the last point back at its nearest neighbor.
    const vdx = srcX[n - 2] - px;
    const vdy = srcY[n - 2] - py;
    const vlen = Math.sqrt(vdx * vdx + vdy * vdy);
    // Arc endpoints sit one radius to each side, perpendicular to the cap vector.
    const dx = (-vdy / vlen) * radius;
    const dy = (vdx / vlen) * radius;
    const asx = px + dx;
    const asy = py + dy;
    const aex = px - dx;
    const aey = py - dy;
    sink.lineTo(asx, asy);
    sink.arc(px, py, radius, Math.atan2(asy - py, asx - px), Math.atan2(aey - py, aex - px), false);
  }

  // Right track in reverse, also as quadratics through midpoints.
  prevX = rxs[rightCount - 1];
  prevY = rys[rightCount - 1];
  for (let i = rightCount - 2; i >= 0; i--) {
    const px = rxs[i];
    const py = rys[i];
    sink.quadraticCurveTo(prevX, prevY, (prevX + px) * 0.5, (prevY + py) * 0.5);
    prevX = px;
    prevY = py;
  }

  // Start cap: semicircle around the first source point.
  {
    const px = srcX[0];
    const py = srcY[0];
    const radius = srcRadius[0];
    // Cap vector points from the first point back past its nearest neighbor.
    const vdx = px - srcX[1];
    const vdy = py - srcY[1];
    const vlen = Math.sqrt(vdx * vdx + vdy * vdy);
    const dx = (vdy / vlen) * radius;
    const dy = (-vdx / vlen) * radius;
    const asx = px + dx;
    const asy = py + dy;
    const aex = px - dx;
    const aey = py - dy;
    sink.lineTo(asx, asy);
    sink.arc(px, py, radius, Math.atan2(asy - py, asx - px), Math.atan2(aey - py, aex - px), false);
  }

  sink.closePath();
}
