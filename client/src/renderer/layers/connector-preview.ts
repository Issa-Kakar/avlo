/**
 * Connector Preview Rendering
 *
 * Handles all visual elements of the connector preview:
 * 1. Main connector polyline with rounded corners
 * 2. Arrow head at end (filled triangle)
 * 3. Shape anchor dots (4 midpoints, blue when active)
 * 4. Endpoint dots (blue if attached, white if free)
 *
 * CRITICAL: This is called INSIDE world transform scope.
 * The context has the world transform already applied when this is called.
 * Preview points are in world coordinates and will be transformed to canvas automatically.
 *
 * @module renderer/layers/connector-preview
 */

import type { ConnectorPreview } from '@/lib/tools/types';
import { SNAP_CONFIG, ROUTING_CONFIG, pxToWorld, computeArrowLength } from '@/lib/connectors/constants';

/**
 * Trim info for ending the polyline before the arrow head.
 */
interface EndTrimInfo {
  /** The point where the polyline should end (arrow base) */
  trimmedPoint: [number, number];
  /** Unit direction vector of the final segment */
  direction: [number, number];
}

/**
 * Compute where to trim the polyline for an arrow cap.
 *
 * This accounts for the arc corner geometry - we can only trim from the
 * "straight" portion of the final segment after the arc tangent point.
 *
 * For orthogonal connectors with 90° corners:
 * - The arc tangent point is at distance `cornerRadius` from the corner
 * - We can trim at most `segmentLength - cornerRadius` from the final segment
 * - This ensures the polyline ends smoothly after the arc
 *
 * @param points - Full route points
 * @param strokeWidth - Connector stroke width (for arrow sizing)
 * @param position - Which end to trim ('start' or 'end')
 * @returns Trim info or null if not enough points
 */
function computeEndTrim(
  points: [number, number][],
  strokeWidth: number,
  position: 'start' | 'end'
): EndTrimInfo | null {
  if (points.length < 2) return null;

  const arrowLength = computeArrowLength(strokeWidth);
  const cornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;

  let tip: [number, number];
  let prev: [number, number];
  let cornerPrev: [number, number] | null = null; // The point before the corner

  if (position === 'end') {
    tip = points[points.length - 1];
    prev = points[points.length - 2];
    if (points.length >= 3) {
      cornerPrev = points[points.length - 3];
    }
  } else {
    tip = points[0];
    prev = points[1];
    if (points.length >= 3) {
      cornerPrev = points[2];
    }
  }

  // Final segment direction and length
  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const segLen = Math.hypot(dx, dy);

  if (segLen < 0.001) return null;

  const ux = dx / segLen;
  const uy = dy / segLen;

  // Calculate the arc radius that would be used at the corner (prev)
  // This matches the logic in drawRoundedPolyline
  let actualCornerRadius = 0;
  if (cornerPrev) {
    const lenIn = Math.hypot(prev[0] - cornerPrev[0], prev[1] - cornerPrev[1]);
    const lenOut = segLen;
    actualCornerRadius = Math.min(cornerRadius, lenIn / 2, lenOut / 2);
    if (actualCornerRadius < 2) actualCornerRadius = 0; // Sharp corner
  }

  // The arc consumes `actualCornerRadius` of the final segment
  // Available for trimming is the rest of the segment
  const availableForTrim = Math.max(0, segLen - actualCornerRadius);

  // Clamp the arrow trim to what's available
  const actualTrim = Math.min(arrowLength, availableForTrim);

  const trimmedPoint: [number, number] = [
    tip[0] - ux * actualTrim,
    tip[1] - uy * actualTrim,
  ];

  return {
    trimmedPoint,
    direction: [ux, uy],
  };
}

/**
 * Draw connector preview on overlay canvas.
 *
 * @param ctx - Canvas 2D context with world transform applied
 * @param preview - ConnectorPreview data from tool
 * @param scale - Current zoom scale (for pxToWorld conversions)
 */
export function drawConnectorPreview(
  ctx: CanvasRenderingContext2D,
  preview: ConnectorPreview,
  scale: number
): void {
  if (preview.points.length < 2) return;

  const {
    points,
    color,
    width,
    opacity,
    endCap,
    startCap,
    snapShapeFrame,
    activeMidpointSide,
    fromIsAttached,
    toIsAttached,
    showCursorDot,
  } = preview;

  ctx.save();
  ctx.globalAlpha = opacity;

  // 1. Compute trim info for arrow caps (polyline stops at arrow base)
  const endTrim = endCap === 'arrow' ? computeEndTrim(points, width, 'end') : null;

  // 2. Draw main polyline with rounded corners (trimmed for arrow if needed)
  drawRoundedPolyline(ctx, points, color, width, endTrim ?? undefined);

  // 3. Draw arrow heads at endpoints (at original positions - arrow fills the gap)
  if (endCap === 'arrow' && points.length >= 2) {
    drawArrowHead(ctx, points, color, width, 'end');
  }
  if (startCap === 'arrow' && points.length >= 2) {
    drawArrowHead(ctx, points, color, width, 'start');
  }

  ctx.restore();

  // 4. Draw shape anchor dots (ONLY when snapped - dots = will connect here)
  if (snapShapeFrame) {
    drawShapeAnchorDots(ctx, snapShapeFrame, activeMidpointSide, scale);
  }

  // 5. Draw endpoint dots
  if (preview.fromPosition) {
    drawEndpointDot(ctx, preview.fromPosition, fromIsAttached, scale);
  }
  if (preview.toPosition && showCursorDot) {
    drawEndpointDot(ctx, preview.toPosition, toIsAttached, scale);
  }
}

/**
 * Draw the main connector polyline with rounded corners.
 * Uses arcTo for smooth corner transitions.
 *
 * @param ctx - Canvas context
 * @param points - Route points
 * @param color - Stroke color
 * @param width - Stroke width
 * @param endTrim - Optional trim info to stop polyline before arrow head
 */
function drawRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  width: number,
  endTrim?: EndTrimInfo
): void {
  const cornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;

  ctx.strokeStyle = color;
  ctx.lineWidth = width * 0.95;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Compute available segment lengths
    const lenIn = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const lenOut = Math.hypot(next[0] - curr[0], next[1] - curr[1]);

    // Clamp radius to fit available space
    const maxR = Math.min(cornerRadius, lenIn / 2, lenOut / 2);

    if (maxR < 2) {
      // Too small for rounding - use sharp corner
      ctx.lineTo(curr[0], curr[1]);
    } else {
      // Use arcTo for smooth corner
      ctx.arcTo(curr[0], curr[1], next[0], next[1], maxR);
    }
  }

  // Final segment - use trimmed point if provided (for arrow caps)
  if (endTrim) {
    ctx.lineTo(endTrim.trimmedPoint[0], endTrim.trimmedPoint[1]);
  } else {
    const last = points[points.length - 1];
    ctx.lineTo(last[0], last[1]);
  }

  ctx.stroke();
}

/**
 * Draw a filled triangle arrow head at the connector endpoint.
 * Arrow size scales with stroke width for visual balance.
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  strokeWidth: number,
  position: 'start' | 'end'
): void {
  // Arrow dimensions based on stroke width (world space)
  const arrowLength = Math.max(
    ROUTING_CONFIG.ARROW_MIN_LENGTH_W,
    strokeWidth * ROUTING_CONFIG.ARROW_LENGTH_FACTOR
  );
  const arrowWidth =
    Math.max(ROUTING_CONFIG.ARROW_MIN_WIDTH_W, strokeWidth * ROUTING_CONFIG.ARROW_WIDTH_FACTOR) / 2;

  let tip: [number, number];
  let prev: [number, number];

  if (position === 'end') {
    tip = points[points.length - 1];
    prev = points[points.length - 2];
  } else {
    tip = points[0];
    prev = points[1];
  }

  // Direction vector (normalized)
  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy; // Perpendicular
  const py = ux;

  // Arrow base point
  const baseX = tip[0] - ux * arrowLength;
  const baseY = tip[1] - uy * arrowLength;

  // Arrow wing points
  const left: [number, number] = [baseX + px * arrowWidth, baseY + py * arrowWidth];
  const right: [number, number] = [baseX - px * arrowWidth, baseY - py * arrowWidth];

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(left[0], left[1]);
  ctx.lineTo(right[0], right[1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw anchor dots at shape midpoints.
 * Dots are blue when active (snapped), white otherwise.
 *
 * For all shape types, midpoints are at frame edge centers:
 * - rect: edge midpoints
 * - ellipse: 0/90/180/270 on ellipse = edge midpoints
 * - diamond: vertices are at edge midpoints
 */
function drawShapeAnchorDots(
  ctx: CanvasRenderingContext2D,
  frame: [number, number, number, number],
  activeSide: 'N' | 'E' | 'S' | 'W' | null,
  scale: number
): void {
  const [x, y, w, h] = frame;
  const dotRadius = pxToWorld(SNAP_CONFIG.DOT_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(1.5, scale);

  // Midpoints at frame edge centers
  const midpoints: Record<'N' | 'E' | 'S' | 'W', [number, number]> = {
    N: [x + w / 2, y],
    E: [x + w, y + h / 2],
    S: [x + w / 2, y + h],
    W: [x, y + h / 2],
  };

  ctx.lineWidth = strokeWidth;

  for (const [side, pos] of Object.entries(midpoints) as [
    'N' | 'E' | 'S' | 'W',
    [number, number],
  ][]) {
    const isActive = side === activeSide;

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], dotRadius, 0, Math.PI * 2);

    // Blue fill when active (snapped to this midpoint), white otherwise
    ctx.fillStyle = isActive ? 'rgba(59, 130, 246, 1)' : 'white';
    ctx.fill();

    // Always blue stroke
    ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
    ctx.stroke();
  }
}

/**
 * Draw endpoint dot (start or end of connector).
 * Blue when attached to shape, white when free.
 */
function drawEndpointDot(
  ctx: CanvasRenderingContext2D,
  position: [number, number],
  isAttached: boolean,
  scale: number
): void {
  const dotRadius = pxToWorld(SNAP_CONFIG.ENDPOINT_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(1.5, scale);

  ctx.beginPath();
  ctx.arc(position[0], position[1], dotRadius, 0, Math.PI * 2);

  // Blue fill when attached, white when free
  ctx.fillStyle = isAttached ? 'rgba(59, 130, 246, 1)' : 'white';
  ctx.fill();

  // Always blue stroke
  ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}
