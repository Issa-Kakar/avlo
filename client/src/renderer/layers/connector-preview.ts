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
  ROUTING_CONFIG,
  ANCHOR_DOT_CONFIG,
  pxToWorld,
  computeArrowLength,
} from '@/lib/connectors/constants';
import { getShapeTypeMidpoints } from '@/lib/connectors/connector-utils';

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
 * CRITICAL: Arrow length never exceeds half the segment (Excalidraw approach).
 * This prevents arrows from dominating short segments.
 *
 * Width is proportional to length via fixed aspect ratio, ensuring
 * consistent arrow shape at all sizes.
 *
 * @param segmentLength - Length of the final segment (tip to corner)
 * @param strokeWidth - Connector stroke width
 * @returns Scaled arrow dimensions
 */
function computeScaledArrowDimensions(
  segmentLength: number,
  strokeWidth: number
): ScaledArrowDimensions {
  const fullLength = computeArrowLength(strokeWidth);

  // Arrow never exceeds half the segment (Excalidraw approach)
  const scaledLength = Math.min(fullLength, segmentLength / 2);

  // Width proportional to length via fixed aspect ratio
  const scaledHalfWidth = (scaledLength * ROUTING_CONFIG.ARROW_ASPECT_RATIO) / 2;

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

  // Round cap extends strokeWidth/2 beyond the trim point, so we need
  // extra trim to prevent the polyline from poking through small arrows
  const neededTrim = scaledLength + strokeWidth / 2;
  const actualTrim = Math.min(neededTrim, availableForTrim);

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
  const {
    points,
    color,
    width,
    opacity,
    endCap,
    startCap,
    snapShapeFrame,
    snapShapeType,
    snapSide,
    snapPosition,
    activeMidpointSide,
    fromIsAttached,
    toIsAttached,
  } = preview;

  const hasRoute = points.length >= 2;

  // 1. Draw route (polyline + arrows) only if we have at least 2 points
  if (hasRoute) {
    ctx.save();
    ctx.globalAlpha = opacity;

    // Compute trim info for arrow caps (polyline stops at arrow base)
    const endTrim = endCap === 'arrow' ? computeEndTrim(points, width, 'end') : null;

    // Draw main polyline with rounded corners (trimmed for arrow if needed)
    drawRoundedPolyline(ctx, points, color, width, endTrim ?? undefined);

    // Draw arrow heads at endpoints (at original positions - arrow fills the gap)
    if (endCap === 'arrow') {
      drawArrowHead(ctx, points, color, width, 'end');
    }
    if (startCap === 'arrow') {
      drawArrowHead(ctx, points, color, width, 'start');
    }

    ctx.restore();
  }

  // 2. Draw snap indicator dots
  // Show dots during:
  // - Idle hover (!fromIsAttached): show dots for hovered shape
  // - Creating with end snapped (toIsAttached): show dots for end shape
  // Don't show dots after pointer down until end is snapped (prevents showing dots on start shape)
  const shouldShowDots =
    (!fromIsAttached || toIsAttached) &&
    snapShapeFrame !== null &&
    snapSide !== null &&
    snapPosition !== null &&
    snapShapeType !== null;

  if (shouldShowDots) {
    drawSnapDots(
      ctx,
      snapShapeFrame,
      snapShapeType,
      snapSide,
      activeMidpointSide !== null, // isMidpoint
      scale,
      snapPosition
    );
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
 * Fixed rounding lineWidth of 3 gives ~1.5 unit corner radius at all sizes.
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

  // Fixed rounding for consistent ~2.5 unit corner radius at all sizes
  const roundingLineWidth = 5;

  // CRITICAL: Stroke extends outward by lineWidth/2, including at the tip.
  // Pull the path back so the VISIBLE tip (after stroke) lands at the endpoint.
  const strokeOffset = roundingLineWidth / 2;

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
 * Cardinal direction type for edge positions.
 */
type Dir = 'N' | 'E' | 'S' | 'W';

/**
 * Draw snap indicator dots on shape edges.
 *
 * Renders 4 midpoint dots plus an active sliding dot at the current snap position.
 * Visual behavior:
 * - Edge sliding: Small midpoint dots, larger active dot sliding along edge
 * - Midpoint snap: All dots grow to large size, active midpoint is blue
 *
 * Active dot has a subtle glow effect for polish.
 *
 * @param shapeType - Shape type for correct midpoint calculation (rect, ellipse, diamond)
 * @param snapPosition - Pre-offset snap position from snap system (edgePosition).
 */
function drawSnapDots(
  ctx: CanvasRenderingContext2D,
  frame: [number, number, number, number],
  shapeType: string,
  side: Dir,
  isMidpoint: boolean,
  scale: number,
  snapPosition: [number, number]
): void {
  const [x, y, w, h] = frame;

  // Sizing based on snap state
  const smallRadius = pxToWorld(ANCHOR_DOT_CONFIG.SMALL_RADIUS_PX, scale);
  const largeRadius = pxToWorld(ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(ANCHOR_DOT_CONFIG.STROKE_WIDTH_PX, scale);

  // When at midpoint, all dots are large; otherwise midpoints are small
  const midpointRadius = isMidpoint ? largeRadius : smallRadius;
  const activeRadius = largeRadius;

  // Compute all 4 midpoint positions (shape-type aware)
  const midpoints = getShapeTypeMidpoints({ x, y, w, h }, shapeType);

  // Active position comes from snap system (already correct for shape type)
  const activePos = snapPosition;

  // Check if active dot is at the midpoint for a given side
  // Trust the isMidpoint boolean from snap system (midpoints are sticky anyway)
  const isActiveAtMidpoint = (s: Dir): boolean => isMidpoint && s === side;

  ctx.lineWidth = strokeWidth;

  // Draw inactive midpoint dots first (so active dot renders on top)
  for (const [s, pos] of Object.entries(midpoints) as [Dir, [number, number]][]) {
    // Skip this midpoint if the active dot is here
    if (isActiveAtMidpoint(s)) continue;

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], midpointRadius, 0, Math.PI * 2);
    ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
    ctx.fill();
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
    ctx.stroke();
  }

  // Draw active dot with glow effect
  ctx.save();

  // Glow effect via shadow blur
  ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
  ctx.shadowBlur = pxToWorld(ANCHOR_DOT_CONFIG.GLOW_BLUR_PX, scale);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.beginPath();
  ctx.arc(activePos[0], activePos[1], activeRadius, 0, Math.PI * 2);
  ctx.fillStyle = ANCHOR_DOT_CONFIG.ACTIVE_FILL;
  ctx.fill();

  // Remove shadow for stroke (prevents double glow)
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // White stroke for contrast
  ctx.strokeStyle = ANCHOR_DOT_CONFIG.ACTIVE_STROKE;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();

  ctx.restore();
}

// Note: drawEndpointDot was removed. It was used to render dots at connector
// endpoints (offset from shapes), which is only needed when selecting/editing
// existing connectors, not during the creation preview.
