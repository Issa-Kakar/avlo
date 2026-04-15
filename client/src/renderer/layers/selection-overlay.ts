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

import type { SelectionPreview, HandleId } from '@/tools/types';
import { getFrame, getWidth, getConnectorType, getStartAnchor, getEndAnchor, getPoints } from '@/core/accessors';
import { getTextFrame } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { getPath } from '../geometry-cache';
import { useSelectionStore, type TransformState } from '@/stores/selection-store';
import { getEndpointEdgePosition } from '@/core/connectors/connector-utils';
import type { SnapTarget } from '@/core/connectors/types';
import { isAnchorInterior } from '@/core/connectors/types';
import { getHandle } from '@/runtime/room-runtime';
import { useCameraStore } from '@/stores/camera-store';
import { drawConnectorDashGuide, drawAnchorDot, drawSnapFeedback } from './connector-render-atoms';

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
 */
export function drawSelectionOverlay(ctx: CanvasRenderingContext2D, preview: SelectionPreview): void {
  const scale = useCameraStore.getState().scale;
  // Read store for connector mode state
  const { mode, transform } = useSelectionStore.getState();
  const isConnectorMode = mode === 'connector';

  // Phase 1: Object highlights (skip connector bbox in connector mode)
  if (!preview.isTransforming && preview.selectedIds.length > 0) {
    drawObjectHighlights(ctx, preview.selectedIds, scale, isConnectorMode);
  }

  // Phase 2: Marquee rectangle
  if (preview.marqueeRect) {
    drawMarqueeRect(ctx, preview.marqueeRect);
  }

  // Phase 3: Selection box + handles (only when not transforming, never in connector mode)
  if (preview.selectionBounds && !preview.isTransforming && !isConnectorMode) {
    drawSelectionBoxAndHandles(ctx, preview.selectionBounds, preview.handles);
  }

  // Phase 4: Connector endpoint dots (connector mode only, single connector)
  if (isConnectorMode && preview.selectedIds.length === 1) {
    drawConnectorEndpointDots(ctx, preview.selectedIds[0], transform);
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
function drawObjectHighlights(ctx: CanvasRenderingContext2D, selectedIds: string[], scale: number, suppressConnectors: boolean): void {
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const id of selectedIds) {
    const handle = getHandle(id);
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

    // Bookmark: stroke the bbox (includes shadow padding)
    if (handle.kind === 'bookmark') {
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
    const path = getPath(id, handle);
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
function drawMarqueeRect(ctx: CanvasRenderingContext2D, marqueeRect: [number, number, number, number]): void {
  const scale = useCameraStore.getState().scale;
  const [minX, minY, maxX, maxY] = marqueeRect;

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
  selectionBounds: [number, number, number, number],
  handles: { id: HandleId; x: number; y: number }[] | null,
): void {
  const scale = useCameraStore.getState().scale;
  const [minX, minY, maxX, maxY] = selectionBounds;

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
 * Composes the shared atoms in `connector-render-atoms.ts`. Endpoint positions
 * come from `getEndpointEdgePosition` (which is anchor-frame-point backed, so
 * dots always sit on the shape frame — never offset outward). `drawSnapFeedback`
 * handles the full drag-side visual (highlight + midpoints + center dot + active
 * dot); this function only layers the inactive dot on the non-snapped side and
 * the dashed guides for interior anchors on straight connectors.
 */
function drawConnectorEndpointDots(ctx: CanvasRenderingContext2D, connectorId: string, transform: TransformState): void {
  const handle = getHandle(connectorId);
  if (!handle || handle.kind !== 'connector') return;

  const isStraight = getConnectorType(handle.y) === 'straight';
  const isDragging = transform.kind === 'endpointDrag' && transform.connectorId === connectorId;

  // === Endpoint positions ===
  let startPos: [number, number];
  let endPos: [number, number];
  let startActive = false;
  let endActive = false;
  let currentSnap: SnapTarget | null = null;
  let draggedEndpoint: 'start' | 'end' | null = null;
  let dragRoute: [number, number][] | null = null;

  if (isDragging) {
    const { endpoint, currentPosition, currentSnap: snap, routedPoints } = transform;
    draggedEndpoint = endpoint;
    currentSnap = snap;
    dragRoute = routedPoints ?? null;

    const draggedPos: [number, number] = snap ? snap.edgePosition : currentPosition;
    const draggedActive = snap !== null;
    const otherPos = getEndpointEdgePosition(handle, endpoint === 'start' ? 'end' : 'start');

    if (endpoint === 'start') {
      startPos = draggedPos;
      startActive = draggedActive;
      endPos = otherPos;
    } else {
      endPos = draggedPos;
      endActive = draggedActive;
      startPos = otherPos;
    }
  } else {
    startPos = getEndpointEdgePosition(handle, 'start');
    endPos = getEndpointEdgePosition(handle, 'end');
  }

  // Snap-target feedback: highlight + midpoints + center dot + active edge dot (all in one).
  drawSnapFeedback(ctx, currentSnap, isStraight);

  // Inactive dots on sides that aren't actively snapped (the snapped side was drawn above).
  if (!startActive) drawAnchorDot(ctx, startPos, false);
  if (!endActive) drawAnchorDot(ctx, endPos, false);

  // === Dashed guides for straight connectors with interior anchors ===
  if (!isStraight) return;

  if (isDragging && dragRoute && dragRoute.length >= 2) {
    if (currentSnap && isAnchorInterior(currentSnap.normalizedAnchor)) {
      const lineEnd = draggedEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRoute.length - 1];
      drawConnectorDashGuide(ctx, currentSnap.edgePosition, lineEnd);
    }
    const otherEndpoint: 'start' | 'end' = draggedEndpoint === 'start' ? 'end' : 'start';
    const otherAnchor = otherEndpoint === 'start' ? getStartAnchor(handle.y) : getEndAnchor(handle.y);
    if (otherAnchor && isAnchorInterior(otherAnchor.anchor)) {
      const otherPos = getEndpointEdgePosition(handle, otherEndpoint);
      const otherLineEnd = otherEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRoute.length - 1];
      drawConnectorDashGuide(ctx, otherPos, otherLineEnd);
    }
    return;
  }

  // Idle: dashed guide from stored anchor frame point to stored line endpoint
  const storedPoints = getPoints(handle.y);
  if (storedPoints.length < 2) return;
  const startAnchor = getStartAnchor(handle.y);
  const endAnchor = getEndAnchor(handle.y);
  if (startAnchor && isAnchorInterior(startAnchor.anchor)) {
    drawConnectorDashGuide(ctx, startPos, storedPoints[0]);
  }
  if (endAnchor && isAnchorInterior(endAnchor.anchor)) {
    drawConnectorDashGuide(ctx, endPos, storedPoints[storedPoints.length - 1]);
  }
}
