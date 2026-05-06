/**
 * Selection Overlay Rendering
 *
 * Reads state directly from stores + transform getters (no SelectTool plumbing).
 * Handles use a pre-rendered bitmap stamp to keep `shadowBlur` off the hot path.
 * Per-mode dispatch + per-call WHY live on the individual functions below.
 *
 * Two cross-cutting concerns:
 *   - `transformHasChange()` gates the begin→first-update gap (`entry.out.*` is
 *     zero-bbox until the first update writes real values). Connector topology
 *     skips the gate — its `currBbox` is initialized live at build.
 *   - `shouldShowHandles` is the single render/hit/cursor visibility gate so
 *     they can never disagree.
 *
 * CRITICAL: This is called INSIDE world transform scope.
 *
 * @module renderer/layers/selection-overlay
 */

import { getConnectorType } from '@/core/accessors';
import { getEndpointEdgePosition } from '@/core/connectors/anchor-atoms';
import type { SnapTarget } from '@/core/connectors/types';
import { frameToBbox, scaleBBoxAround, translateBBox } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { uniformFactor } from '@/core/geometry/scale-system';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { ConnectorEndpoint, ObjectHandle, StoredAnchor } from '@/core/types/objects';
import { getConnectorRoute, getHandle } from '@/runtime/room-runtime';
import { selectTool } from '@/runtime/tool-registry';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { computeHandles, computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import {
  getController,
  getScaleEntry,
  getTransformScaleCtx,
  getTransformTopology,
  getTranslateSelBounds,
  isOverlayUniform,
  type KindWithBBoxGeo,
  transformHasChange,
} from '@/tools/selection/transform';
import type { TransformState } from '@/tools/selection/types';
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
 *   single non-connector → one rect (the bounds *is* the highlight) + handles.
 *                          Whiteboard convention — the selection rect alone signals
 *                          "this is selected" when there's only one object.
 *   multi                → per-object highlights (viewport-culled) + union rect + handles.
 *                          Per-object highlights individuate within the group rect.
 *   connector mode (1)   → endpoint dots only. Connectors are never scaled in practice
 *                          (you drag endpoints to reshape them); the dots already signal
 *                          selection, so no bbox / no handles. A polyline highlight was
 *                          tried but the rendered elbow path's dynamic corner radius is
 *                          hard to match without extra work for no real benefit.
 * Handles hide during translate and when the bbox would be too small on screen.
 */
export function drawSelectionOverlay(ctx: CanvasRenderingContext2D): void {
  const { selectedIds, mode, transform, textEditingId, codeEditingId } = useSelectionStore.getState();
  const scale = useCameraStore.getState().scale;

  // 1. Marquee — independent of selection. Owned by SelectTool.
  const marqueeBBox = selectTool.getMarqueeBBox();
  if (marqueeBBox) drawMarqueeRect(ctx, marqueeBBox, scale);
  if (selectedIds.length === 0) return;

  const isTranslating = transform.kind === 'translate';

  // 2. Connector mode (single connector by invariant). Endpoint dots only — no bbox,
  // no polyline highlight, no resize handles.
  if (mode === 'connector') {
    if (!isTranslating) drawConnectorEndpointDots(ctx, selectedIds[0], transform);
    return;
  }

  // 3. Single non-connector selection — bounds rect doubles as highlight.
  if (selectedIds.length === 1) {
    const handle = getHandle(selectedIds[0]);
    if (!handle) return;
    const bbox = currentBoundsForHandle(handle, transform);
    drawSelectionBox(ctx, bbox, scale);
    const id = selectedIds[0];
    const isEditing = textEditingId === id || codeEditingId === id;
    if (!isTranslating && !isEditing && shouldShowHandles(bbox, scale)) {
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
    const bbox = currentBoundsForHandle(handle, transform);
    if (!bboxesIntersect(bbox, visible)) continue;
    ctx.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  }
  ctx.restore();

  // Selection-bounds rect + handles (sliding for scale, translated for translate, base for idle).
  const selRect = selectionRectForOverlay(transform);
  if (selRect) {
    drawSelectionBox(ctx, selRect, scale);
    if (!isTranslating && shouldShowHandles(selRect, scale) && textEditingId === null && codeEditingId === null) {
      drawResizeHandles(ctx, computeHandles(selRect), scale);
    }
  }
}

// =============================================================================
// PER-OBJECT BOUNDS / HIGHLIGHT
// =============================================================================

/**
 * Live bbox during transform; frame-aware fallback when idle (or when a transform has
 * begun but no movement has been applied yet — `entry.out.bbox` is uninitialized
 * between begin and the first update, so `transformHasChange()` gates the live read
 * and the function falls through to the idle path. Connector topology entries are
 * initialized correctly at build, so they don't need the gate. Endpoint drag never
 * reaches this function (connector mode renders dots only, never per-object bbox).
 */
function currentBoundsForHandle(handle: ObjectHandle, t: TransformState): BBoxTuple {
  if (handle.kind === 'connector') {
    if (t.kind === 'scale' || t.kind === 'translate') {
      const ce = getTransformTopology()?.byId.get(handle.id);
      if (ce) return ce.currBbox;
    }
    return handle.bbox;
  }
  if ((t.kind === 'scale' || t.kind === 'translate') && transformHasChange()) {
    const e = getScaleEntry(handle.kind as KindWithBBoxGeo, handle.id);
    if (e) return e.out.bbox;
  }
  if (handle.kind === 'text') {
    // handle.bbox carries italic-overhang horizontal padding (from computeTextBBox);
    // highlights/handles must sit on the visual frame edge, so prefer frameOf().
    const f = frameOf(handle);
    return f ? frameToBbox(f) : handle.bbox;
  }
  return handle.bbox;
}

// =============================================================================
// SELECTION BOX (multi-select)
// =============================================================================

/**
 * Sliding for scale, translated for translate, base bounds otherwise.
 * `transformHasChange()` short-circuits the transform paths to live
 * `computeSelectionBounds` before the first update fires — same graceful fallback
 * as `currentBoundsForHandle`.
 *
 * Scale: uses `uniformFactor` when `isOverlayUniform()` is true (every active kind
 * is `uniform`, OR all-connector selection on a corner). The all-connector branch
 * is the subtle one — connectors don't enter the entry store (topology owns
 * them), so their corner gesture transforms free endpoints via `uniformFactor`
 * and side gestures via per-axis `scaleAround` (rawScaleFactors hardcodes the
 * inactive axis to 1). The overlay must mirror that math — using `(sx, sy)` on
 * an all-connector corner would diagonal-stretch the rect while every connector
 * underneath uniform-scaled, breaking the "what you drag is what you get" cue.
 *
 * Translate: union frozen at `beginTranslate` (`getTranslateSelBounds`). Parallels
 * `scaleCtx.selBounds`; recomputing live every frame would let remote mid-drag
 * mutations wobble the rect.
 */
function selectionRectForOverlay(t: TransformState): BBoxTuple | null {
  if (t.kind === 'none' || !transformHasChange()) return computeSelectionBounds();
  if (t.kind === 'scale') {
    const s = getTransformScaleCtx();
    if (!s) return null;
    if (isOverlayUniform()) {
      const uf = uniformFactor(s.sx, s.sy, s.handleId);
      return scaleBBoxAround(s.selBounds, s.origin, uf, uf);
    }
    return scaleBBoxAround(s.selBounds, s.origin, s.sx, s.sy);
  }
  if (t.kind === 'translate') {
    const base = getTranslateSelBounds();
    if (!base) return null;
    const c = getController();
    return translateBBox(base, c.dx, c.dy);
  }
  return computeSelectionBounds();
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

function drawMarqueeRect(ctx: CanvasRenderingContext2D, marqueeRect: Readonly<BBoxTuple>, scale: number): void {
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
// CONNECTOR ENDPOINT DOTS
// =============================================================================

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
  let dragRouteCount = 0;

  if (isDragging) {
    const { endpoint, currentPosition, currentSnap: snap, pointsBuf, validCount } = transform;
    draggedEndpoint = endpoint;
    currentSnap = snap;
    dragRoute = validCount >= 2 ? pointsBuf : null;
    dragRouteCount = validCount;

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

  if (isDragging && dragRoute && dragRouteCount >= 2) {
    if (currentSnap?.kind === 'straight' && currentSnap.interior) {
      const lineEnd = draggedEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRouteCount - 1];
      drawConnectorDashGuide(ctx, currentSnap.position, lineEnd);
    }
    const otherEndpoint: 'start' | 'end' = draggedEndpoint === 'start' ? 'end' : 'start';
    const otherEp = handle.y.get(otherEndpoint) as ConnectorEndpoint | undefined;
    const otherAnchor = otherEp && !Array.isArray(otherEp) ? (otherEp as StoredAnchor) : undefined;
    if (otherAnchor && 'interior' in otherAnchor && otherAnchor.interior) {
      const otherPos = getEndpointEdgePosition(handle, otherEndpoint);
      const otherLineEnd = otherEndpoint === 'start' ? dragRoute[0] : dragRoute[dragRouteCount - 1];
      drawConnectorDashGuide(ctx, otherPos, otherLineEnd);
    }
    return;
  }

  const storedPoints = getConnectorRoute(handle.id);
  if (!storedPoints || storedPoints.length < 2) return;
  const startEp = handle.y.get('start') as ConnectorEndpoint | undefined;
  const endEp = handle.y.get('end') as ConnectorEndpoint | undefined;
  const startAnchor = startEp && !Array.isArray(startEp) ? (startEp as StoredAnchor) : undefined;
  const endAnchor = endEp && !Array.isArray(endEp) ? (endEp as StoredAnchor) : undefined;
  if (startAnchor && 'interior' in startAnchor && startAnchor.interior) {
    drawConnectorDashGuide(ctx, startPos, storedPoints[0]);
  }
  if (endAnchor && 'interior' in endAnchor && endAnchor.interior) {
    drawConnectorDashGuide(ctx, endPos, storedPoints[storedPoints.length - 1]);
  }
}
