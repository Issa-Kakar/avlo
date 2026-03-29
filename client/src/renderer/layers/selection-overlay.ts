/**
 * Selection Overlay Rendering
 *
 * Handles all visual elements of the selection preview:
 * 1. Object highlights (blue outlines around selected objects)
 * 2. Marquee rectangle (dashed selection box during drag)
 * 3. Selection box with resize handles
 * 4. Connector endpoint dots (in connector mode)
 *
 * CRITICAL: This is called INSIDE world transform scope.
 * The context has the world transform already applied when this is called.
 * Preview coordinates are in world space and will be transformed to canvas automatically.
 *
 * @module renderer/layers/selection-overlay
 */

import type { SelectionPreview, HandleId } from '@/lib/tools/types';
import type { Snapshot } from '@avlo/shared';
import {
  getFrame,
  getShapeType,
  getWidth,
  getConnectorType,
  getStartAnchor,
  getEndAnchor,
  getPoints,
} from '@avlo/shared';
import { getTextFrame } from '@/lib/text/text-system';
import { getCodeFrame } from '@/lib/code/code-system';
import { getObjectCacheInstance } from '../object-cache';
import { useSelectionStore, type TransformState } from '@/stores/selection-store';
import { getEndpointEdgePosition, getShapeTypeMidpoints } from '@/lib/connectors/connector-utils';
import { ANCHOR_DOT_CONFIG, pxToWorld } from '@/lib/connectors/constants';
import type { SnapTarget } from '@/lib/connectors/types';
import { isAnchorInterior } from '@/lib/connectors/types';

// =============================================================================
// STYLING CONSTANTS
// =============================================================================

const SELECTION_STYLE = {
  // Colors - Blue-700 based palette for deeper, more refined selection
  /** Primary selection color (blue-700) */
  PRIMARY: 'rgba(29, 78, 216, 1)',
  /** Fill for marquee - darker for better visibility */
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)',
  /** Muted stroke for marquee */
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)',

  // Stroke widths (screen pixels)
  /** Object highlight stroke width */
  HIGHLIGHT_WIDTH: 2,
  /** Selection box stroke width */
  BOX_WIDTH: 2,
  /** Marquee stroke width */
  MARQUEE_WIDTH: 1.5,

  // Handle config - circular handles with shadow and subtle outline
  /** Handle radius in screen pixels (10px diameter) */
  HANDLE_RADIUS_PX: 6,
  /** Handle fill - subtle off-white (98% white, avoids blending with pure white backgrounds) */
  HANDLE_FILL: 'rgb(250, 250, 250)',
  /** Handle stroke - matches shadow tone for cohesion */
  HANDLE_STROKE: 'rgba(0, 0, 0, 0.25)',
  /** Handle stroke width - thicker for better edge definition */
  HANDLE_STROKE_WIDTH_PX: 2.5,

  // Handle shadow for depth effect
  /** Shadow color for floating handle effect */
  HANDLE_SHADOW_COLOR: 'rgba(0, 0, 0, 0.25)',
  /** Shadow blur radius */
  HANDLE_SHADOW_BLUR_PX: 4,
  /** Vertical shadow offset for subtle depth */
  HANDLE_SHADOW_OFFSET_Y_PX: 1,
} as const;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Draw selection overlay on overlay canvas.
 *
 * Renders four phases:
 * 1. Object highlights - blue outlines around selected objects (when not transforming)
 * 2. Marquee rectangle - dashed selection box during drag select
 * 3. Selection box + handles - bounding box with resize handles (when not transforming)
 * 4. Connector endpoint dots - in connector mode for single connector selection
 *
 * @param ctx - Canvas 2D context with world transform applied
 * @param preview - SelectionPreview data from SelectTool
 * @param scale - Current zoom scale (for consistent visual sizing)
 * @param snapshot - Current snapshot for object lookups
 */
export function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  preview: SelectionPreview,
  scale: number,
  snapshot: Snapshot,
): void {
  // Read store for connector mode state
  const { mode, transform } = useSelectionStore.getState();
  const isConnectorMode = mode === 'connector';

  // Phase 1: Object highlights (skip connector bbox in connector mode)
  if (!preview.isTransforming && preview.selectedIds.length > 0) {
    drawObjectHighlights(ctx, preview.selectedIds, snapshot, scale, isConnectorMode);
  }

  // Phase 2: Marquee rectangle
  if (preview.marqueeRect) {
    drawMarqueeRect(ctx, preview.marqueeRect, scale);
  }

  // Phase 3: Selection box + handles (only when not transforming, never in connector mode)
  if (preview.selectionBounds && !preview.isTransforming && !isConnectorMode) {
    drawSelectionBoxAndHandles(ctx, preview.selectionBounds, preview.handles, scale);
  }

  // Phase 4: Connector endpoint dots (connector mode only, single connector)
  if (isConnectorMode && preview.selectedIds.length === 1) {
    drawConnectorEndpointDots(ctx, preview.selectedIds[0], transform, snapshot, scale);
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Draw blue highlight outlines around selected objects.
 *
 * Different rendering per object kind:
 * - text: stroke the frame rect
 * - stroke/connector: stroke bbox rect (avoids PerfectFreehand artifact)
 * - shape: stroke the cached Path2D (follows actual geometry)
 *
 * @param suppressConnectors - When true, skip connector bbox highlights (connector mode)
 */
function drawObjectHighlights(
  ctx: CanvasRenderingContext2D,
  selectedIds: string[],
  snapshot: Snapshot,
  scale: number,
  suppressConnectors: boolean,
): void {
  const cache = getObjectCacheInstance();

  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;

    // Skip connector bbox highlight in connector mode
    if (suppressConnectors && handle.kind === 'connector') continue;

    // Text: stroke the frame rect
    if (handle.kind === 'text') {
      const frame = getTextFrame(id);
      if (frame) {
        ctx.strokeRect(frame[0], frame[1], frame[2], frame[3]);
      }
      continue;
    }

    // Code: stroke the derived frame rect
    if (handle.kind === 'code') {
      const frame = getCodeFrame(id);
      if (frame) {
        ctx.strokeRect(frame[0], frame[1], frame[2], frame[3]);
      }
      continue;
    }

    // Image: stroke the stored frame rect
    if (handle.kind === 'image') {
      const frame = getFrame(handle.y);
      if (frame) {
        ctx.strokeRect(frame[0], frame[1], frame[2], frame[3]);
      }
      continue;
    }

    // Note: stroke bbox (includes shadow — user likes the offset appearance)
    if (handle.kind === 'note') {
      const [minX, minY, maxX, maxY] = handle.bbox;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      continue;
    }

    // Strokes/Connectors: use bbox rectangle (avoids PF "ball" end cap artifact)
    if (handle.kind === 'stroke' || handle.kind === 'connector') {
      const [minX, minY, maxX, maxY] = handle.bbox;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      continue;
    }

    // Shapes: stroke cached Path2D scaled to visual outer edge
    // Scale the context around the shape center so the path expands outward
    // by half the stroke width — aligning the highlight with the painted edge.
    const path = cache.getPath(id, handle);
    const frame = getFrame(handle.y);
    if (frame) {
      const sw = getWidth(handle.y, 2);
      const [fx, fy, fw, fh] = frame;
      const cx = fx + fw / 2;
      const cy = fy + fh / 2;
      const sx = fw > 0 ? (fw + sw) / fw : 1;
      const sy = fh > 0 ? (fh + sw) / fh : 1;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(sx, sy);
      ctx.translate(-cx, -cy);
      ctx.stroke(path);
      ctx.restore();
    } else {
      ctx.stroke(path);
    }
  }
}

/**
 * Draw marquee selection rectangle.
 *
 * Darker blue fill with solid blue stroke.
 */
function drawMarqueeRect(
  ctx: CanvasRenderingContext2D,
  marqueeRect: { minX: number; minY: number; maxX: number; maxY: number },
  scale: number,
): void {
  const { minX, minY, maxX, maxY } = marqueeRect;

  // Darker fill - visible tint
  ctx.fillStyle = SELECTION_STYLE.PRIMARY_FILL;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);

  // Solid stroke (no dashes)
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY_MUTED;
  ctx.lineWidth = SELECTION_STYLE.MARQUEE_WIDTH / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
}

/**
 * Draw selection bounding box with resize handles.
 *
 * Selection box: solid blue stroke
 * Handles: off-white circles with subtle dark outline and drop shadow
 */
function drawSelectionBoxAndHandles(
  ctx: CanvasRenderingContext2D,
  selectionBounds: { minX: number; minY: number; maxX: number; maxY: number },
  handles: { id: HandleId; x: number; y: number }[] | null,
  scale: number,
): void {
  const { minX, minY, maxX, maxY } = selectionBounds;

  // Selection box stroke
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.BOX_WIDTH / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

  // Circular handles with drop shadow and subtle outline
  if (handles) {
    const radius = SELECTION_STYLE.HANDLE_RADIUS_PX / scale;

    // Setup shadow for floating handle effect (only applies to fill)
    ctx.shadowColor = SELECTION_STYLE.HANDLE_SHADOW_COLOR;
    ctx.shadowBlur = SELECTION_STYLE.HANDLE_SHADOW_BLUR_PX / scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = SELECTION_STYLE.HANDLE_SHADOW_OFFSET_Y_PX / scale;

    ctx.fillStyle = SELECTION_STYLE.HANDLE_FILL;

    // Draw all fills first (with shadow)
    for (const h of handles) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Clear shadow before drawing strokes (shadow on strokes looks bad)
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Draw subtle outline for edge definition
    ctx.strokeStyle = SELECTION_STYLE.HANDLE_STROKE;
    ctx.lineWidth = SELECTION_STYLE.HANDLE_STROKE_WIDTH_PX / scale;

    for (const h of handles) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// =============================================================================
// CONNECTOR ENDPOINT DOTS
// =============================================================================

/**
 * Draw connector endpoint dots when in connector mode.
 *
 * Shows start/end endpoint positions as circles. During endpoint drag,
 * the dragged endpoint shows snap state (active=blue with glow, inactive=white+blue).
 * Also renders midpoint dots on the snap target shape during drag.
 */
function drawConnectorEndpointDots(
  ctx: CanvasRenderingContext2D,
  connectorId: string,
  transform: TransformState,
  snapshot: Snapshot,
  scale: number,
): void {
  const handle = snapshot.objectsById.get(connectorId);
  if (!handle || handle.kind !== 'connector') return;

  const radius = pxToWorld(ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(ANCHOR_DOT_CONFIG.STROKE_WIDTH_PX, scale);

  let startPos: [number, number];
  let endPos: [number, number];
  let startActive = false;
  let endActive = false;

  if (transform.kind === 'endpointDrag' && transform.connectorId === connectorId) {
    const { endpoint, currentPosition, currentSnap } = transform;

    // Dragged endpoint: snap edge position (active) or cursor (inactive)
    const draggedPos = currentSnap ? currentSnap.edgePosition : currentPosition;
    const draggedActive = currentSnap !== null;

    // Non-dragged endpoint: canonical position, always inactive
    const otherEndpoint = endpoint === 'start' ? 'end' : 'start';
    const otherPos = getEndpointEdgePosition(handle, otherEndpoint, snapshot);

    if (endpoint === 'start') {
      startPos = draggedPos;
      startActive = draggedActive;
      endPos = otherPos;
    } else {
      endPos = draggedPos;
      endActive = draggedActive;
      startPos = otherPos;
    }

    // Draw snap midpoint dots on target shape
    if (currentSnap) {
      const isStraight = getConnectorType(handle.y) === 'straight';
      const isCenterSnap =
        isStraight &&
        isAnchorInterior(currentSnap.normalizedAnchor) &&
        currentSnap.normalizedAnchor[0] === 0.5 &&
        currentSnap.normalizedAnchor[1] === 0.5;
      drawSnapMidpointDots(ctx, currentSnap, snapshot, scale, isStraight, isCenterSnap);
    }
  } else {
    // Idle: both at canonical positions, both inactive
    startPos = getEndpointEdgePosition(handle, 'start', snapshot);
    endPos = getEndpointEdgePosition(handle, 'end', snapshot);
  }

  // Draw dots (inactive first so active renders on top)
  ctx.lineWidth = strokeWidth;

  // Inactive dots
  for (const [pos, active] of [
    [startPos, startActive],
    [endPos, endActive],
  ] as const) {
    if (active) continue;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
    ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
    ctx.fill();
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
    ctx.stroke();
  }

  // Active dots (with glow)
  for (const [pos, active] of [
    [startPos, startActive],
    [endPos, endActive],
  ] as const) {
    if (!active) continue;
    ctx.save();
    ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
    ctx.shadowBlur = pxToWorld(ANCHOR_DOT_CONFIG.GLOW_BLUR_PX, scale);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
    ctx.fillStyle = ANCHOR_DOT_CONFIG.ACTIVE_FILL;
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.ACTIVE_STROKE;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
    ctx.restore();
  }

  // Dashed guides for straight connectors with interior anchors
  if (getConnectorType(handle.y) === 'straight') {
    if (transform.kind === 'endpointDrag' && transform.connectorId === connectorId) {
      // During drag: use routedPoints for live dashed guides
      const { endpoint, currentSnap, routedPoints } = transform;
      if (routedPoints && routedPoints.length >= 2) {
        // Dragged endpoint: draw dashed guide if current snap is interior
        if (currentSnap && isAnchorInterior(currentSnap.normalizedAnchor)) {
          const draggedPos = currentSnap.edgePosition;
          const lineEnd =
            endpoint === 'start' ? routedPoints[0] : routedPoints[routedPoints.length - 1];
          drawDashedGuideLine(ctx, draggedPos, lineEnd, scale);
        }
        // Non-dragged endpoint: use stored anchor + routedPoints
        const otherEndpoint = endpoint === 'start' ? 'end' : 'start';
        const otherAnchor =
          otherEndpoint === 'start' ? getStartAnchor(handle.y) : getEndAnchor(handle.y);
        if (otherAnchor && isAnchorInterior(otherAnchor.anchor)) {
          const otherPos = getEndpointEdgePosition(handle, otherEndpoint, snapshot);
          const otherLineEnd =
            otherEndpoint === 'start' ? routedPoints[0] : routedPoints[routedPoints.length - 1];
          drawDashedGuideLine(ctx, otherPos, otherLineEnd, scale);
        }
      }
    } else {
      // Idle: use stored points
      drawStraightConnectorGuides(ctx, handle, startPos, endPos, snapshot, scale);
    }
  }
}

/**
 * Draw midpoint indicator dots on the snap target shape.
 *
 * Shows 4 midpoints (N/E/S/W) on the target shape. When snapped to a midpoint,
 * all dots grow to large radius. The active side dot renders with blue fill and glow.
 * For straight connectors, also draws center dot when applicable.
 */
function drawSnapMidpointDots(
  ctx: CanvasRenderingContext2D,
  snap: SnapTarget,
  snapshot: Snapshot,
  scale: number,
  isStraight: boolean = false,
  isCenterSnap: boolean = false,
): void {
  const shapeHandle = snapshot.objectsById.get(snap.shapeId);
  if (!shapeHandle) return;

  const shapeFrame =
    shapeHandle.kind === 'text' || shapeHandle.kind === 'note' ? getTextFrame(shapeHandle.id)
    : shapeHandle.kind === 'code' ? getCodeFrame(shapeHandle.id)
    : getFrame(shapeHandle.y);
  if (!shapeFrame) return;

  const shapeType = shapeHandle.kind === 'shape' ? getShapeType(shapeHandle.y) : 'rect';

  // Draw snap target highlight — cached geometry for shapes, strokeRect for others
  ctx.save();
  ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = 'round';
  if (shapeHandle.kind === 'shape') {
    const cache = getObjectCacheInstance();
    const path = cache.getPath(shapeHandle.id, shapeHandle);
    const sw = getWidth(shapeHandle.y, 2);
    const [fx, fy, fw, fh] = shapeFrame;
    const cx = fx + fw / 2;
    const cy = fy + fh / 2;
    const sx = fw > 0 ? (fw + sw) / fw : 1;
    const sy = fh > 0 ? (fh + sw) / fh : 1;
    ctx.translate(cx, cy);
    ctx.scale(sx, sy);
    ctx.translate(-cx, -cy);
    ctx.stroke(path);
  } else {
    ctx.strokeRect(shapeFrame[0], shapeFrame[1], shapeFrame[2], shapeFrame[3]);
  }
  ctx.restore();

  const smallRadius = pxToWorld(ANCHOR_DOT_CONFIG.SMALL_RADIUS_PX, scale);
  const largeRadius = pxToWorld(ANCHOR_DOT_CONFIG.LARGE_RADIUS_PX, scale);
  const strokeWidth = pxToWorld(ANCHOR_DOT_CONFIG.STROKE_WIDTH_PX, scale);

  // When at midpoint, all dots grow large; otherwise stay small
  const midpointRadius = snap.isMidpoint ? largeRadius : smallRadius;

  const midpoints = getShapeTypeMidpoints(shapeFrame, shapeType);

  ctx.lineWidth = strokeWidth;

  // Inactive midpoint dots (skip the active side if at midpoint)
  for (const [s, pos] of Object.entries(midpoints) as ['N' | 'E' | 'S' | 'W', [number, number]][]) {
    if (snap.isMidpoint && s === snap.side) continue;

    ctx.beginPath();
    ctx.arc(pos[0], pos[1], midpointRadius, 0, Math.PI * 2);
    ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
    ctx.fill();
    ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
    ctx.stroke();
  }

  // Center dot for straight connectors
  if (isStraight) {
    const centerX = shapeFrame[0] + shapeFrame[2] / 2;
    const centerY = shapeFrame[1] + shapeFrame[3] / 2;
    if (isCenterSnap) {
      ctx.save();
      ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
      ctx.shadowBlur = pxToWorld(ANCHOR_DOT_CONFIG.GLOW_BLUR_PX, scale);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.arc(centerX, centerY, largeRadius, 0, Math.PI * 2);
      ctx.fillStyle = ANCHOR_DOT_CONFIG.ACTIVE_FILL;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = ANCHOR_DOT_CONFIG.ACTIVE_STROKE;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
      ctx.restore();
      return; // Center snap is the active dot — skip normal active dot
    } else {
      ctx.beginPath();
      ctx.arc(centerX, centerY, smallRadius, 0, Math.PI * 2);
      ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
      ctx.fill();
      ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
      ctx.stroke();
    }
  }

  // Active dot at edge position with glow
  ctx.save();
  ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
  ctx.shadowBlur = pxToWorld(ANCHOR_DOT_CONFIG.GLOW_BLUR_PX, scale);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.beginPath();
  ctx.arc(snap.edgePosition[0], snap.edgePosition[1], largeRadius, 0, Math.PI * 2);
  ctx.fillStyle = ANCHOR_DOT_CONFIG.ACTIVE_FILL;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = ANCHOR_DOT_CONFIG.ACTIVE_STROKE;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
  ctx.restore();
}

// =============================================================================
// STRAIGHT CONNECTOR DASHED GUIDES
// =============================================================================

/**
 * Draw dashed guide lines for a selected straight connector with interior anchors.
 * Draws from the interior anchor dot position to the stored line endpoint on the shape edge.
 */
function drawStraightConnectorGuides(
  ctx: CanvasRenderingContext2D,
  handle: import('@avlo/shared').ObjectHandle,
  startPos: [number, number],
  endPos: [number, number],
  _snapshot: Snapshot,
  scale: number,
): void {
  const points = getPoints(handle.y);
  if (points.length < 2) return;

  const startAnchor = getStartAnchor(handle.y);
  const endAnchor = getEndAnchor(handle.y);

  // Dashed guide from interior dot position to line start (edge intersection)
  if (startAnchor && isAnchorInterior(startAnchor.anchor)) {
    drawDashedGuideLine(ctx, startPos, points[0], scale);
  }

  // Dashed guide from interior dot position to line end (edge intersection)
  if (endAnchor && isAnchorInterior(endAnchor.anchor)) {
    drawDashedGuideLine(ctx, endPos, points[points.length - 1], scale);
  }
}

/** Draw a dashed guide line between two points. */
function drawDashedGuideLine(
  ctx: CanvasRenderingContext2D,
  from: [number, number],
  to: [number, number],
  scale: number,
): void {
  const dashLen = pxToWorld(6, scale);
  const gapLen = pxToWorld(4, scale);
  ctx.save();
  ctx.setLineDash([dashLen, gapLen]);
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = 1.5 / scale;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
