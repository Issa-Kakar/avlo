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
import { SNAP_CONFIG, ROUTING_CONFIG, pxToWorld } from '@/lib/connectors/constants';

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

  // 1. Draw main polyline with rounded corners
  drawRoundedPolyline(ctx, points, color, width);

  // 2. Draw arrow heads at endpoints
  if (endCap === 'arrow' && points.length >= 2) {
    drawArrowHead(ctx, points, color, width, 'end');
  }
  if (startCap === 'arrow' && points.length >= 2) {
    drawArrowHead(ctx, points, color, width, 'start');
  }

  ctx.restore();

  // 3. Draw shape anchor dots (ONLY when snapped - dots = will connect here)
  if (snapShapeFrame) {
    drawShapeAnchorDots(ctx, snapShapeFrame, activeMidpointSide, scale);
  }

  // 4. Draw endpoint dots
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
 */
function drawRoundedPolyline(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  color: string,
  width: number
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

  // Final segment to last point
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
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
