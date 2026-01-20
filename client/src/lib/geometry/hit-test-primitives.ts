/**
 * Hit Test Primitives
 *
 * Pure geometry functions for hit testing, shared by:
 * - SelectTool.ts (selection and marquee)
 * - EraserTool.ts (eraser hit detection)
 */

import type { WorldBounds, FrameTuple } from '@avlo/shared';

// Alias for backwards compatibility
export type WorldRect = WorldBounds;

/**
 * Get diamond vertices from frame tuple.
 * Diamond has vertices at edge midpoints: top, right, bottom, left.
 */
export function getDiamondVertices(frame: FrameTuple): {
  top: [number, number];
  right: [number, number];
  bottom: [number, number];
  left: [number, number];
} {
  const [x, y, w, h] = frame;
  return {
    top: [x + w / 2, y],
    right: [x + w, y + h / 2],
    bottom: [x + w / 2, y + h],
    left: [x, y + h / 2],
  };
}

/**
 * Calculate distance from a point to a line segment.
 */
export function pointToSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.hypot(px - projX, py - projY);
}

/**
 * Check if point is inside a rectangle (x, y, w, h format).
 */
export function pointInRect(
  px: number, py: number,
  x: number, y: number, w: number, h: number
): boolean {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

/**
 * Check if point is inside a WorldRect.
 */
export function pointInWorldRect(px: number, py: number, rect: WorldRect): boolean {
  return px >= rect.minX && px <= rect.maxX && py >= rect.minY && py <= rect.maxY;
}

/**
 * Check if point is inside a diamond (convex polygon test using cross product).
 */
export function pointInDiamond(
  px: number, py: number,
  top: [number, number],
  right: [number, number],
  bottom: [number, number],
  left: [number, number]
): boolean {
  // Use cross product sign consistency for convex polygon
  const vertices = [top, right, bottom, left];
  let sign: number | null = null;

  for (let i = 0; i < 4; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % 4];

    // Cross product of edge vector and point-to-vertex vector
    const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);

    if (sign === null) {
      sign = cross >= 0 ? 1 : -1;
    } else if ((cross >= 0 ? 1 : -1) !== sign) {
      return false; // Point is outside
    }
  }

  return true;
}

/**
 * Test if a point is within radius of a stroke (polyline).
 */
export function strokeHitTest(
  px: number,
  py: number,
  points: [number, number][],
  radius: number
): boolean {
  // Handle single-point stroke
  if (points.length === 1) {
    const [x, y] = points[0];
    const dx = px - x;
    const dy = py - y;
    return dx * dx + dy * dy <= radius * radius;
  }

  // Test each segment
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];

    if (pointToSegmentDistance(px, py, x1, y1, x2, y2) <= radius) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a circle intersects a rectangle (used by EraserTool).
 */
export function circleRectIntersect(
  cx: number, cy: number, r: number,
  x: number, y: number, w: number, h: number
): boolean {
  const closestX = Math.max(x, Math.min(cx, x + w));
  const closestY = Math.max(y, Math.min(cy, y + h));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) <= (r * r);
}

/**
 * Check if two WorldRects intersect.
 */
export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
         a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Check if two line segments intersect using CCW orientation test.
 */
export function segmentsIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): boolean {
  // CCW orientation test
  const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
  };

  return (
    ccw(x1, y1, x3, y3, x4, y4) !== ccw(x2, y2, x3, y3, x4, y4) &&
    ccw(x1, y1, x2, y2, x3, y3) !== ccw(x1, y1, x2, y2, x4, y4)
  );
}

/**
 * Check if a line segment intersects a WorldRect.
 */
export function segmentIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  rect: WorldRect
): boolean {
  // Check if either endpoint is inside rect
  if (pointInWorldRect(x1, y1, rect) || pointInWorldRect(x2, y2, rect)) {
    return true;
  }

  // Check if segment crosses any rect edge
  const edges: [[number, number], [number, number]][] = [
    [[rect.minX, rect.minY], [rect.maxX, rect.minY]], // Top
    [[rect.maxX, rect.minY], [rect.maxX, rect.maxY]], // Right
    [[rect.maxX, rect.maxY], [rect.minX, rect.maxY]], // Bottom
    [[rect.minX, rect.maxY], [rect.minX, rect.minY]], // Left
  ];

  for (const [[ex1, ey1], [ex2, ey2]] of edges) {
    if (segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a polyline intersects a WorldRect.
 */
export function polylineIntersectsRect(points: [number, number][], rect: WorldRect): boolean {
  // Check if any point is inside rect
  for (const [px, py] of points) {
    if (pointInWorldRect(px, py, rect)) return true;
  }

  // Check if any segment intersects rect
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentIntersectsRect(
      points[i][0], points[i][1],
      points[i + 1][0], points[i + 1][1],
      rect
    )) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an ellipse intersects a WorldRect.
 */
export function ellipseIntersectsRect(
  ecx: number, ecy: number, rx: number, ry: number,
  rect: WorldRect
): boolean {
  // Quick bounds check first
  const ellipseBounds: WorldRect = {
    minX: ecx - rx, minY: ecy - ry,
    maxX: ecx + rx, maxY: ecy + ry
  };
  if (!rectsIntersect(ellipseBounds, rect)) return false;

  // Check if ellipse center is inside rect
  if (pointInWorldRect(ecx, ecy, rect)) return true;

  // Check if any rect corner is inside ellipse
  const corners: [number, number][] = [
    [rect.minX, rect.minY], [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY], [rect.minX, rect.maxY]
  ];
  for (const [cx, cy] of corners) {
    const dx = (cx - ecx) / rx;
    const dy = (cy - ecy) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }

  // Check if ellipse edge intersects rect edges (sample ellipse perimeter)
  const SAMPLES = 16;
  for (let i = 0; i < SAMPLES; i++) {
    const angle = (i / SAMPLES) * Math.PI * 2;
    const px = ecx + rx * Math.cos(angle);
    const py = ecy + ry * Math.sin(angle);
    if (pointInWorldRect(px, py, rect)) return true;
  }

  return false;
}

/**
 * Check if a diamond intersects a WorldRect.
 */
export function diamondIntersectsRect(
  top: [number, number], right: [number, number],
  bottom: [number, number], left: [number, number],
  rect: WorldRect
): boolean {
  // Check if any diamond vertex is inside rect
  for (const [vx, vy] of [top, right, bottom, left]) {
    if (pointInWorldRect(vx, vy, rect)) return true;
  }

  // Check if any rect corner is inside diamond
  const corners: [number, number][] = [
    [rect.minX, rect.minY], [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY], [rect.minX, rect.maxY]
  ];
  for (const [cx, cy] of corners) {
    if (pointInDiamond(cx, cy, top, right, bottom, left)) return true;
  }

  // Check if any diamond edge intersects rect
  const diamondEdges: [[number, number], [number, number]][] = [
    [top, right], [right, bottom], [bottom, left], [left, top]
  ];
  for (const [[x1, y1], [x2, y2]] of diamondEdges) {
    if (segmentIntersectsRect(x1, y1, x2, y2, rect)) return true;
  }

  return false;
}

/**
 * Compute approximate area of a polyline using bounding box.
 * Used for selection priority (smaller area = higher priority).
 */
export function computePolylineArea(points: [number, number][]): number {
  if (points.length === 0) return 0;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return (maxX - minX) * (maxY - minY);
}
