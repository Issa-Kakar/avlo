import { Vec2, Edge, Corner } from './types';
import { RECT_AABB_COVERAGE_TOLERANCE_FACTOR, RECT_AABB_COVERAGE_MIN_TOL } from './shape-params';

/**
 * Compute the axis ratio from PCA eigenvalues.
 * Returns sqrt(λ₁/λ₂) where λ₁ ≥ λ₂.
 * Used for circle roundness scoring and gating.
 */
export function pcaAxisRatio(points: Vec2[]): number {
  const n = points.length;
  if (n < 2) return 1;

  // Compute centroid
  let sumX = 0,
    sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const cx = sumX / n;
  const cy = sumY / n;

  // Build covariance matrix
  let cxx = 0,
    cxy = 0,
    cyy = 0;
  for (const [x, y] of points) {
    const dx = x - cx;
    const dy = y - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }

  // Compute eigenvalues of 2x2 covariance matrix
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * det));

  const lambda1 = (trace + discriminant) / 2;
  const lambda2 = (trace - discriminant) / 2;

  // Avoid division by zero
  if (lambda2 < 1e-10) return 1000; // Very elongated shape

  return Math.sqrt(lambda1 / lambda2);
}

/**
 * Calculate angular coverage of points around a center.
 * Returns a value between 0 and 1 representing the fraction
 * of a full circle that is covered by the points.
 * Used for circle detection (requires ≥ 240° coverage).
 */
export function angularCoverage(points: Vec2[], center: Vec2): number {
  const n = points.length;
  if (n < 2) return 0;

  const [cx, cy] = center;

  // Compute angle for each point relative to center
  const angles: number[] = [];
  for (const [x, y] of points) {
    const angle = Math.atan2(y - cy, x - cx);
    angles.push(angle);
  }

  // Sort angles in ascending order
  angles.sort((a, b) => a - b);

  // Find the maximum gap between consecutive angles
  let maxGap = 0;
  let maxGapIdx = -1;
  for (let i = 0; i < n; i++) {
    const gap =
      i === n - 1
        ? angles[0] + 2 * Math.PI - angles[i] // Gap wrapping around from last to first
        : angles[i + 1] - angles[i];
    if (gap > maxGap) {
      maxGap = gap;
      maxGapIdx = i;
    }
  }

  // Coverage is the portion of the circle that IS covered
  const coverage = (2 * Math.PI - maxGap) / (2 * Math.PI);

  // Debug logging for coverage analysis
  console.log('   📐 Angular Coverage Analysis:');
  console.log(`      Center: [${cx.toFixed(1)}, ${cy.toFixed(1)}]`);
  console.log(`      Points analyzed: ${n}`);
  console.log(`      Max gap: ${((maxGap * 180) / Math.PI).toFixed(1)}° at index ${maxGapIdx}`);
  console.log(`      Coverage: ${(coverage * 360).toFixed(1)}° of 360°`);
  if (coverage < 0.667) {
    console.log(`      ⚠️ Below 240° threshold - not circular enough`);
  }

  return Math.max(0, Math.min(1, coverage));
}

/**
 * Detect corners in a stroke where angle changes significantly.
 * A corner is where the turn angle > 45° and both adjacent segments
 * are at least minSegmentLength world units.
 *
 * CRITICAL FIX: Now supports wrap-around corners for closed strokes
 * and uses peak-at-90° strength instead of monotonic strength.
 */
export function detectCorners(
  points: Vec2[],
  minSegmentLength: number = 10,
  minTurnAngleDeg: number = 45,
  closed: boolean = false,
): Corner[] {
  const n = points.length;
  if (n < 3) {
    console.log('   📐 Corner Detection: Too few points for corners');
    return [];
  }

  const corners: Corner[] = [];
  const minTurnAngleRad = (minTurnAngleDeg * Math.PI) / 180;

  let skippedShortSegments = 0;
  let skippedSmallAngles = 0;

  // CRITICAL: Handle wrap-around for closed strokes
  const iStart = closed ? 0 : 1;
  const iEnd = closed ? n : n - 1;

  // Helper to get point with wrap-around
  const at = (k: number) => points[(k + n) % n];

  for (let i = iStart; i < iEnd; i++) {
    const [x0, y0] = at(i - 1);
    const [x1, y1] = at(i);
    const [x2, y2] = at(i + 1);

    // Check segment lengths
    const len1 = Math.hypot(x1 - x0, y1 - y0);
    const len2 = Math.hypot(x2 - x1, y2 - y1);
    if (len1 < minSegmentLength || len2 < minSegmentLength) {
      skippedShortSegments++;
      continue;
    }

    // Calculate turn angle
    const angle1 = Math.atan2(y1 - y0, x1 - x0);
    const angle2 = Math.atan2(y2 - y1, x2 - x1);
    let turnAngle = angle2 - angle1;

    // Normalize to [-π, π]
    while (turnAngle > Math.PI) turnAngle -= 2 * Math.PI;
    while (turnAngle < -Math.PI) turnAngle += 2 * Math.PI;

    const absTurnAngle = Math.abs(turnAngle);
    if (absTurnAngle > minTurnAngleRad) {
      // Convert to degrees for corner angle
      const cornerAngleDeg = (Math.abs(turnAngle) * 180) / Math.PI;

      // CRITICAL FIX: Peak-at-90° strength (triangle shape)
      // Strength is 1.0 at 90°, falling off linearly to 0 at 45° and 135°
      const deviation = Math.abs(cornerAngleDeg - 90);
      const strength = Math.max(0, 1 - deviation / 45);

      corners.push({
        index: (i + n) % n, // Ensure valid index with wrap-around
        angle: cornerAngleDeg,
        strength,
      });
    } else {
      skippedSmallAngles++;
    }
  }

  console.log('   📐 Corner Detection Summary:');
  console.log(
    `      Points analyzed: ${iEnd - iStart} potential corners ${closed ? '(closed)' : '(open)'}`,
  );
  console.log(`      Corners found: ${corners.length}`);
  console.log(`      Skipped (short segments): ${skippedShortSegments}`);
  console.log(`      Skipped (angle < ${minTurnAngleDeg}°): ${skippedSmallAngles}`);
  if (corners.length > 0) {
    const angles = corners
      .map((c) => `${c.angle.toFixed(1)}° (s=${c.strength.toFixed(2)})`)
      .join(', ');
    console.log(`      Corner angles (with strength): [${angles}]`);
  }

  return corners;
}

/**
 * Detect edges between corners in a stroke.
 * Edges are straight segments between detected corners.
 */
export function detectEdges(points: Vec2[], corners: Corner[], minIndexDelta: number = 3): Edge[] {
  const n = points.length;
  if (n < 2) return [];

  const edges: Edge[] = [];

  // Add start and end as implicit corner positions
  const cornerIndices = [0];
  for (const corner of corners) {
    cornerIndices.push(corner.index);
  }
  cornerIndices.push(n - 1);

  // Create edges between consecutive corners
  for (let i = 0; i < cornerIndices.length - 1; i++) {
    const startIdx = cornerIndices[i];
    const endIdx = cornerIndices[i + 1];

    // Skip very short edges
    if (endIdx - startIdx <= minIndexDelta) continue;

    const [x1, y1] = points[startIdx];
    const [x2, y2] = points[endIdx];

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const length = Math.hypot(x2 - x1, y2 - y1);

    edges.push({
      startIdx,
      endIdx,
      angle,
      length,
    });
  }

  return edges;
}

/**
 * Combined detection of edges and corners for efficiency.
 * This is the main helper used by the recognition algorithm.
 */
export function detectEdgesAndCorners(
  points: Vec2[],
  minSegmentLength: number = 10,
  minTurnAngleDeg: number = 45,
  minIndexDelta: number = 3,
  closed: boolean = false,
): { edges: Edge[]; corners: Corner[] } {
  const corners = detectCorners(points, minSegmentLength, minTurnAngleDeg, closed);
  const edges = detectEdges(points, corners, minIndexDelta);
  return { edges, corners };
}

/**
 * Compute robust angle of a segment using PCA over all points.
 * This is more stable than using just endpoints when strokes have wobble.
 */
function robustSegmentAngle(points: Vec2[], i0: number, i1: number): number {
  const n = points.length;
  const idxs: number[] = [];

  // Collect all indices along the segment (handling wrap-around)
  if (i1 >= i0) {
    for (let k = i0; k <= i1; k++) idxs.push(k);
  } else {
    // Wrap-around edge
    for (let k = i0; k < n; k++) idxs.push(k);
    for (let k = 0; k <= i1; k++) idxs.push(k);
  }

  // If too few points, fall back to endpoint angle
  if (idxs.length < 2) {
    const [x0, y0] = points[i0];
    const [x1, y1] = points[i1];
    return Math.atan2(y1 - y0, x1 - x0);
  }

  // Compute PCA of segment
  let cx = 0,
    cy = 0;
  for (const j of idxs) {
    cx += points[j][0];
    cy += points[j][1];
  }
  cx /= idxs.length;
  cy /= idxs.length;

  let cxx = 0,
    cxy = 0,
    cyy = 0;
  for (const j of idxs) {
    const dx = points[j][0] - cx;
    const dy = points[j][1] - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }

  // Principal eigenvector of 2x2 covariance matrix
  const trace = cxx + cyy;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * (cxx * cyy - cxy * cxy)));

  if (disc === 0) {
    // Degenerate case - fall back to endpoints
    const [x0, y0] = points[i0];
    const [x1, y1] = points[i1];
    return Math.atan2(y1 - y0, x1 - x0);
  }

  // Eigenvector for largest eigenvalue
  const lambda1 = (trace + disc) / 2;
  const v = [2 * cxy, lambda1 - cxx];

  // Normalize and compute angle
  const angle = Math.atan2(v[1], v[0]);

  return angle;
}

/**
 * Reconstruct a closed 4-edge loop from detected corners for rectangle analysis.
 *
 * This ensures we always get exactly 4 edges in a proper cycle, which is
 * critical for parallel/orthogonal error calculations.
 *
 * CRITICAL FIX: Now uses robust PCA-based angles for edges instead of just endpoints.
 *
 * Strategy:
 * 1. Select the 4 best corners (highest strength)
 * 2. Sort them by position along the stroke
 * 3. Build edges between consecutive corners
 * 4. Add a closing edge from last corner back to first
 * 5. Filter edges by world-unit length (not index delta)
 * 6. Compute edge angles using PCA over all segment points (not just endpoints)
 */
export function reconstructRectangleEdges(
  points: Vec2[],
  corners: Corner[],
  minEdgeLengthWU: number = 8,
): Edge[] {
  console.group('   🔧 Rectangle Edge Reconstruction');

  if (corners.length < 3) {
    console.log(`   ⚠️ Only ${corners.length} corners, need at least 3 for rectangle`);
    console.groupEnd();
    return [];
  }

  // Step 1: Select the 4 best corners by strength
  const sorted = [...corners].sort((a, b) => b.strength - a.strength);
  const bestCorners = sorted.slice(0, Math.min(4, sorted.length));

  console.log(`   Selected ${bestCorners.length} best corners from ${corners.length} candidates`);

  // Step 2: Sort by index (position along stroke)
  bestCorners.sort((a, b) => a.index - b.index);

  // Step 3: Build edges between consecutive corners + closing edge
  const edges: Edge[] = [];
  const n = bestCorners.length;

  console.log('   Building edges:');

  for (let i = 0; i < n; i++) {
    const startIdx = bestCorners[i].index;
    const endIdx = bestCorners[(i + 1) % n].index; // Wrap around for closing edge

    const [x1, y1] = points[startIdx];
    const [x2, y2] = points[endIdx];

    const length = Math.hypot(x2 - x1, y2 - y1);

    // Use world-unit length check (not index delta)
    if (length < minEdgeLengthWU) {
      console.log(
        `      Edge ${i} (corner ${startIdx}→${endIdx}): SKIPPED (length ${length.toFixed(1)} < ${minEdgeLengthWU} WU)`,
      );
      continue;
    }

    // CRITICAL FIX: Use robust PCA-based angle instead of just endpoints
    const angle = robustSegmentAngle(points, startIdx, endIdx);

    edges.push({
      startIdx,
      endIdx,
      angle,
      length,
    });

    const isClosing = i === n - 1;
    console.log(
      `      Edge ${i} (corner ${startIdx}→${endIdx}): length=${length.toFixed(1)} WU, angle=${((angle * 180) / Math.PI).toFixed(1)}° ${isClosing ? '(CLOSING)' : ''}`,
    );
  }

  console.log(
    `   ✅ Reconstructed ${edges.length} edges forming ${edges.length === 4 ? 'a proper 4-edge loop' : 'an incomplete cycle'}`,
  );
  console.groupEnd();

  return edges;
}

/**
 * Calculate the average parallel error for opposite edges in a rectangle.
 * Used for rectangle scoring.
 *
 * CRITICAL: Parallel edges can point in opposite directions (0° or 180° apart).
 * Both should be treated as perfectly parallel (0° error).
 */
export function avgParallelError(edges: Edge[]): number {
  if (edges.length < 2) {
    console.log('   ⚠️ Parallel check: <2 edges, returning max error');
    return 180;
  }

  let totalError = 0;
  let count = 0;

  // For a rectangle, compare opposite edges (i with i+n/2)
  const n = edges.length;

  console.log(`   📏 Parallel Error Analysis (${n} edges):`);

  for (let i = 0; i < n; i++) {
    // Find the "opposite" edge (roughly n/2 positions away)
    const j = (i + Math.floor(n / 2)) % n;
    if (j <= i) continue; // Avoid duplicate pairs

    const angle_i = (edges[i].angle * 180) / Math.PI;
    const angle_j = (edges[j].angle * 180) / Math.PI;

    // Compute angular difference in degrees, normalized to [0, 180)
    const norm180 = (deg: number) => ((deg % 180) + 180) % 180;
    const a = norm180(angle_i);
    const b = norm180(angle_j);

    // Distance between angles in [0, 180) space
    let diff = Math.abs(a - b);

    // CRITICAL FIX: Fold to [0, 90] so that 0° and 180° both map to 0° error
    // This makes opposite-facing parallel edges register as 0° error
    const parallelError = Math.min(diff, 180 - diff);

    console.log(
      `      Edge ${i} (${angle_i.toFixed(1)}°) vs Edge ${j} (${angle_j.toFixed(1)}°): error = ${parallelError.toFixed(1)}°`,
    );

    totalError += parallelError;
    count++;
  }

  const avgError = count > 0 ? totalError / count : 180;
  console.log(`   → Average parallel error: ${avgError.toFixed(1)}°`);

  return avgError;
}

/**
 * Calculate the average orthogonal error for adjacent edges.
 * Used for rectangle scoring.
 *
 * CRITICAL FIX: Now uses length-weighted averaging so short noisy edges
 * don't dominate the metric.
 */
export function avgOrthogonalError(edges: Edge[]): number {
  if (edges.length < 2) {
    console.log('   ⚠️ Orthogonal check: <2 edges, returning max error');
    return 90;
  }

  let weightedError = 0;
  let totalWeight = 0;

  console.log(`   📐 Orthogonal Error Analysis (${edges.length} edges):`);

  // Helper to compute error between two angles
  const computeError = (a: number, b: number): number => {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const errorFromRight = Math.abs(Math.abs(d) - Math.PI / 2);
    return (errorFromRight * 180) / Math.PI; // Convert to degrees
  };

  // Adjacent pairs
  for (let i = 0; i < edges.length - 1; i++) {
    const errorDeg = computeError(edges[i].angle, edges[i + 1].angle);
    const weight = Math.min(edges[i].length, edges[i + 1].length); // Weight by shorter edge

    const angleDiff = edges[i + 1].angle - edges[i].angle;
    let normalizedDiff = angleDiff;
    while (normalizedDiff > Math.PI) normalizedDiff -= 2 * Math.PI;
    while (normalizedDiff < -Math.PI) normalizedDiff += 2 * Math.PI;

    console.log(
      `      Edge ${i}→${i + 1}: turn=${((normalizedDiff * 180) / Math.PI).toFixed(1)}°, error=${errorDeg.toFixed(1)}°, weight=${weight.toFixed(1)}`,
    );

    weightedError += errorDeg * weight;
    totalWeight += weight;
  }

  // Also check last to first edge (closing the loop)
  if (edges.length >= 3) {
    const i = edges.length - 1;
    const errorDeg = computeError(edges[i].angle, edges[0].angle);
    const weight = Math.min(edges[i].length, edges[0].length);

    const angleDiff = edges[0].angle - edges[i].angle;
    let normalizedDiff = angleDiff;
    while (normalizedDiff > Math.PI) normalizedDiff -= 2 * Math.PI;
    while (normalizedDiff < -Math.PI) normalizedDiff += 2 * Math.PI;

    console.log(
      `      Edge ${i}→0 (closing): turn=${((normalizedDiff * 180) / Math.PI).toFixed(1)}°, error=${errorDeg.toFixed(1)}°, weight=${weight.toFixed(1)}`,
    );

    weightedError += errorDeg * weight;
    totalWeight += weight;
  }

  const avgError = totalWeight > 0 ? weightedError / totalWeight : 90;
  console.log(`   → Average orthogonal error (length-weighted): ${avgError.toFixed(1)}°`);

  return avgError;
}

/**
 * Calculate coverage across distinct sides of a rectangle.
 * Returns a normalized value 0-1 representing how well points
 * are distributed across all sides of the rectangle.
 */
export function coverageAcrossDistinctSides(
  points: Vec2[],
  obb: { cx: number; cy: number; angle: number; hx: number; hy: number },
): number {
  if (points.length < 4) return 0;

  const { cx, cy, angle, hx, hy } = obb;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Count points on each side (with tolerance)
  const tolerance = Math.min(hx, hy) * 0.15; // 15% of smaller dimension
  let topCount = 0,
    bottomCount = 0,
    leftCount = 0,
    rightCount = 0;

  for (const [x, y] of points) {
    // Transform to box-local coordinates
    const dx = x - cx;
    const dy = y - cy;
    const localX = dx * cos + dy * sin;
    const localY = -dx * sin + dy * cos;

    // Check which side(s) this point is near
    const nearTop = Math.abs(localY - hy) < tolerance && Math.abs(localX) <= hx + tolerance;
    const nearBottom = Math.abs(localY + hy) < tolerance && Math.abs(localX) <= hx + tolerance;
    const nearLeft = Math.abs(localX + hx) < tolerance && Math.abs(localY) <= hy + tolerance;
    const nearRight = Math.abs(localX - hx) < tolerance && Math.abs(localY) <= hy + tolerance;

    if (nearTop) topCount++;
    if (nearBottom) bottomCount++;
    if (nearLeft) leftCount++;
    if (nearRight) rightCount++;
  }

  // Calculate coverage score (how many sides have points)
  const sidesWithPoints =
    (topCount > 0 ? 1 : 0) +
    (bottomCount > 0 ? 1 : 0) +
    (leftCount > 0 ? 1 : 0) +
    (rightCount > 0 ? 1 : 0);

  // Also consider distribution evenness
  const total = topCount + bottomCount + leftCount + rightCount;
  if (total === 0) return 0;

  const distribution = [topCount, bottomCount, leftCount, rightCount].map((c) => c / total);
  const maxDistribution = Math.max(...distribution);
  const evenness = 1 - (maxDistribution - 0.25) / 0.75; // Perfect is 0.25 each

  // Combine side coverage and evenness
  const coverage = sidesWithPoints / 4;
  return coverage * 0.7 + evenness * 0.3;
}

/**
 * Helper to compute average of top 3 values.
 * Used for corner confidence scoring.
 */
export function top3Avg(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3);
  return top3.reduce((sum, v) => sum + v, 0) / top3.length;
}

/**
 * Distance from a point to the nearest AABB edge.
 * Used for scoring how well points follow rectangle sides.
 */
export function aabbSideDist(
  x: number,
  y: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  // Distance to each side
  const dx = Math.min(Math.abs(x - minX), Math.abs(x - maxX));
  const dy = Math.min(Math.abs(y - minY), Math.abs(y - maxY));

  // Check if point is inside bbox
  const insideX = x >= minX && x <= maxX;
  const insideY = y >= minY && y <= maxY;

  if (insideX && insideY) {
    return Math.min(dx, dy); // Distance to nearest side
  }

  if (!insideX && insideY) {
    return Math.abs(x < minX ? minX - x : x - maxX);
  }

  if (insideX && !insideY) {
    return Math.abs(y < minY ? minY - y : y - maxY);
  }

  // Outside corner - distance to nearest corner
  const cx = x < minX ? minX : maxX;
  const cy = y < minY ? minY : maxY;
  return Math.hypot(x - cx, y - cy);
}

/**
 * Score how well points follow the AABB sides.
 * Returns fraction of points within epsilon of any side.
 */
export function aabbSideFitScore(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
  epsilonWU: number,
): number {
  let nearCount = 0;
  for (const [x, y] of points) {
    const dist = aabbSideDist(x, y, aabb.minX, aabb.minY, aabb.maxX, aabb.maxY);
    if (dist <= epsilonWU) {
      nearCount++;
    }
  }
  return nearCount / Math.max(1, points.length);
}

/**
 * Calculate how many distinct sides of AABB are visited.
 * Returns 0-1 score (0.25 per side visited).
 */
export function aabbSideCoverage(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
  epsilonWU: number,
): number {
  const sides = { left: false, right: false, top: false, bottom: false };

  for (const [x, y] of points) {
    if (Math.abs(x - aabb.minX) <= epsilonWU) sides.left = true;
    if (Math.abs(x - aabb.maxX) <= epsilonWU) sides.right = true;
    if (Math.abs(y - aabb.minY) <= epsilonWU) sides.top = true;
    if (Math.abs(y - aabb.maxY) <= epsilonWU) sides.bottom = true;
  }

  const count =
    (sides.left ? 1 : 0) + (sides.right ? 1 : 0) + (sides.top ? 1 : 0) + (sides.bottom ? 1 : 0);
  return count / 4;
}

/**
 * Calculate coverage across distinct sides of an AABB rectangle.
 * This mirrors the OBB implementation exactly but for axis-aligned boxes.
 * Returns a combined score of side coverage and evenness of distribution.
 */
export function aabbCoverageAcrossDistinctSides(
  points: Vec2[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  if (points.length < 4) return 0;

  const width = Math.max(1, aabb.maxX - aabb.minX);
  const height = Math.max(1, aabb.maxY - aabb.minY);
  const tol = Math.max(
    RECT_AABB_COVERAGE_MIN_TOL,
    RECT_AABB_COVERAGE_TOLERANCE_FACTOR * Math.min(width, height),
  );

  let top = 0,
    bottom = 0,
    left = 0,
    right = 0;

  for (const [x, y] of points) {
    // Check proximity to each side with tolerance
    const nearTop = Math.abs(y - aabb.minY) <= tol && x >= aabb.minX - tol && x <= aabb.maxX + tol;
    const nearBottom =
      Math.abs(y - aabb.maxY) <= tol && x >= aabb.minX - tol && x <= aabb.maxX + tol;
    const nearLeft = Math.abs(x - aabb.minX) <= tol && y >= aabb.minY - tol && y <= aabb.maxY + tol;
    const nearRight =
      Math.abs(x - aabb.maxX) <= tol && y >= aabb.minY - tol && y <= aabb.maxY + tol;

    if (nearTop) top++;
    if (nearBottom) bottom++;
    if (nearLeft) left++;
    if (nearRight) right++;
  }

  const sidesWithPoints =
    (top > 0 ? 1 : 0) + (bottom > 0 ? 1 : 0) + (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
  const total = top + bottom + left + right;
  if (total === 0) return 0;

  // Calculate distribution evenness
  const distribution = [top, bottom, left, right].map((c) => c / total);
  const maxDistribution = Math.max(...distribution);
  const evenness = 1 - (maxDistribution - 0.25) / 0.75; // identical to OBB

  const coverage = sidesWithPoints / 4;
  return coverage * 0.7 + evenness * 0.3; // identical to OBB weighting
}

/**
 * Check if a stroke self-intersects (excluding adjacent segments and endpoints).
 * Uses a naive O(n²) segment intersection test with fast bbox rejection.
 *
 * @param pointsFlat - Flat array of points [x0,y0, x1,y1, ...] (decimated/cleaned)
 * @param epsWU - World unit tolerance for intersection detection
 * @returns true if the stroke self-intersects
 */
export function hasSelfIntersection(pointsFlat: number[], epsWU: number): boolean {
  const n = pointsFlat.length;
  if (n < 8) return false; // fewer than 4 points => <=3 segments, can't self-intersect

  // Build segments (skip degenerate ones shorter than epsWU)
  interface Segment {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  }

  const segs: Segment[] = [];
  for (let i = 0; i <= n - 4; i += 2) {
    const x1 = pointsFlat[i],
      y1 = pointsFlat[i + 1];
    const x2 = pointsFlat[i + 2],
      y2 = pointsFlat[i + 3];

    // Skip degenerate segments
    if (Math.hypot(x2 - x1, y2 - y1) < epsWU) continue;

    segs.push({
      x1,
      y1,
      x2,
      y2,
      minx: Math.min(x1, x2) - epsWU,
      miny: Math.min(y1, y2) - epsWU,
      maxx: Math.max(x1, x2) + epsWU,
      maxy: Math.max(y1, y2) + epsWU,
    });
  }

  if (segs.length < 3) return false; // Need at least 3 segments to self-intersect

  // Helper: Check if two bounding boxes overlap
  const boxesOverlap = (a: Segment, b: Segment): boolean => {
    return !(a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny);
  };

  // Helper: Compute orientation of ordered triplet (a,b,c)
  // Returns: 0 if collinear, 1 if CW, -1 if CCW
  const orient = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): number => {
    const val = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(val) < epsWU * epsWU) return 0; // Near-collinear
    return Math.sign(val);
  };

  // Helper: Check if two segments properly intersect (excluding endpoints)
  const properIntersect = (a: Segment, b: Segment): boolean => {
    // Fast bbox rejection
    if (!boxesOverlap(a, b)) return false;

    // Compute orientations
    const o1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
    const o2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
    const o3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
    const o4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);

    // Collinear segments are not considered as crossing
    // (avoids over-firing on nearly straight lines with micro-wobbles)
    if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) return false;

    // Proper intersection: segments must have endpoints on opposite sides
    return o1 * o2 < 0 && o3 * o4 < 0;
  };

  // Check all segment pairs (skip adjacent and first-last)
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      // Skip adjacent segments (share a point)
      if (j === i + 1) continue;

      // Skip first-last pair if stroke is closed (shared endpoint)
      if (i === 0 && j === segs.length - 1) {
        // Check if endpoints are close (closed stroke)
        const dx = segs[j].x2 - segs[0].x1;
        const dy = segs[j].y2 - segs[0].y1;
        if (dx * dx + dy * dy < epsWU * epsWU) continue;
      }

      if (properIntersect(segs[i], segs[j])) {
        return true; // Found self-intersection
      }
    }
  }

  return false; // No self-intersections found
}

/**
 * Calculate the minimum distance from a point to a line segment.
 * Used for near-touch detection.
 *
 * @param px - Point X coordinate
 * @param py - Point Y coordinate
 * @param x1 - Segment start X
 * @param y1 - Segment start Y
 * @param x2 - Segment end X
 * @param y2 - Segment end Y
 * @returns Distance from point to segment
 */
function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    // Degenerate segment - just point distance
    return Math.hypot(px - x1, py - y1);
  }

  // Project point onto line (parameterized by t)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));

  // Find closest point on segment
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  return Math.hypot(px - closestX, py - closestY);
}

/**
 * Check if a stroke has segments that come very close to each other
 * without actually crossing (near self-touch).
 *
 * @param pointsFlat - Flat array of points [x0,y0, x1,y1, ...] (decimated/cleaned)
 * @param epsWU - World unit tolerance for near-touch detection
 * @returns true if the stroke has near self-touches
 */
export function hasNearTouch(pointsFlat: number[], epsWU: number): boolean {
  const n = pointsFlat.length;
  if (n < 8) return false; // Need at least 4 points for non-adjacent segments

  // Build segments (skip degenerate ones)
  interface Segment {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  }

  const segs: Segment[] = [];
  for (let i = 0; i <= n - 4; i += 2) {
    const x1 = pointsFlat[i],
      y1 = pointsFlat[i + 1];
    const x2 = pointsFlat[i + 2],
      y2 = pointsFlat[i + 3];

    // Skip degenerate segments
    if (Math.hypot(x2 - x1, y2 - y1) < epsWU) continue;

    segs.push({
      x1,
      y1,
      x2,
      y2,
      minx: Math.min(x1, x2) - epsWU,
      miny: Math.min(y1, y2) - epsWU,
      maxx: Math.max(x1, x2) + epsWU,
      maxy: Math.max(y1, y2) + epsWU,
    });
  }

  if (segs.length < 3) return false; // Need at least 3 segments for near-touch

  // Helper: Check if two bounding boxes overlap
  const boxesOverlap = (a: Segment, b: Segment): boolean => {
    return !(a.maxx < b.minx || b.maxx < a.minx || a.maxy < b.miny || b.maxy < a.miny);
  };

  // Helper: Compute minimum distance between two segments
  const segmentDistance = (a: Segment, b: Segment): number => {
    // Quick bbox rejection
    if (!boxesOverlap(a, b)) return Infinity;

    // Check all 4 point-to-segment distances
    const d1 = pointToSegmentDistance(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2);
    const d2 = pointToSegmentDistance(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2);
    const d3 = pointToSegmentDistance(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2);
    const d4 = pointToSegmentDistance(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2);

    return Math.min(d1, d2, d3, d4);
  };

  // Check all non-adjacent segment pairs
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      // Skip adjacent segments (they share a point)
      if (j === i + 1) continue;

      // Skip first-last pair if stroke is closed
      if (i === 0 && j === segs.length - 1) {
        // Check if endpoints are close (closed stroke)
        const dx = segs[j].x2 - segs[0].x1;
        const dy = segs[j].y2 - segs[0].y1;
        if (dx * dx + dy * dy < epsWU * epsWU) continue;
      }

      if (segmentDistance(segs[i], segs[j]) < epsWU) {
        return true; // Found near-touch
      }
    }
  }

  return false; // No near-touches found
}
