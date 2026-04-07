import { Vec2 } from './types';

/**
 * Fit an Oriented Bounding Box (OBB) to a set of 2D points using PCA.
 * PCA finds the principal axes along which the data varies most.
 *
 * Returns:
 * - cx, cy: center of the box
 * - angle: rotation angle of the box (radians)
 * - hx, hy: half-extents (half width and half height) along the box's local axes
 */
export function fitOBB(points: Vec2[]): {
  cx: number;
  cy: number;
  angle: number;
  hx: number;
  hy: number;
} {
  const n = points.length;

  // Handle degenerate cases
  if (n < 2) {
    const cx = n === 1 ? points[0][0] : 0;
    const cy = n === 1 ? points[0][1] : 0;
    return { cx, cy, angle: 0, hx: 10, hy: 10 };
  }

  // Step 1: Compute centroid
  let sumX = 0,
    sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const centroidX = sumX / n;
  const centroidY = sumY / n;

  // Step 2: Build covariance matrix
  let cxx = 0,
    cxy = 0,
    cyy = 0;
  for (const [x, y] of points) {
    const dx = x - centroidX;
    const dy = y - centroidY;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }

  // Normalize covariance
  cxx /= n;
  cxy /= n;
  cyy /= n;

  // Step 3: Compute eigenvalues and eigenvectors of 2x2 covariance matrix
  // For symmetric 2x2 matrix [[a,b],[b,c]]:
  // Eigenvalues: λ = (trace ± sqrt(trace²-4*det)) / 2
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * det));

  const lambda1 = (trace + discriminant) / 2; // Larger eigenvalue
  // Note: lambda2 = (trace - discriminant) / 2 (smaller eigenvalue, not needed for OBB)

  // Step 4: Find the eigenvector for the larger eigenvalue (principal direction)
  let angle: number;

  if (Math.abs(cxy) > 1e-10) {
    // Standard case: use the eigenvector equation
    // For eigenvalue λ1, eigenvector satisfies: (cxx - λ1)v1 + cxy*v2 = 0
    // Which gives us the direction
    const v1 = cxy;
    const v2 = lambda1 - cxx;
    angle = Math.atan2(v2, v1);
  } else if (Math.abs(cxx - cyy) < 1e-10) {
    // Isotropic case: variance equal in all directions
    angle = 0;
  } else if (cxx > cyy) {
    // X-aligned: variance is larger in X direction
    angle = 0;
  } else {
    // Y-aligned: variance is larger in Y direction
    angle = Math.PI / 2;
  }

  // Step 5: Project all points onto the principal axes to find extents
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const [x, y] of points) {
    // Transform to local coordinate system aligned with principal axes
    const dx = x - centroidX;
    const dy = y - centroidY;
    const localX = dx * cos + dy * sin; // Project onto first principal axis
    const localY = -dx * sin + dy * cos; // Project onto second principal axis

    minX = Math.min(minX, localX);
    maxX = Math.max(maxX, localX);
    minY = Math.min(minY, localY);
    maxY = Math.max(maxY, localY);
  }

  // Step 6: Compute half-extents and adjust center
  const hx = (maxX - minX) / 2;
  const hy = (maxY - minY) / 2;

  // The true center of the bounding box might differ from the centroid
  // if points are unevenly distributed
  const boxCenterLocalX = (minX + maxX) / 2;
  const boxCenterLocalY = (minY + maxY) / 2;

  // Transform the box center back to world coordinates
  const cx = centroidX + boxCenterLocalX * cos - boxCenterLocalY * sin;
  const cy = centroidY + boxCenterLocalX * sin + boxCenterLocalY * cos;

  // Ensure non-zero extents
  return {
    cx,
    cy,
    angle,
    hx: Math.max(1, hx),
    hy: Math.max(1, hy),
  };
}
