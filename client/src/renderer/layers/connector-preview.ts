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
 * Path building logic is shared with object-cache via connector-paths.ts
 * for WYSIWYG consistency between preview and committed rendering.
 *
 * @module renderer/layers/connector-preview
 */

import type { ConnectorPreview } from '@/lib/tools/types';
import { ANCHOR_DOT_CONFIG, pxToWorld } from '@/lib/connectors/constants';
import { getShapeTypeMidpoints } from '@/lib/connectors/connector-utils';
import {
  buildRoundedPolylinePath,
  buildArrowPath,
  computeEndTrimInfo,
  ARROW_ROUNDING_LINE_WIDTH,
} from '@/lib/connectors/connector-paths';
import { getHandle } from '@/canvas/room-runtime';
import { getObjectCacheInstance } from '../object-cache';
import { getWidth } from '@/lib/object-accessors';

/**
 * Draw connector preview on overlay canvas.
 *
 * Uses shared path building functions from connector-paths.ts for WYSIWYG
 * consistency between preview and committed rendering.
 *
 * @param ctx - Canvas 2D context with world transform applied
 * @param preview - ConnectorPreview data from tool
 * @param scale - Current zoom scale (for pxToWorld conversions)
 */
export function drawConnectorPreview(
  ctx: CanvasRenderingContext2D,
  preview: ConnectorPreview,
  scale: number,
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
    const endTrim = endCap === 'arrow' ? computeEndTrimInfo(points, width, 'end') : null;
    const startTrim = startCap === 'arrow' ? computeEndTrimInfo(points, width, 'start') : null;

    // Build and stroke polyline path (using shared function)
    const polylinePath = buildRoundedPolylinePath(points, startTrim, endTrim);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(polylinePath);

    // Draw arrow heads (build path, then fill + stroke for rounded corners)
    if (endCap === 'arrow') {
      const arrowPath = buildArrowPath(points, width, 'end');
      drawArrowWithRoundedCorners(ctx, arrowPath, color);
    }
    if (startCap === 'arrow') {
      const arrowPath = buildArrowPath(points, width, 'start');
      drawArrowWithRoundedCorners(ctx, arrowPath, color);
    }

    ctx.restore();
  }

  // 1b. Draw dashed guide lines (straight connectors with interior anchors)
  if (preview.connectorType === 'straight' && hasRoute) {
    if (preview.startDashTo && points.length >= 2) {
      drawDashedGuide(ctx, points[0], preview.startDashTo, color, width, scale, opacity);
    }
    if (preview.endDashTo && points.length >= 2) {
      drawDashedGuide(
        ctx,
        points[points.length - 1],
        preview.endDashTo,
        color,
        width,
        scale,
        opacity,
      );
    }
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
    // Draw snap target highlight — cached geometry for shapes, strokeRect for others
    const snapHandle = getHandle(preview.snapShapeId ?? '');
    ctx.save();
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
    ctx.lineWidth = 2 / scale;
    ctx.lineJoin = 'round';
    if (snapHandle?.kind === 'shape') {
      const cache = getObjectCacheInstance();
      const path = cache.getPath(snapHandle.id, snapHandle);
      const sw = getWidth(snapHandle.y, 2);
      const cx = snapShapeFrame[0] + snapShapeFrame[2] / 2;
      const cy = snapShapeFrame[1] + snapShapeFrame[3] / 2;
      const sx = snapShapeFrame[2] > 0 ? (snapShapeFrame[2] + sw) / snapShapeFrame[2] : 1;
      const sy = snapShapeFrame[3] > 0 ? (snapShapeFrame[3] + sw) / snapShapeFrame[3] : 1;
      ctx.translate(cx, cy);
      ctx.scale(sx, sy);
      ctx.translate(-cx, -cy);
      ctx.stroke(path);
    } else {
      ctx.strokeRect(snapShapeFrame[0], snapShapeFrame[1], snapShapeFrame[2], snapShapeFrame[3]);
    }
    ctx.restore();

    drawSnapDots(
      ctx,
      snapShapeFrame,
      snapShapeType,
      snapSide,
      activeMidpointSide !== null, // isMidpoint
      scale,
      snapPosition,
      preview.connectorType === 'straight',
      preview.isCenterSnap,
    );
  }

  // Draw start endpoint dot when attached (during creation)
  if (fromIsAttached && preview.fromPosition && hasRoute) {
    const dotRadius = pxToWorld(ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX, scale);
    const sw = pxToWorld(ANCHOR_DOT_CONFIG.STROKE_WIDTH_PX, scale);
    ctx.lineWidth = sw;
    ctx.beginPath();
    ctx.arc(preview.fromPosition[0], preview.fromPosition[1], dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
    ctx.fill();
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
    ctx.stroke();
  }
}

/**
 * Render an arrow path with fill + stroke for rounded corners.
 * Fixed roundingLineWidth of 5 gives ~2.5 unit corner radius at all sizes.
 */
function drawArrowWithRoundedCorners(
  ctx: CanvasRenderingContext2D,
  arrowPath: Path2D,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.fill(arrowPath); // Solid interior
  ctx.stroke(arrowPath); // Adds rounded corners (radius = lineWidth/2)
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
  snapPosition: [number, number],
  isStraight: boolean = false,
  isCenterSnap: boolean = false,
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
  const midpoints = getShapeTypeMidpoints([x, y, w, h], shapeType);

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

  // Draw center dot for straight connectors
  if (isStraight) {
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    if (isCenterSnap) {
      // Active center dot with glow
      ctx.save();
      ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
      ctx.shadowBlur = pxToWorld(ANCHOR_DOT_CONFIG.GLOW_BLUR_PX, scale);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.arc(centerX, centerY, activeRadius, 0, Math.PI * 2);
      ctx.fillStyle = ANCHOR_DOT_CONFIG.ACTIVE_FILL;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = ANCHOR_DOT_CONFIG.ACTIVE_STROKE;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      ctx.restore();
    } else {
      // Inactive center dot
      ctx.beginPath();
      ctx.arc(centerX, centerY, smallRadius, 0, Math.PI * 2);
      ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
      ctx.fill();
      ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
      ctx.stroke();
    }
  }

  // Draw active dot with glow effect (skip if center snap — already drawn)
  if (isCenterSnap) return;
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

/**
 * Draw a dashed guide line between two points (for interior anchors on straight connectors).
 */
function drawDashedGuide(
  ctx: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
  color: string,
  width: number,
  scale: number,
  opacity: number,
): void {
  const dashLen = pxToWorld(6, scale);
  const gapLen = pxToWorld(4, scale);
  ctx.save();
  ctx.setLineDash([dashLen, gapLen]);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1 / scale, width * 0.6);
  ctx.globalAlpha = opacity * 0.5;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Note: drawEndpointDot was removed. It was used to render dots at connector
// endpoints (offset from shapes), which is only needed when selecting/editing
// existing connectors, not during the creation preview.
