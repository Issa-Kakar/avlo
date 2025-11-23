import { STROKE_CONFIG } from '@avlo/shared';

export interface SimplificationResult {
  points: number[];
  simplified: boolean;
  retries: number;
}

export function calculateBBox(
  points: number[] | [number, number][],
  strokeSize: number = 0,
): [number, number, number, number] | null {
  // Handle both flat arrays and tuple arrays
  if (Array.isArray(points) && points.length === 0) return null;

  let minX: number, minY: number, maxX: number, maxY: number;

  // Check if it's a tuple array
  if (Array.isArray(points[0])) {
    // Tuple array: [number, number][]
    const tuplePoints = points as [number, number][];
    if (tuplePoints.length < 1) return null;

    minX = tuplePoints[0][0];
    minY = tuplePoints[0][1];
    maxX = tuplePoints[0][0];
    maxY = tuplePoints[0][1];

    for (let i = 1; i < tuplePoints.length; i++) {
      const [x, y] = tuplePoints[i];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  } else {
    // Flat array: number[]
    const flatPoints = points as number[];
    if (flatPoints.length < 2) return null;

    minX = flatPoints[0];
    minY = flatPoints[1];
    maxX = flatPoints[0];
    maxY = flatPoints[1];

    for (let i = 2; i < flatPoints.length; i += 2) {
      minX = Math.min(minX, flatPoints[i]);
      maxX = Math.max(maxX, flatPoints[i]);
      minY = Math.min(minY, flatPoints[i + 1]);
      maxY = Math.max(maxY, flatPoints[i + 1]);
    }
  }

  // CRITICAL: Inflate bounds for proper invalidation
  // This is in WORLD units (DPR handled at canvas level)
  const padding = strokeSize * 0.5 + 1;
  return [minX - padding, minY - padding, maxX + padding, maxY + padding];
}

export function estimateEncodedSize(points: number[]): number {
  // Yjs encoding estimate including CRDT overhead
  // points is a flat array [x0,y0,x1,y1,...] where points.length = numCoordinates
  // Each coordinate (number) in the array contributes:
  // - 8 bytes for the float64 value
  // - ~8 bytes for CRDT metadata (item ID, left/right refs, etc.)
  // Total: ~16 bytes per coordinate
  const pointsOverhead = points.length * 16; // points.length is number of coordinates
  const strokeMetadata = 500; // id, tool, color, bbox, etc.
  const updateEnvelope = 1024; // Yjs update wrapper and state vectors
  return pointsOverhead + strokeMetadata + updateEnvelope;
}

export function simplifyStroke(
  points: number[],
  tool: 'pen' | 'highlighter',
): SimplificationResult {
  // Minimum 2 points (4 values) required
  if (points.length < 4) {
    return { points, simplified: false, retries: 0 };
  }

  const baseTol =
    tool === 'pen'
      ? STROKE_CONFIG.PEN_SIMPLIFICATION_TOLERANCE
      : STROKE_CONFIG.HIGHLIGHTER_SIMPLIFICATION_TOLERANCE;

  let tolerance = baseTol;
  let simplified = douglasPeucker(points, tolerance);
  let retries = 0;

  // Check constraints
  const size = estimateEncodedSize(simplified);
  const count = simplified.length / 2;

  if (size > STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES || count > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
    // One retry with increased tolerance
    tolerance *= STROKE_CONFIG.SIMPLIFICATION_TOLERANCE_MULTIPLIER;

    // Cap highlighter tolerance
    if (tool === 'highlighter') {
      tolerance = Math.min(tolerance, baseTol * STROKE_CONFIG.HIGHLIGHTER_TOLERANCE_MAX_MULTIPLIER);
    }

    simplified = douglasPeucker(points, tolerance);
    retries = 1;

    // Still too big? Hard downsample
    if (simplified.length / 2 > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
      simplified = hardDownsample(simplified, STROKE_CONFIG.MAX_POINTS_PER_STROKE);
    }

    // CRITICAL: Re-check 128KB budget after downsample
    const finalSize = estimateEncodedSize(simplified);
    if (finalSize > STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES) {
      // Still exceeds budget even after downsample - stroke is too complex
      console.error(
        `Stroke still too large after downsample: ${finalSize} bytes (max: ${STROKE_CONFIG.MAX_STROKE_UPDATE_BYTES})`,
      );
      return { points: [], simplified: false, retries }; // Return empty to signal rejection
    }
  }

  return { points: simplified, simplified: true, retries };
}

function douglasPeucker(points: number[], tolerance: number): number[] {
  if (points.length < 4) return points; // Less than 2 points

  const numPoints = points.length / 2;

  // CRITICAL FIX: Iterative implementation to prevent stack overflow on long strokes
  // Uses explicit stack instead of recursion to handle 10k+ point strokes safely
  const keep = new Uint8Array(numPoints);
  keep[0] = 1; // Always keep first point
  keep[numPoints - 1] = 1; // Always keep last point

  const stack: Array<[number, number]> = [[0, numPoints - 1]];

  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;

    if (endIdx - startIdx < 2) continue; // No intermediate points

    // Find point with maximum distance from line segment
    let maxDist = 0;
    let maxIdx = -1;

    const x1 = points[startIdx * 2],
      y1 = points[startIdx * 2 + 1];
    const x2 = points[endIdx * 2],
      y2 = points[endIdx * 2 + 1];

    for (let i = startIdx + 1; i < endIdx; i++) {
      const x = points[i * 2],
        y = points[i * 2 + 1];
      const dist = perpendicularDistance(x, y, x1, y1, x2, y2);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    // If max distance exceeds tolerance, keep the point and recurse
    if (maxDist >= tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([startIdx, maxIdx]);
      stack.push([maxIdx, endIdx]);
    }
  }

  // Reconstruct simplified points from keep array
  const result: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    if (keep[i]) {
      result.push(points[i * 2], points[i * 2 + 1]);
    }
  }

  return result;
}

function perpendicularDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const norm = Math.sqrt(dx * dx + dy * dy);

  if (norm === 0) {
    return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  }

  return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
}

function hardDownsample(points: number[], maxPoints: number): number[] {
  const numPoints = points.length / 2;
  if (numPoints <= maxPoints) return points;

  const result: number[] = [];
  const step = (numPoints - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints - 1; i++) {
    const idx = Math.floor(i * step);
    result.push(points[idx * 2], points[idx * 2 + 1]);
  }

  // Always include the last point
  result.push(points[points.length - 2], points[points.length - 1]);

  return result;
}
