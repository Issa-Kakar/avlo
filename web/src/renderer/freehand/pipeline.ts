/**
 * Freehand stroke geometry, based on the perfect-freehand algorithm by Steve Ruiz —
 * pressure→radius, offset outline tracks, median-quadratic smoothing.
 * MIT © 2021 Stephen Ruiz Ltd. https://github.com/steveruizok/perfect-freehand
 * The elbow-partitioning that avoids "hot elbows" at sharp turns follows tldraw's approach.
 *
 * A struct-of-arrays pipeline: reusable Float64Array buffers, per-call params via `setParams`,
 * emitting Canvas 2D paths directly (no SVG string), without taper (no caller uses it).
 *
 * Everything runs through one module-level set of reusable `Float64Array` buffers instead of
 * per-point objects, and the per-call geometry parameters live in module-level scalars set
 * once by `setParams`. Both are **non-reentrant**: each build (`setParams` → `ingest` →
 * `computeRadii` → partition load → `buildTracks`) fully consumes them before returning, and
 * the next build overwrites them. Zero per-call allocation — no options object, no default
 * closures.
 */

import type { StrokeInputPoint } from './types';

const { PI, min } = Math;

const MIN_PRESSURE = 0.025;
// Rate of change for simulated pressure.
const RATE_OF_PRESSURE_CHANGE = 0.275;

// Browser strokes seem to be off if PI is regular; a tiny offset fixes it.
const FIXED_PI = PI + 0.0001;

// How far the simplified outline tracks may deviate from the raw tracks, as a fraction of
// the stroke size. Well below visible thresholds.
const TRACK_TOLERANCE_RATIO = 0.05;
// The maximum number of intermediate points the track simplifier may drop per kept segment.
const SIMPLIFY_WINDOW = 8;
// How many steps to take when rounding a corner.
const MAX_ROUNDED_CORNER_STEPS = 13;
// Dot product threshold for identifying a hard corner.
const HARD_CORNER_DPR = -0.62;

// ---------------------------------------------------------------------------------
// Per-build geometry parameters. Set once by `setParams`, read throughout the build.
// Non-reentrant, like the buffers below.
// ---------------------------------------------------------------------------------

let pSize = 16;
let pThinning = 0;
let pSmoothing = 0.5;
let pStreamline = 0.5;
let pSimulatePressure = false;
let pLast = false;
let pEasing: (t: number) => number = (t) => t;

export function setParams(
  size: number,
  thinning: number,
  smoothing: number,
  streamline: number,
  simulatePressure: boolean,
  easing: (t: number) => number,
  last: boolean,
): void {
  pSize = size;
  pThinning = thinning;
  pSmoothing = smoothing;
  pStreamline = streamline;
  pSimulatePressure = simulatePressure;
  pEasing = easing;
  pLast = last;
}

// ---------------------------------------------------------------------------------
// Pipeline buffers: one slot per stroke point, filled by `ingest`, radii filled in by
// `computeRadii`. Callers ensure capacity before filling, so growth never copies.
// ---------------------------------------------------------------------------------

let pointCapacity = 256;
/** Streamlined (smoothed) point coordinates. */
export let pointX = new Float64Array(pointCapacity);
export let pointY = new Float64Array(pointCapacity);
/** The original input coordinates (used for elbows and sharp corners). */
export let inputX = new Float64Array(pointCapacity);
export let inputY = new Float64Array(pointCapacity);
/** The input z (pressure channel) after clamping. */
let inputZ = new Float64Array(pointCapacity);
let pressures = new Float64Array(pointCapacity);
let distances = new Float64Array(pointCapacity);
let runningLengths = new Float64Array(pointCapacity);
export let radii = new Float64Array(pointCapacity);
export let pointCount = 0;

function ensurePointCapacity(n: number) {
  if (n <= pointCapacity) return;
  while (pointCapacity < n) pointCapacity *= 2;
  pointX = new Float64Array(pointCapacity);
  pointY = new Float64Array(pointCapacity);
  inputX = new Float64Array(pointCapacity);
  inputY = new Float64Array(pointCapacity);
  inputZ = new Float64Array(pointCapacity);
  pressures = new Float64Array(pointCapacity);
  distances = new Float64Array(pointCapacity);
  runningLengths = new Float64Array(pointCapacity);
  radii = new Float64Array(pointCapacity);
}

// Staging buffers for the effective input sequence in `ingest` (after stripping
// near-start/near-end points, the two-point interpolation, and the duplicated last point).
let stageCapacity = 256;
let stageX = new Float64Array(stageCapacity);
let stageY = new Float64Array(stageCapacity);
let stageZ = new Float64Array(stageCapacity);

function ensureStageCapacity(n: number) {
  if (n <= stageCapacity) return;
  while (stageCapacity < n) stageCapacity *= 2;
  stageX = new Float64Array(stageCapacity);
  stageY = new Float64Array(stageCapacity);
  stageZ = new Float64Array(stageCapacity);
}

/** The z of a raw input point (`p[2]`) plus the pressure clamp. */
function zOf(p: StrokeInputPoint, clampZ: boolean): number {
  const z = p[2] === undefined ? 1 : p[2];
  // Some pens/OSes report z=0 even while touching, so we clamp rather than strip.
  return clampZ && z < MIN_PRESSURE ? MIN_PRESSURE : z;
}

/**
 * Phase 1: ingest and streamline raw input points into the pipeline buffers. Keeps every
 * order-sensitive step: the pressure clamp, near-start/near-end stripping, the two-point
 * simulated-pressure interpolation, the early-noise skip, and the short-stroke fixup.
 */
export function ingest(rawInputPoints: readonly StrokeInputPoint[]): void {
  const streamline = pStreamline;
  const size = pSize;
  const simulatePressure = pSimulatePressure;

  pointCount = 0;
  const rawLen = rawInputPoints.length;
  if (rawLen === 0) return;

  // Interpolation level between points.
  const t = 0.15 + (1 - streamline) * 0.85;

  ensureStageCapacity(rawLen + 8);
  ensurePointCapacity(rawLen + 8);

  const stX = stageX;
  const stY = stageY;
  const stZ = stageZ;

  const minDist2 = (size / 3) ** 2;
  const clampZ = !simulatePressure;

  // Strip points too close to the first point, accumulating max pressure into the first.
  const first = rawInputPoints[0];
  let firstZ = zOf(first, clampZ);
  let startIdx = 1;
  while (startIdx < rawLen) {
    const pt = rawInputPoints[startIdx];
    const dx = pt[0] - first[0];
    const dy = pt[1] - first[1];
    if (dx * dx + dy * dy > minDist2) break;
    firstZ = Math.max(firstZ, zOf(pt, clampZ));
    startIdx++;
  }

  // Stage the surviving points.
  stX[0] = first[0];
  stY[0] = first[1];
  stZ[0] = firstZ;
  let m = 1;
  for (let i = startIdx; i < rawLen; i++) {
    const pt = rawInputPoints[i];
    stX[m] = pt[0];
    stY[m] = pt[1];
    stZ[m] = zOf(pt, clampZ);
    m++;
  }

  // Strip points too close to the last point (can consume all but the last).
  let pointsRemovedFromNearEnd = 0;
  if (m > 1) {
    const lastX = stX[m - 1];
    const lastY = stY[m - 1];
    let j = m - 2;
    while (j >= 0) {
      const dx = stX[j] - lastX;
      const dy = stY[j] - lastY;
      if (dx * dx + dy * dy > minDist2) break;
      j--;
      pointsRemovedFromNearEnd++;
    }
    if (j < m - 2) {
      stX[j + 1] = lastX;
      stY[j + 1] = lastY;
      stZ[j + 1] = stZ[m - 1];
      m = j + 2;
    }
  }

  const isComplete =
    pLast ||
    !simulatePressure ||
    (m > 1 && (stX[m - 1] - stX[m - 2]) * (stX[m - 1] - stX[m - 2]) + (stY[m - 1] - stY[m - 2]) * (stY[m - 1] - stY[m - 2]) < size ** 2) ||
    pointsRemovedFromNearEnd > 0;

  // Add extra points between the two, to avoid "dash" lines for tapered strokes.
  if (m === 2 && simulatePressure) {
    const x0 = stX[0];
    const y0 = stY[0];
    const z0 = stZ[0];
    const x1 = stX[1];
    const y1 = stY[1];
    const z1 = stZ[1];
    for (let i = 1; i < 5; i++) {
      const u = i / 4;
      stX[i] = x0 + (x1 - x0) * u;
      stY[i] = y0 + (y1 - y0) * u;
      stZ[i] = ((z0 + (z1 - z0)) * i) / 4;
    }
    m = 5;
  }

  const ptX = pointX;
  const ptY = pointY;
  const inX = inputX;
  const inY = inputY;
  const inZ = inputZ;
  const press = pressures;
  const dists = distances;
  const runs = runningLengths;
  const rads = radii;

  // The first point needs no adjustment.
  ptX[0] = stX[0];
  ptY[0] = stY[0];
  inX[0] = stX[0];
  inY[0] = stY[0];
  inZ[0] = stZ[0];
  press[0] = simulatePressure ? 0.5 : stZ[0];
  dists[0] = 0;
  runs[0] = 0;
  rads[0] = 1;
  let count = 1;

  if (isComplete && streamline > 0) {
    stX[m] = stX[m - 1];
    stY[m] = stY[m - 1];
    stZ[m] = stZ[m - 1];
    m++;
  }

  let totalLength = 0;
  let prevX = stX[0];
  let prevY = stY[0];
  const u = 1 - t;
  const isLast = pLast;

  for (let i = 1; i < m; i++) {
    let x: number, y: number;
    if (!t || (isLast && i === m - 1)) {
      x = stX[i];
      y = stY[i];
    } else {
      x = stX[i] + (prevX - stX[i]) * u;
      y = stY[i] + (prevY - stY[i]) * u;
    }

    // If the new point is the same as the previous point, skip ahead.
    if (Math.abs(prevX - x) < 0.0001 && Math.abs(prevY - y) < 0.0001) continue;

    const distance = ((y - prevY) ** 2 + (x - prevX) ** 2) ** 0.5;
    totalLength += distance;

    // At the start of the line, wait until the new point is far enough away, to avoid noise.
    if (i < 4 && totalLength < size) continue;

    ptX[count] = x;
    ptY[count] = y;
    inX[count] = stX[i];
    inY[count] = stY[i];
    inZ[count] = stZ[i];
    press[count] = simulatePressure ? 0.5 : stZ[i];
    dists[count] = distance;
    runs[count] = totalLength;
    rads[count] = 1;
    count++;
    prevX = x;
    prevY = y;
  }

  if (totalLength < 1) {
    let max = 0.5;
    for (let i = 0; i < count; i++) max = Math.max(max, press[i]);
    for (let i = 0; i < count; i++) press[i] = max;
  }

  pointCount = count;
}

/**
 * Phase 2: compute each point's radius from its pressure, distance and running length. With
 * `thinning === 0` (pen/highlighter) the radius is a constant `size/2` — which is what keeps
 * the stroke bbox padding (`width/2 + 1`) exact.
 */
export function computeRadii(): void {
  const size = pSize;
  const thinning = pThinning;
  const simulatePressure = pSimulatePressure;
  const easing = pEasing;

  const n = pointCount;
  const press = pressures;
  const dists = distances;
  const runs = runningLengths;
  const rads = radii;

  const totalLength = runs[n - 1];

  if (!simulatePressure && totalLength < size) {
    let max = 0.5;
    for (let i = 0; i < n; i++) max = Math.max(max, press[i]);
    for (let i = 0; i < n; i++) {
      press[i] = max;
      rads[i] = size * easing(0.5 - thinning * (0.5 - max));
    }
    return;
  }

  // Initial pressure from the average of the first points. Prevents "dots" at the start.
  let prevPressure = press[0];
  for (let i = 0; i < n; i++) {
    if (runs[i] > size * 5) break;
    const sp = min(1, dists[i] / size);
    let p: number;
    if (simulatePressure) {
      const rp = min(1, 1 - sp);
      p = min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
    } else {
      p = min(1, prevPressure + (press[i] - prevPressure) * 0.5);
    }
    prevPressure = prevPressure + (p - prevPressure) * 0.5;
  }

  for (let i = 0; i < n; i++) {
    if (thinning) {
      let pressure = press[i];
      const sp = min(1, dists[i] / size);
      if (simulatePressure) {
        const rp = min(1, 1 - sp);
        pressure = min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
      } else {
        pressure = min(1, prevPressure + (pressure - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
      }
      rads[i] = size * easing(0.5 - thinning * (0.5 - pressure));
      prevPressure = pressure;
    } else {
      rads[i] = size / 2;
    }
  }
}

// ---------------------------------------------------------------------------------
// Track-source buffers: the (sub)sequence of stroke points the outline tracks are built
// from — the whole stroke, or one elbow partition at a time. `srcIsCap` marks points to
// treat as the first/last point when placing the outline.
// ---------------------------------------------------------------------------------

let srcCapacity = 256;
export let srcX = new Float64Array(srcCapacity);
export let srcY = new Float64Array(srcCapacity);
let srcInputX = new Float64Array(srcCapacity);
let srcInputY = new Float64Array(srcCapacity);
export let srcRadius = new Float64Array(srcCapacity);
let srcRunningLength = new Float64Array(srcCapacity);
let srcIsCap = new Uint8Array(srcCapacity);
export let srcCount = 0;

function ensureSrcCapacity(n: number) {
  if (n <= srcCapacity) return;
  while (srcCapacity < n) srcCapacity *= 2;
  srcX = new Float64Array(srcCapacity);
  srcY = new Float64Array(srcCapacity);
  srcInputX = new Float64Array(srcCapacity);
  srcInputY = new Float64Array(srcCapacity);
  srcRadius = new Float64Array(srcCapacity);
  srcRunningLength = new Float64Array(srcCapacity);
  srcIsCap = new Uint8Array(srcCapacity);
}

/** Load the track source from the whole pipeline. */
export function loadSrcFromPipeline(): void {
  const n = pointCount;
  ensureSrcCapacity(n);
  const sx = srcX;
  const sy = srcY;
  const six = srcInputX;
  const siy = srcInputY;
  const sr = srcRadius;
  const srl = srcRunningLength;
  const scap = srcIsCap;
  const ptX = pointX;
  const ptY = pointY;
  const inX = inputX;
  const inY = inputY;
  const runs = runningLengths;
  const rads = radii;
  for (let i = 0; i < n; i++) {
    sx[i] = ptX[i];
    sy[i] = ptY[i];
    six[i] = inX[i];
    siy[i] = inY[i];
    sr[i] = rads[i];
    srl[i] = runs[i];
    scap[i] = i === 0 || i === n - 1 ? 1 : 0;
  }
  srcCount = n;
}

/**
 * Load one elbow partition from the pipeline as the track source: boundary point `a`, the
 * surviving inner points `innerStart..innerEnd`, and boundary point `b`. Elbow boundaries
 * read the input coordinates instead of the streamlined ones. When a hard elbow's duplicated
 * end point survived cleanup (`dupQuirk`), the inner copy of `b` is also marked as a cap.
 */
export function loadSrcPartition(
  a: number,
  aElbow: boolean,
  innerStart: number,
  innerEnd: number,
  b: number,
  bElbow: boolean,
  dupQuirk: boolean,
): void {
  ensureSrcCapacity(innerEnd - innerStart + 3);
  const sx = srcX;
  const sy = srcY;
  const six = srcInputX;
  const siy = srcInputY;
  const sr = srcRadius;
  const srl = srcRunningLength;
  const scap = srcIsCap;
  const ptX = pointX;
  const ptY = pointY;
  const inX = inputX;
  const inY = inputY;
  const runs = runningLengths;
  const rads = radii;

  sx[0] = aElbow ? inX[a] : ptX[a];
  sy[0] = aElbow ? inY[a] : ptY[a];
  six[0] = inX[a];
  siy[0] = inY[a];
  sr[0] = rads[a];
  srl[0] = runs[a];
  scap[0] = 1;
  let w = 1;
  for (let i = innerStart; i <= innerEnd; i++) {
    sx[w] = ptX[i];
    sy[w] = ptY[i];
    six[w] = inX[i];
    siy[w] = inY[i];
    sr[w] = rads[i];
    srl[w] = runs[i];
    scap[w] = 0;
    w++;
  }
  if (dupQuirk) scap[w - 1] = 1;
  sx[w] = bElbow ? inX[b] : ptX[b];
  sy[w] = bElbow ? inY[b] : ptY[b];
  six[w] = inX[b];
  siy[w] = inY[b];
  sr[w] = rads[b];
  srl[w] = runs[b];
  scap[w] = 1;
  srcCount = w + 1;
}

// ---------------------------------------------------------------------------------
// Track buffers: the left and right outline tracks, written by `buildTracks`. Reusable and
// non-reentrant. Tracks grow while being written (corners append a variable number of
// points), so a grow here must copy the points written so far.
// ---------------------------------------------------------------------------------

let trackCapacity = 1024;
export let trackLeftX = new Float64Array(trackCapacity);
export let trackLeftY = new Float64Array(trackCapacity);
export let trackRightX = new Float64Array(trackCapacity);
export let trackRightY = new Float64Array(trackCapacity);
export let trackLeftCount = 0;
export let trackRightCount = 0;

function growTracks() {
  trackCapacity *= 2;
  const nlx = new Float64Array(trackCapacity);
  nlx.set(trackLeftX);
  trackLeftX = nlx;
  const nly = new Float64Array(trackCapacity);
  nly.set(trackLeftY);
  trackLeftY = nly;
  const nrx = new Float64Array(trackCapacity);
  nrx.set(trackRightX);
  trackRightX = nrx;
  const nry = new Float64Array(trackCapacity);
  nry.set(trackRightY);
  trackRightY = nry;
}

/**
 * Drop track points that lie within tolerance (`tol`) of the segment between their kept
 * neighbors. Keeps the simplified polyline within `tol` of the original. In place: kept
 * points are compacted toward the front of the arrays.
 */
function simplifyTrack(xs: Float64Array, ys: Float64Array, len: number, tol: number): number {
  if (len <= 2 || tol <= 0) return len;
  const tol2 = tol * tol;
  let out = 1;
  let anchor = 0;
  const lastIdx = len - 1;
  while (anchor < lastIdx) {
    let best = anchor + 1;
    const maxJ = anchor + SIMPLIFY_WINDOW > lastIdx ? lastIdx : anchor + SIMPLIFY_WINDOW;
    const ax = xs[anchor];
    const ay = ys[anchor];
    outer: for (let j = anchor + 2; j <= maxJ; j++) {
      const acx = xs[j] - ax;
      const acy = ys[j] - ay;
      const l2 = acx * acx + acy * acy;
      for (let k = anchor + 1; k < j; k++) {
        let t = l2 === 0 ? 0 : ((xs[k] - ax) * acx + (ys[k] - ay) * acy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xs[k] - (ax + acx * t);
        const ey = ys[k] - (ay + acy * t);
        if (ex * ex + ey * ey > tol2) break outer;
      }
      best = j;
    }
    xs[out] = xs[best];
    ys[out] = ys[best];
    out++;
    anchor = best;
  }
  return out;
}

/**
 * Build the left and right outline tracks for the stroke points currently loaded in the
 * track-source buffers, into the track buffers.
 *
 * `hasAnchor`/`anchorX`/`anchorY` carry the original predecessor of point 1 when the caller
 * has cut the sequence in front of it (elbow partitions): the second point's vector is
 * derived from the anchor rather than from point 0. Only applies when there are >2 points.
 */
export function buildTracks(hasAnchor: boolean, anchorX: number, anchorY: number): void {
  const size = pSize;
  const smoothing = pSmoothing;

  let lc = 0;
  let rc = 0;
  trackLeftCount = 0;
  trackRightCount = 0;

  const n = srcCount;
  if (n === 0 || size <= 0) return;

  const sx = srcX;
  const sy = srcY;
  const six = srcInputX;
  const siy = srcInputY;
  const sr = srcRadius;
  const srl = srcRunningLength;
  const scap = srcIsCap;
  let lxs = trackLeftX;
  let lys = trackLeftY;
  let rxs = trackRightX;
  let rys = trackRightY;

  const totalLength = srl[n - 1];
  const minDistance = (size * smoothing) ** 2;

  // A point's vector is the unit vector pointing back at its predecessor. Point 0 shares
  // point 1's vector; a lone point keeps the legacy unnormalized (1, 1).
  let curVecX = 1;
  let curVecY = 1;
  if (n > 1) {
    const dx = sx[0] - sx[1];
    const dy = sy[0] - sy[1];
    const l = (dx * dx + dy * dy) ** 0.5;
    if (l === 0) {
      curVecX = dx;
      curVecY = dy;
    } else {
      curVecX = dx / l;
      curVecY = dy / l;
    }
  }

  let prevVecX = curVecX;
  let prevVecY = curVecY;

  let plx = sx[0];
  let ply = sy[0];
  let prx = plx;
  let pry = ply;

  let tlx = plx;
  let tly = ply;
  let trx = prx;
  let trY = pry;

  // So we don't detect the same sharp corner twice.
  let isPrevPointSharpCorner = false;

  for (let i = 0; i < n; i++) {
    const pointX = sx[i];
    const pointY = sy[i];
    const radius = sr[i];
    const vecX = curVecX;
    const vecY = curVecY;

    // Derive the next point's vector (the last point reuses its own), and advance the
    // running vector so the next iteration picks it up regardless of `continue`s below.
    let nextVecX = vecX;
    let nextVecY = vecY;
    if (i < n - 1) {
      const fromX = i === 0 && n > 2 && hasAnchor ? anchorX : pointX;
      const fromY = i === 0 && n > 2 && hasAnchor ? anchorY : pointY;
      const dx = fromX - sx[i + 1];
      const dy = fromY - sy[i + 1];
      const l = (dx * dx + dy * dy) ** 0.5;
      if (l === 0) {
        nextVecX = dx;
        nextVecY = dy;
      } else {
        nextVecX = dx / l;
        nextVecY = dy / l;
      }
    }
    curVecX = nextVecX;
    curVecY = nextVecY;

    // Make sure a corner's worth of points will fit on each side.
    if (lc + MAX_ROUNDED_CORNER_STEPS + 1 > trackCapacity || rc + MAX_ROUNDED_CORNER_STEPS + 1 > trackCapacity) {
      growTracks();
      lxs = trackLeftX;
      lys = trackLeftY;
      rxs = trackRightX;
      rys = trackRightY;
    }

    const prevDpr = vecX * prevVecX + vecY * prevVecY;
    const nextDpr = i < n - 1 ? nextVecX * vecX + nextVecY * vecY : 1;

    const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0.2;

    if (isPointSharpCorner || isNextPointSharpCorner) {
      if (nextDpr > HARD_CORNER_DPR && totalLength - srl[i] > radius) {
        // Draw a "soft" corner.
        const offsetX = prevVecX * radius;
        const offsetY = prevVecY * radius;
        const cpr = prevVecX * nextVecY - prevVecY * nextVecX;

        if (cpr < 0) {
          tlx = pointX + offsetX;
          tly = pointY + offsetY;
          trx = pointX - offsetX;
          trY = pointY - offsetY;
        } else {
          tlx = pointX - offsetX;
          tly = pointY - offsetY;
          trx = pointX + offsetX;
          trY = pointY + offsetY;
        }

        lxs[lc] = tlx;
        lys[lc] = tly;
        lc++;
        rxs[rc] = trx;
        rys[rc] = trY;
        rc++;
      } else {
        // Draw a "sharp" corner: rotate around the input point.
        const inX = six[i];
        const inY = siy[i];
        const dx = -prevVecY * radius;
        const dy = prevVecX * radius;

        for (let step = 1 / MAX_ROUNDED_CORNER_STEPS, tt = 0; tt < 1; tt += step) {
          let angle = FIXED_PI * tt;
          let s = Math.sin(angle);
          let c = Math.cos(angle);
          tlx = inX + (dx * c - dy * s);
          tly = inY + (dx * s + dy * c);
          lxs[lc] = tlx;
          lys[lc] = tly;
          lc++;

          angle = FIXED_PI + FIXED_PI * -tt;
          s = Math.sin(angle);
          c = Math.cos(angle);
          trx = inX + (dx * c - dy * s);
          trY = inY + (dx * s + dy * c);
          rxs[rc] = trx;
          rys[rc] = trY;
          rc++;
        }
      }

      plx = tlx;
      ply = tly;
      prx = trx;
      pry = trY;

      if (isNextPointSharpCorner) {
        isPrevPointSharpCorner = true;
      }

      continue;
    }

    isPrevPointSharpCorner = false;

    if (scap[i]) {
      // Project one radius to each side, perpendicular to the direction of travel.
      const offsetX = vecY * radius;
      const offsetY = -vecX * radius;
      lxs[lc] = pointX - offsetX;
      lys[lc] = pointY - offsetY;
      lc++;
      rxs[rc] = pointX + offsetX;
      rys[rc] = pointY + offsetY;
      rc++;
      continue;
    }

    // Project one radius to each side, perpendicular to travel. The direction blends the
    // current and next vectors, leaning into the next vector as the upcoming turn sharpens.
    const lerpedX = nextVecX + (vecX - nextVecX) * nextDpr;
    const lerpedY = nextVecY + (vecY - nextVecY) * nextDpr;
    const offsetX = lerpedY * radius;
    const offsetY = -lerpedX * radius;

    tlx = pointX - offsetX;
    tly = pointY - offsetY;

    if (i <= 1 || (plx - tlx) ** 2 + (ply - tly) ** 2 > minDistance) {
      lxs[lc] = tlx;
      lys[lc] = tly;
      lc++;
      plx = tlx;
      ply = tly;
    }

    trx = pointX + offsetX;
    trY = pointY + offsetY;

    if (i <= 1 || (prx - trx) ** 2 + (pry - trY) ** 2 > minDistance) {
      rxs[rc] = trx;
      rys[rc] = trY;
      rc++;
      prx = trx;
      pry = trY;
    }

    prevVecX = vecX;
    prevVecY = vecY;
  }

  const tolerance = size * TRACK_TOLERANCE_RATIO;
  trackLeftCount = simplifyTrack(trackLeftX, trackLeftY, lc, tolerance);
  trackRightCount = simplifyTrack(trackRightX, trackRightY, rc, tolerance);
}
