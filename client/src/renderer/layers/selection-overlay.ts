/**
 * Selection Overlay Rendering
 *
 * Single sentinel preview from `SelectTool.getPreview()` — overlay reads
 * everything else (selectedIds, mode, marquee, transform discriminant, scale
 * gesture, translate delta, topology, viewport) directly from the relevant
 * stores + transform getters. Per-object highlights are live during transforms,
 * viewport-culled, and shape-aware (rounded-rect path). Handles use a
 * pre-rendered bitmap stamp to keep `shadowBlur` off the hot path. Handles +
 * endpoint dots hide during translate; handles also hide when the selection
 * bbox is smaller than `HANDLE_MIN_BBOX_PX` on screen.
 *
 * CRITICAL: This is called INSIDE world transform scope.
 *
 * @module renderer/layers/selection-overlay
 */

import { getConnectorType, getEndpointAnchors, getFrame, getHandleShapeType, getPoints, getWidth } from '@/core/accessors';
import { getEndpointEdgePosition } from '@/core/connectors/anchor-atoms';
import type { SnapTarget } from '@/core/connectors/types';
import { frameToBbox, pointsToBBox, scaleBBoxAround, translateBBox } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { buildShapePathFromFrame } from '@/core/geometry/shape-path';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';
import { getHandle } from '@/runtime/room-runtime';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { computeHandles, computeSelectionBounds, type TransformState, useSelectionStore } from '@/stores/selection-store';
import { getController, getScaleEntry, getTransformScaleCtx, getTransformTopology } from '@/tools/selection/transform';
import { drawAnchorDot, drawConnectorDashGuide, drawSnapFeedback } from './connector-render-atoms';
import { drawResizeHandles } from './handle-stamp';

// =============================================================================
// STYLING CONSTANTS
// =============================================================================

const SELECTION_STYLE = {
  PRIMARY: 'rgba(29, 78, 216, 1)',
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)',
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)',
  HIGHLIGHT_WIDTH: 2,
  BOX_WIDTH: 2,
  MARQUEE_WIDTH: 1.5,
} as const;

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Draw selection overlay on overlay canvas.
 *
 * Discriminates by selection size and mode:
 *   single non-connector → one rect (the bounds *is* the highlight) + handles
 *   multi                → per-object highlights (viewport-culled) + selection rect + handles
 *   connector mode (1)   → polyline highlight + endpoint dots; no rect, no handles
 * Handles hide during translate and when the bbox would be too small on screen.
 */
export function drawSelectionOverlay(ctx: CanvasRenderingContext2D): void {
  const { selectedIds, mode, marquee, transform } = useSelectionStore.getState();
  const scale = useCameraStore.getState().scale;

  // 1. Marquee — independent of selection.
  if (marquee.active && marquee.anchor && marquee.current) {
    drawMarqueeRect(ctx, pointsToBBox(marquee.anchor, marquee.current), scale);
  }
  if (selectedIds.length === 0) return;

  const isTranslating = transform.kind === 'translate';

  // 2. Connector mode (single connector by invariant).
  if (mode === 'connector') {
    const cid = selectedIds[0];
    drawConnectorHighlight(ctx, cid, transform, scale);
    if (!isTranslating) drawConnectorEndpointDots(ctx, cid, transform);
    return;
  }

  // 3. Single non-connector selection — bounds rect doubles as highlight.
  if (selectedIds.length === 1) {
    const handle = getHandle(selectedIds[0]);
    if (!handle) return;
    const bbox = currentBoundsForHandle(handle, transform);
    if (!bbox) return;
    ctx.save();
    ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
    ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    drawObjectHighlight(ctx, handle, bbox, transform);
    ctx.restore();
    if (!isTranslating && shouldShowHandles(bbox, scale)) {
      drawResizeHandles(ctx, computeHandles(bbox), scale);
    }
    return;
  }

  // 4. Multi-selection.
  const visible = getVisibleBoundsTuple();
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!handle) continue;
    if (handle.kind === 'connector') {
      drawConnectorHighlight(ctx, id, transform, scale);
      continue;
    }
    const bbox = currentBoundsForHandle(handle, transform);
    if (!bbox || !bboxesIntersect(bbox, visible)) continue;
    drawObjectHighlight(ctx, handle, bbox, transform);
  }
  ctx.restore();

  // Selection-bounds rect + handles (sliding for scale, translated for translate, base for idle).
  const selRect = selectionRectForOverlay(transform);
  if (selRect) {
    drawSelectionBox(ctx, selRect, scale);
    if (!isTranslating && shouldShowHandles(selRect, scale)) {
      drawResizeHandles(ctx, computeHandles(selRect), scale);
    }
  }
}

// =============================================================================
// PER-OBJECT BOUNDS / HIGHLIGHT
// =============================================================================

/** Live bbox during transform; frame-aware fallback when idle. */
function currentBoundsForHandle(handle: ObjectHandle, t: TransformState): BBoxTuple | null {
  if (t.kind === 'scale' && handle.kind !== 'connector') {
    const e = getScaleEntry(handle.kind, handle.id);
    if (e) return (e.out as { bbox: BBoxTuple }).bbox;
  }
  if (t.kind === 'translate') {
    const c = getController();
    return translateBBox(handle.bbox, c.dx, c.dy);
  }
  switch (handle.kind) {
    case 'text':
    case 'code':
    case 'note':
    case 'bookmark': {
      const f = frameOf(handle);
      return f ? frameToBbox(f) : handle.bbox;
    }
    default:
      return handle.bbox;
  }
}

/** Live frame for shape highlight: entry.out.frame during scale, translated during translate, stored otherwise. */
function currentFrameForShape(handle: ObjectHandle, t: TransformState): FrameTuple | null {
  if (t.kind === 'scale') {
    const e = getScaleEntry('shape', handle.id);
    if (e) return e.out.frame;
  }
  const stored = getFrame(handle.y);
  if (!stored) return null;
  if (t.kind === 'translate') {
    const c = getController();
    return [stored[0] + c.dx, stored[1] + c.dy, stored[2], stored[3]];
  }
  return stored;
}

/**
 * Stroke one object's highlight. Caller owns ctx style. Shapes get a fresh
 * Path2D from the live frame outset by half stroke width — keeps rounded-rect
 * radii intact at any non-uniform scale (no ctx.scale distortion).
 */
function drawObjectHighlight(ctx: CanvasRenderingContext2D, handle: ObjectHandle, bbox: BBoxTuple, t: TransformState): void {
  if (handle.kind === 'shape') {
    const frame = currentFrameForShape(handle, t);
    if (!frame) return;
    const sw = getWidth(handle.y, 2);
    const expanded: FrameTuple = [frame[0] - sw / 2, frame[1] - sw / 2, frame[2] + sw, frame[3] + sw];
    ctx.stroke(buildShapePathFromFrame(getHandleShapeType(handle), expanded));
    return;
  }
  ctx.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
}

// =============================================================================
// SELECTION BOX (multi-select)
// =============================================================================

/** Sliding for scale, translated for translate, base bounds otherwise. */
function selectionRectForOverlay(t: TransformState): BBoxTuple | null {
  if (t.kind === 'scale') {
    const s = getTransformScaleCtx();
    return s ? scaleBBoxAround(s.selBounds, s.origin, s.sx, s.sy) : null;
  }
  const base = computeSelectionBounds();
  if (!base) return null;
  if (t.kind === 'translate') {
    const c = getController();
    return translateBBox(base, c.dx, c.dy);
  }
  return base;
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, bounds: BBoxTuple, scale: number): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.BOX_WIDTH / scale;
  ctx.strokeRect(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]);
  ctx.restore();
}

// =============================================================================
// MARQUEE
// =============================================================================

function drawMarqueeRect(ctx: CanvasRenderingContext2D, marqueeRect: BBoxTuple, scale: number): void {
  const [minX, minY, maxX, maxY] = marqueeRect;
  ctx.save();
  ctx.fillStyle = SELECTION_STYLE.PRIMARY_FILL;
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY_MUTED;
  ctx.lineWidth = SELECTION_STYLE.MARQUEE_WIDTH / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

// =============================================================================
// CONNECTOR HIGHLIGHT (live polyline) + ENDPOINT DOTS
// =============================================================================

function drawConnectorHighlight(ctx: CanvasRenderingContext2D, id: string, t: TransformState, scale: number): void {
  const handle = getHandle(id);
  if (!handle || handle.kind !== 'connector') return;
  const points = connectorPathPoints(handle, t);
  if (!points || points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH / scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
  ctx.restore();
}

function connectorPathPoints(handle: ObjectHandle, t: TransformState): Point[] | null {
  if (t.kind === 'scale' || t.kind === 'translate') {
    const top = getTransformTopology();
    const e = top?.byId.get(handle.id);
    if (e?.mode === 'reroute' && e.currPoints) return e.currPoints;
    if (e?.mode === 'translate') {
      const c = getController();
      return getPoints(handle.y).map((p) => [p[0] + c.dx, p[1] + c.dy]);
    }
  }
  if (t.kind === 'endpointDrag' && t.connectorId === handle.id && t.routedPoints) {
    return t.routedPoints;
  }
  return getPoints(handle.y) as Point[];
}

/**
 * Endpoint dots in connector mode. Composes shared atoms:
 * `drawSnapFeedback` paints highlight + midpoints + center + active dot;
 * we layer the inactive dot on the non-snapped side and dashed guides for
 * straight connectors with interior anchors.
 */
function drawConnectorEndpointDots(ctx: CanvasRenderingContext2D, connectorId: string, transform: TransformState): void {
  const handle = getHandle(connectorId);
  if (!handle || handle.kind !== 'connector') return;

  const isStraight = getConnectorType(handle.y) === 'straight';
  const isDragging = transform.kind === 'endpointDrag' && transform.connectorId === connectorId;

  let startPos: Point;
  let endPos: Point;
  let startActive = false;
  let endActive = false;
  let currentSnap: SnapTarget | null = null;
  let draggedEndpoint: 'start' | 'end' | null = null;
  let dragRoute: Point[] | null = null;

  if (isDragging) {
    const { endpoint, currentPosition, currentSnap: snap, routedPoints } = transform;
    draggedEndpoint = endpoint;
    currentSnap = snap;
    dragRoute = routedPoints ?? null;

    const draggedPos: Point = snap ? snap.position : currentPosition;
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

  drawSnapFeedback(ctx, currentSnap);

  if (!startActive) drawAnchorDot(ctx, startPos, false);
  if (!endActive) drawAnchorDot(ctx, endPos, false);

  if (!isStraight) return;

  if (isDragging && dragRoute && dragRoute.length >= 2) {
    if (currentSnap?.kind === 'straight' && currentSnap.interior) {
      const lineEnd = draggedEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRoute.length - 1];
      drawConnectorDashGuide(ctx, currentSnap.position, lineEnd);
    }
    const otherEndpoint: 'start' | 'end' = draggedEndpoint === 'start' ? 'end' : 'start';
    const { startAnchor: sa, endAnchor: ea } = getEndpointAnchors(handle.y);
    const otherAnchor = otherEndpoint === 'start' ? sa : ea;
    if (otherAnchor && 'interior' in otherAnchor && otherAnchor.interior) {
      const otherPos = getEndpointEdgePosition(handle, otherEndpoint);
      const otherLineEnd = otherEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRoute.length - 1];
      drawConnectorDashGuide(ctx, otherPos, otherLineEnd);
    }
    return;
  }

  const storedPoints = getPoints(handle.y);
  if (storedPoints.length < 2) return;
  const { startAnchor, endAnchor } = getEndpointAnchors(handle.y);
  if (startAnchor && 'interior' in startAnchor && startAnchor.interior) {
    drawConnectorDashGuide(ctx, startPos, storedPoints[0]);
  }
  if (endAnchor && 'interior' in endAnchor && endAnchor.interior) {
    drawConnectorDashGuide(ctx, endPos, storedPoints[storedPoints.length - 1]);
  }
}
