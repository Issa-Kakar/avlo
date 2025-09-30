import { Vec2 } from './types';

/**
 * Fit a circle to a set of 2D points using the Taubin algebraic method.
 * This method is robust for partial arcs and provides good results even
 * when points don't form a complete circle.
 *
 * Returns the center (cx, cy), radius r, and RMS of residuals.
 */
export function fitCircle(points: Vec2[]): {
  cx: number;
  cy: number;
  r: number;
  residualRMS: number;
} {
  const n = points.length;

  // Handle degenerate cases
  if (n < 3) {
    const cx = points.reduce((sum, p) => sum + p[0], 0) / n;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / n;
    const r = n === 2
      ? Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) / 2
      : 10;
    return { cx, cy, r, residualRMS: 0 };
  }

  // Step 1: Compute centroid (mean of points)
  let sumX = 0, sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  // Step 2: Shift points to centroid and compute moments
  let Mxx = 0, Myy = 0, Mxy = 0;
  let Mxz = 0, Myz = 0, Mzz = 0;

  for (const [x, y] of points) {
    const xi = x - meanX;
    const yi = y - meanY;
    const zi = xi * xi + yi * yi;

    Mxx += xi * xi;
    Myy += yi * yi;
    Mxy += xi * yi;
    Mxz += xi * zi;
    Myz += yi * zi;
    Mzz += zi * zi;
  }

  // Normalize moments
  Mxx /= n;
  Myy /= n;
  Mxy /= n;
  Mxz /= n;
  Myz /= n;
  Mzz /= n;

  // Step 3: Build coefficients for the characteristic polynomial
  const Mz = Mxx + Myy; // trace of 2x2 covariance
  const Cov_xy = Mxx * Myy - Mxy * Mxy; // determinant
  const A3 = 4 * Mz;
  const A2 = -3 * Mz * Mz - Mzz;
  const A1 = Mzz * Mz + 4 * Cov_xy * Mz - Mxz * Mxz - Myz * Myz - Mz * Mz * Mz;
  const A0 = Mxz * Mxz * Myy + Myz * Myz * Mxx - Mzz * Cov_xy - 2 * Mxz * Myz * Mxy + Mz * Mz * Cov_xy;

  // Step 4: Find the root using Newton's method
  let x = 0; // initial guess
  for (let iter = 0; iter < 20; iter++) {
    const y = A0 + x * (A1 + x * (A2 + x * A3));
    const dy = A1 + x * (2 * A2 + x * 3 * A3);

    if (Math.abs(dy) < 1e-12) break;
    const dx = y / dy;
    x -= dx;
    if (Math.abs(dx) < 1e-12) break;
  }

  // Step 5: Compute circle parameters from the root
  const DET = x * x - x * Mz + Cov_xy;

  // Check for numerical stability
  if (Math.abs(DET) < 1e-10) {
    // Fallback: simple centroid and average distance
    const cx = meanX;
    const cy = meanY;
    let sumDist = 0;
    for (const [px, py] of points) {
      sumDist += Math.hypot(px - cx, py - cy);
    }
    const r = sumDist / n;
    return { cx, cy, r, residualRMS: 0 };
  }

  // Calculate center
  const cx = meanX + (Mxz * (Myy - x) - Myz * Mxy) / (2 * DET);
  const cy = meanY + (Myz * (Mxx - x) - Mxz * Mxy) / (2 * DET);

  // Calculate radius
  const r2 = (Mxx + Myy - 2 * x) / 2 + (cx - meanX) * (cx - meanX) + (cy - meanY) * (cy - meanY);
  const r = Math.sqrt(Math.max(0, r2));

  // Step 6: Compute RMS of residuals (distance from points to circle)
  let sumSquaredResiduals = 0;
  for (const [px, py] of points) {
    const dist = Math.hypot(px - cx, py - cy);
    const residual = dist - r;
    sumSquaredResiduals += residual * residual;
  }
  const residualRMS = Math.sqrt(sumSquaredResiduals / n);

  return { cx, cy, r, residualRMS };
}