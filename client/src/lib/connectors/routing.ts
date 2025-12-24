/**
 * Orthogonal Routing Algorithm
 *
 * Computes orthogonal (right-angle) routes between connector endpoints.
 * Supports L-routes (1 bend), Z-routes (2 bends), and dogleg routes.
 *
 * Algorithm:
 * 1. Resolve endpoint positions + directions
 * 2. Add jetty offsets (stubs before first turn)
 * 3. Generate route candidates (L, Z patterns)
 * 4. Pick best route (fewest bends, shortest length, stability)
 * 5. Simplify (remove collinear points)
 *
 * @module lib/connectors/routing
 */

import { ROUTING_CONFIG } from './constants';
import { getOutwardVector, type Dir } from './shape-utils';

/**
 * Route result with full path and signature.
 */
export interface RouteResult {
  /** Full path including endpoints [from, ...waypoints, to] */
  points: [number, number][];
  /** Route signature for stability (e.g., 'H', 'HV', 'HVH') */
  signature: string;
}

/**
 * Endpoint definition for routing.
 */
export interface RouteEndpoint {
  /** Position in world coordinates */
  pos: [number, number];
  /** Outward direction from endpoint */
  dir: Dir;
  /** Is this endpoint attached to a shape? */
  isAttached: boolean;
  /** Target shape bounds for self-intersection avoidance (optional) */
  shapeBounds?: { x: number; y: number; w: number; h: number };
}

/**
 * Internal route candidate for comparison.
 */
interface RouteCandidate {
  /** Intermediate points between jetties */
  midPoints: [number, number][];
  /** Number of bends */
  bends: number;
  /** Total path length */
  length: number;
  /** Route signature */
  signature: string;
}

/**
 * Check if an orthogonal path crosses through a rectangle.
 * Excludes the final segment (toJetty → to.pos) which is supposed to touch the shape.
 *
 * @param path - Array of [x, y] points forming the path
 * @param rect - Target shape bounds to check against
 * @param toJetty - The toJetty point (to identify final segment to skip)
 * @returns true if any segment (except final) crosses through the rect interior
 */
function pathCrossesRect(
  path: [number, number][],
  rect: { x: number; y: number; w: number; h: number },
  toJetty: [number, number]
): boolean {
  const { x, y, w, h } = rect;

  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];

    // Skip the final segment (toJetty → to.pos) - it's supposed to touch the shape
    if (x1 === toJetty[0] && y1 === toJetty[1]) continue;

    // For orthogonal segments:
    if (Math.abs(x1 - x2) < 0.001) {
      // Vertical segment: check if X is inside rect AND Y range crosses rect
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      if (x1 > x && x1 < x + w && maxY > y && minY < y + h) {
        return true;
      }
    } else {
      // Horizontal segment: check if Y is inside rect AND X range crosses rect
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      if (y1 > y && y1 < y + h && maxX > x && minX < x + w) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Generate dogleg candidates that route around the target shape.
 * Used as fallback when all standard routes cross through the shape.
 *
 * @param s - Start jetty point
 * @param t - End jetty point
 * @param dogleg - Offset distance from shape edge
 * @param shapeBounds - Target shape bounds to route around
 * @returns Array of dogleg route candidates
 */
function generateDoglegCandidates(
  s: [number, number],
  t: [number, number],
  dogleg: number,
  shapeBounds?: { x: number; y: number; w: number; h: number }
): RouteCandidate[] {
  if (!shapeBounds) return [];

  const { x, y, w, h } = shapeBounds;
  const candidates: RouteCandidate[] = [];

  // Go left of shape
  const leftX = x - dogleg;
  candidates.push({
    midPoints: [[leftX, s[1]], [leftX, t[1]]],
    bends: 2,
    length: Math.abs(leftX - s[0]) + Math.abs(t[1] - s[1]) + Math.abs(t[0] - leftX),
    signature: 'HVH-L',
  });

  // Go right of shape
  const rightX = x + w + dogleg;
  candidates.push({
    midPoints: [[rightX, s[1]], [rightX, t[1]]],
    bends: 2,
    length: Math.abs(rightX - s[0]) + Math.abs(t[1] - s[1]) + Math.abs(t[0] - rightX),
    signature: 'HVH-R',
  });

  // Go above shape
  const topY = y - dogleg;
  candidates.push({
    midPoints: [[s[0], topY], [t[0], topY]],
    bends: 2,
    length: Math.abs(topY - s[1]) + Math.abs(t[0] - s[0]) + Math.abs(t[1] - topY),
    signature: 'VHV-T',
  });

  // Go below shape
  const bottomY = y + h + dogleg;
  candidates.push({
    midPoints: [[s[0], bottomY], [t[0], bottomY]],
    bends: 2,
    length: Math.abs(bottomY - s[1]) + Math.abs(t[0] - s[0]) + Math.abs(t[1] - bottomY),
    signature: 'VHV-B',
  });

  return candidates;
}

/**
 * Compute orthogonal route between two endpoints.
 *
 * @param from - Start endpoint with position and direction
 * @param to - End endpoint with position and direction
 * @param prevSignature - Previous route signature for stability (optional)
 * @returns Route result with full path and signature
 */
export function computeRoute(
  from: RouteEndpoint,
  to: RouteEndpoint,
  prevSignature: string | null
): RouteResult {
  // Use world-space constants directly (NOT scaled by zoom)
  // Routing geometry is permanent - must not change based on zoom level
  const jettyW = ROUTING_CONFIG.JETTY_W;
  const doglegW = ROUTING_CONFIG.DOGLEG_W;

  // Compute jetty points (stubs extending from endpoints)
  const fromVec = getOutwardVector(from.dir);
  const toVec = getOutwardVector(to.dir);

  const fromJetty: [number, number] = [
    from.pos[0] + fromVec[0] * jettyW,
    from.pos[1] + fromVec[1] * jettyW,
  ];

  const toJetty: [number, number] = [
    to.pos[0] + toVec[0] * jettyW,
    to.pos[1] + toVec[1] * jettyW,
  ];

  // Generate route candidates between jetty points
  let candidates = generateRouteCandidates(fromJetty, toJetty, from.dir, to.dir, doglegW);

  // FILTER 1: When target is free (not snapped), only allow 3-segment routes
  // Choose HVH vs VHV based on source exit direction for stability
  if (!to.isAttached) {
    const fromHorizontal = from.dir === 'E' || from.dir === 'W';
    const preferredSig = fromHorizontal ? 'HVH' : 'VHV';

    // Remove L-routes (HV, VH) and non-preferred 3-segment route
    candidates = candidates.filter(
      (c) =>
        c.signature !== 'HV' &&
        c.signature !== 'VH' &&
        c.signature !== 'H' &&
        c.signature !== 'V' &&
        (c.signature === preferredSig || c.signature.startsWith(preferredSig))
    );
  }

  // FILTER 2: Remove routes that cross through target shape
  if (to.shapeBounds) {
    candidates = candidates.filter((c) => {
      const fullPath: [number, number][] = [from.pos, fromJetty, ...c.midPoints, toJetty, to.pos];
      return !pathCrossesRect(fullPath, to.shapeBounds!, toJetty);
    });
  }

  // Fallback: if all filtered out, use dogleg routes around the shape
  if (candidates.length === 0) {
    candidates = generateDoglegCandidates(fromJetty, toJetty, doglegW, to.shapeBounds);
  }

  // Pick best candidate
  const best = pickBestRoute(candidates, prevSignature);

  // Assemble full path: from → fromJetty → route → toJetty → to
  const fullPath: [number, number][] = [
    from.pos,
    fromJetty,
    ...best.midPoints,
    toJetty,
    to.pos,
  ];

  // Simplify: remove collinear points
  const simplified = simplifyOrthogonal(fullPath);

  return {
    points: simplified,
    signature: computeSignature(simplified),
  };
}

/**
 * Generate all valid route candidates between two jetty points.
 */
function generateRouteCandidates(
  s: [number, number], // Start jetty
  t: [number, number], // End jetty
  fromDir: Dir,
  toDir: Dir,
  dogleg: number
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];

  const fromH = fromDir === 'E' || fromDir === 'W';
  const toH = toDir === 'E' || toDir === 'W';

  // 1. Straight line (if aligned)
  if ((s[0] === t[0] && !fromH && !toH) || (s[1] === t[1] && fromH && toH)) {
    candidates.push({
      midPoints: [],
      bends: 0,
      length: Math.abs(s[0] - t[0]) + Math.abs(s[1] - t[1]),
      signature: fromH ? 'H' : 'V',
    });
  }

  // 2. L-route: horizontal first, then vertical (HV)
  candidates.push({
    midPoints: [[t[0], s[1]]],
    bends: 1,
    length: Math.abs(t[0] - s[0]) + Math.abs(t[1] - s[1]),
    signature: 'HV',
  });

  // 3. L-route: vertical first, then horizontal (VH)
  candidates.push({
    midPoints: [[s[0], t[1]]],
    bends: 1,
    length: Math.abs(t[0] - s[0]) + Math.abs(t[1] - s[1]),
    signature: 'VH',
  });

  // 4. Z-route: HVH (horizontal-vertical-horizontal)
  const midX = (s[0] + t[0]) / 2;
  candidates.push({
    midPoints: [
      [midX, s[1]],
      [midX, t[1]],
    ],
    bends: 2,
    length: Math.abs(midX - s[0]) + Math.abs(t[1] - s[1]) + Math.abs(t[0] - midX),
    signature: 'HVH',
  });

  // 5. Z-route: VHV (vertical-horizontal-vertical)
  const midY = (s[1] + t[1]) / 2;
  candidates.push({
    midPoints: [
      [s[0], midY],
      [t[0], midY],
    ],
    bends: 2,
    length: Math.abs(midY - s[1]) + Math.abs(t[0] - s[0]) + Math.abs(t[1] - midY),
    signature: 'VHV',
  });

  // 6. Dogleg routes (for when target is "behind" source)
  // HVH with positive offset
  candidates.push({
    midPoints: [
      [Math.max(s[0], t[0]) + dogleg, s[1]],
      [Math.max(s[0], t[0]) + dogleg, t[1]],
    ],
    bends: 2,
    length: Infinity, // Penalize
    signature: 'HVH+',
  });

  // HVH with negative offset
  candidates.push({
    midPoints: [
      [Math.min(s[0], t[0]) - dogleg, s[1]],
      [Math.min(s[0], t[0]) - dogleg, t[1]],
    ],
    bends: 2,
    length: Infinity, // Penalize
    signature: 'HVH-',
  });

  return candidates;
}

/**
 * Pick the best route from candidates.
 * Prioritizes: fewer bends > shorter length > previous signature match
 */
function pickBestRoute(
  candidates: RouteCandidate[],
  prevSignature: string | null
): RouteCandidate {
  return candidates.reduce((best, curr) => {
    const bestScore = scoreRoute(best, prevSignature);
    const currScore = scoreRoute(curr, prevSignature);
    return currScore < bestScore ? curr : best;
  });
}

/**
 * Score a route (lower is better).
 */
function scoreRoute(route: RouteCandidate, prevSignature: string | null): number {
  let score = route.length;
  score += route.bends * 1000; // Bend penalty dominates

  if (prevSignature && route.signature !== prevSignature) {
    score += 100; // Stability penalty
  }

  return score;
}

/**
 * Remove collinear points from orthogonal path.
 */
function simplifyOrthogonal(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  const result: [number, number][] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Check if collinear (all on same horizontal or vertical line)
    const sameX = prev[0] === curr[0] && curr[0] === next[0];
    const sameY = prev[1] === curr[1] && curr[1] === next[1];

    if (!sameX && !sameY) {
      result.push(curr);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

/**
 * Compute route signature from simplified path.
 * Example: 'H', 'HV', 'VHV'
 */
function computeSignature(points: [number, number][]): string {
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

/**
 * Infer the entry direction for a free endpoint based on drag direction.
 * Uses hysteresis to prevent jitter when cursor moves near axis boundaries.
 *
 * @param from - Start position
 * @param cursor - Current cursor position
 * @param prevDir - Previous direction (for hysteresis)
 * @param hysteresisRatio - Ratio required to switch axis (default 1.2)
 * @returns Inferred direction
 */
export function inferDragDirection(
  from: [number, number],
  cursor: [number, number],
  prevDir: Dir | null,
  hysteresisRatio: number = 1.2
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
    const prevH = prevDir === 'E' || prevDir === 'W';
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
