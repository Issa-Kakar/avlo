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
import {
  SNAP_CONFIG,
  ROUTING_CONFIG,
  pxToWorld,
  computeArrowLength,
  computeArrowWidth,
} from '@/lib/connectors/constants';

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
 * Scaled arrow dimensions for short segments.
 */
interface ScaledArrowDimensions {
  /** Arrow length (tip to base) */
  scaledLength: number;
  /** Arrow half-width (center to vertex) */
  scaledHalfWidth: number;
}

/**
 * Compute scaled arrow dimensions based on segment length.
 *
 * CRITICAL: The arrow length must NEVER exceed the final segment length.
 * When the segment is shorter than the full arrow, the arrow becomes a
 * "fat blob" - length shrinks to fit, but width stays large.
 *
 * The "blob" effect is achieved by scaling width much more gently than
 * length. Using a power < 1 (like 0.15) means:
 * - At 50% length: width is ~90% of full
 * - At 25% length: width is ~80% of full
 * - At 10% length: width is ~70% of full
 *
 * This creates an increasingly fat arrow as the segment shrinks.
 *
 * @param segmentLength - Length of the final segment (tip to corner)
 * @param strokeWidth - Connector stroke width
 * @returns Scaled arrow dimensions
 */
function computeScaledArrowDimensions(
  segmentLength: number,
  strokeWidth: number
): ScaledArrowDimensions {
  const fullArrowLength = computeArrowLength(strokeWidth);
  const fullHalfWidth = computeArrowWidth(strokeWidth) / 2;

  // Arrow length can NEVER exceed segment length
  if (segmentLength >= fullArrowLength) {
    return { scaledLength: fullArrowLength, scaledHalfWidth: fullHalfWidth };
  }

  // Scale factor (0 to 1) based on how short the segment is
  const scale = segmentLength / fullArrowLength;

  // Length matches segment exactly
  const scaledLength = segmentLength;

  // Width scales VERY gently - stays large to create "fat blob" effect
  // Power of 0.15 keeps width high even when length is small
  // Also ensure width is at least 1.5x the stroke width for visibility
  const widthScale = Math.pow(scale, 1);
  const scaledHalfWidth = Math.max(fullHalfWidth * widthScale, strokeWidth * .5);

  return { scaledLength, scaledHalfWidth };
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

  // Get scaled arrow length based on segment length
  const { scaledLength } = computeScaledArrowDimensions(segLen, strokeWidth);

  // The arc consumes `actualCornerRadius` of the final segment
  // Available for trimming is the rest of the segment
  const availableForTrim = Math.max(0, segLen - actualCornerRadius);

  // Clamp trim to scaled arrow length (not full size)
  const actualTrim = Math.min(scaledLength, availableForTrim);

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

  //5. Draw endpoint dots
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
  ctx.lineWidth = width;
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
 * Draw a triangle arrow head with rounded corners.
 *
 * Uses Canvas's built-in lineJoin='round' for consistent rounding.
 * The rounding radius is lineWidth/2, which stays CONSTANT regardless
 * of triangle size. This means:
 * - Full-size arrow: subtle rounded corners
 * - Tiny blob arrow: very rounded (same radius on smaller shape)
 *
 * This is how whiteboard apps achieve the "lineCap=round" look on arrows.
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  strokeWidth: number,
  position: 'start' | 'end'
): void {
  // Get tip and prev point (the corner)
  let tip: [number, number];
  let prev: [number, number];

  if (position === 'end') {
    tip = points[points.length - 1];
    prev = points[points.length - 2];
  } else {
    tip = points[0];
    prev = points[1];
  }

  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const segLen = Math.hypot(dx, dy);
  if (segLen < 0.001) return;

  // Get scaled dimensions based on segment length
  // Arrow length NEVER exceeds segment length
  const { scaledLength, scaledHalfWidth } = computeScaledArrowDimensions(segLen, strokeWidth);

  const ux = dx / segLen;
  const uy = dy / segLen;
  const px = -uy;
  const py = ux;

  // Rounding via stroke - radius is lineWidth/2
  // Use a relatively constant value so rounding looks consistent at all sizes
  // Minimum of 3 ensures visible rounding even at small strokeWidths
  const roundingLineWidth = Math.max(3, strokeWidth * 0.8);

  // CRITICAL: Stroke extends outward by lineWidth/2, including at the tip.
  // Pull the path back so the VISIBLE tip (after stroke) lands at the endpoint.
  const strokeOffset = roundingLineWidth / 1.8;

  // 3 vertices of the triangle (pulled back by strokeOffset)
  const tipX = tip[0] - ux * strokeOffset;
  const tipY = tip[1] - uy * strokeOffset;
  const leftX = tipX - ux * scaledLength + px * scaledHalfWidth;
  const leftY = tipY - uy * scaledLength + py * scaledHalfWidth;
  const rightX = tipX - ux * scaledLength - px * scaledHalfWidth;
  const rightY = tipY - uy * scaledLength - py * scaledHalfWidth;

  // Draw filled triangle with rounded stroke overlay
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = roundingLineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(rightX, rightY);
  ctx.closePath();

  ctx.fill();   // Solid interior
  ctx.stroke(); // Adds rounded corners (radius = lineWidth/2)
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
