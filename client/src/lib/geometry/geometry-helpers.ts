import { Vec2, Edge, Corner } from './types';

/**
 * Compute the axis ratio from PCA eigenvalues.
 * Returns sqrt(λ₁/λ₂) where λ₁ ≥ λ₂.
 * Used for circle roundness scoring and gating.
 */
export function pcaAxisRatio(points: Vec2[]): number {
  const n = points.length;
  if (n < 2) return 1;

  // Compute centroid
  let sumX = 0, sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const cx = sumX / n;
  const cy = sumY / n;

  // Build covariance matrix
  let cxx = 0, cxy = 0, cyy = 0;
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
  for (let i = 0; i < n; i++) {
    const gap = i === n - 1
      ? (angles[0] + 2 * Math.PI) - angles[i]  // Gap wrapping around from last to first
      : angles[i + 1] - angles[i];
    maxGap = Math.max(maxGap, gap);
  }

  // Coverage is the portion of the circle that IS covered
  const coverage = (2 * Math.PI - maxGap) / (2 * Math.PI);
  return Math.max(0, Math.min(1, coverage));
}

/**
 * Detect corners in a stroke where angle changes significantly.
 * A corner is where the turn angle > 45° and both adjacent segments
 * are at least minSegmentLength world units.
 */
export function detectCorners(
  points: Vec2[],
  minSegmentLength: number = 10,
  minTurnAngleDeg: number = 45
): Corner[] {
  const n = points.length;
  if (n < 3) return [];

  const corners: Corner[] = [];
  const minTurnAngleRad = minTurnAngleDeg * Math.PI / 180;

  for (let i = 1; i < n - 1; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];

    // Check segment lengths
    const len1 = Math.hypot(x1 - x0, y1 - y0);
    const len2 = Math.hypot(x2 - x1, y2 - y1);
    if (len1 < minSegmentLength || len2 < minSegmentLength) continue;

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
      const cornerAngleDeg = Math.abs(turnAngle) * 180 / Math.PI;
      corners.push({
        index: i,
        angle: cornerAngleDeg,
        strength: Math.min(1, absTurnAngle / (Math.PI / 2))
      });
    }
  }

  return corners;
}

/**
 * Detect edges between corners in a stroke.
 * Edges are straight segments between detected corners.
 */
export function detectEdges(
  points: Vec2[],
  corners: Corner[],
  minIndexDelta: number = 3
): Edge[] {
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
      length
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
  minIndexDelta: number = 3
): { edges: Edge[]; corners: Corner[] } {
  const corners = detectCorners(points, minSegmentLength, minTurnAngleDeg);
  const edges = detectEdges(points, corners, minIndexDelta);
  return { edges, corners };
}

/**
 * Calculate the average parallel error for opposite edges in a rectangle.
 * Used for rectangle scoring.
 */
export function avgParallelError(edges: Edge[]): number {
  if (edges.length < 2) return 180;

  let totalError = 0;
  let count = 0;

  // Check pairs of edges
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 2; j < Math.min(i + 3, edges.length); j++) {
      // Compare edge i with edge j (potentially opposite edges)
      let angleDiff = Math.abs(edges[i].angle - edges[j].angle);

      // Normalize to [0, π]
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

      // Convert to degrees
      totalError += angleDiff * 180 / Math.PI;
      count++;
    }
  }

  return count > 0 ? totalError / count : 180;
}

/**
 * Calculate the average orthogonal error for adjacent edges.
 * Used for rectangle scoring.
 */
export function avgOrthogonalError(edges: Edge[]): number {
  if (edges.length < 2) return 90;

  let totalError = 0;
  let count = 0;

  for (let i = 0; i < edges.length - 1; i++) {
    let angleDiff = edges[i + 1].angle - edges[i].angle;

    // Normalize to [-π, π]
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Distance from 90 degrees
    const errorFromRight = Math.abs(Math.abs(angleDiff) - Math.PI / 2);
    totalError += errorFromRight * 180 / Math.PI;
    count++;
  }

  // Also check last to first edge (closing the loop)
  if (edges.length >= 3) {
    let angleDiff = edges[0].angle - edges[edges.length - 1].angle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    const errorFromRight = Math.abs(Math.abs(angleDiff) - Math.PI / 2);
    totalError += errorFromRight * 180 / Math.PI;
    count++;
  }

  return count > 0 ? totalError / count : 90;
}

/**
 * Calculate coverage across distinct sides of a rectangle.
 * Returns a normalized value 0-1 representing how well points
 * are distributed across all sides of the rectangle.
 */
export function coverageAcrossDistinctSides(
  points: Vec2[],
  obb: { cx: number; cy: number; angle: number; hx: number; hy: number }
): number {
  if (points.length < 4) return 0;

  const { cx, cy, angle, hx, hy } = obb;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Count points on each side (with tolerance)
  const tolerance = Math.min(hx, hy) * 0.15; // 15% of smaller dimension
  let topCount = 0, bottomCount = 0, leftCount = 0, rightCount = 0;

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

  const distribution = [topCount, bottomCount, leftCount, rightCount].map(c => c / total);
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