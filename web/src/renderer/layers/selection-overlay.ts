/**
 * Selection Overlay Rendering
 *
 * Reads state directly from stores + transform getters (no SelectTool plumbing).
 * Handles use a pre-rendered bitmap stamp to keep `shadowBlur` off the hot path.
 * Per-mode dispatch + per-call WHY live on the individual functions below.
 *
 * Two cross-cutting concerns:
 *   - Per-object rects read the gesture engine's seeded out-bbox lanes without
 *     a hasChange gate (seeded = at-rest rect, identical pre-first-move); the
 *     UNION rect keeps `transformHasChange()` gating its scale/translate math.
 *   - `shouldShowHandles` is the single render/hit/cursor visibility gate so
 *     they can never disagree.
 *
 * CRITICAL: This is called INSIDE world transform scope.
 *
 * @module renderer/layers/selection-overlay
 */

import { getConnectorType } from '@/core/accessors';
import { getEndpointEdgePosition, isInteriorAnchored } from '@/core/connectors/anchor-atoms';
import { SLOT_END, SLOT_START, slotKey, slotOther, slotPointIndex } from '@/core/connectors/reroute-connector';
import { frameOf } from '@/core/geometry/frame-of';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { uniformFactor } from '@/core/geometry/scale-system';
import { getBBoxColumn } from '@/core/slots/slot-table';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { computeHandles } from '@/core/types/handles';
import type { ObjectHandle } from '@/core/types/objects';
import { getConnectorRoute, getHandle } from '@/runtime/room-runtime';
import { selectTool } from '@/runtime/tool-registry';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import type { EndpointDragEntry } from '@/tools/selection/connector-topology';
import {
  getEndpointDragEntry,
  getGestureLanes,
  getGestureSlotMap,
  getTopoEntries,
  getTransformModeCode,
  getTransformScaleCtx,
  getTranslateDX,
  getTranslateDY,
  getTranslateSelBounds,
  isOverlayUniform,
  transformHasChange,
} from '@/tools/selection/transform';
import { G_STRIDE, GIDX_MASK, TOPO_TAG } from '@/tools/selection/transform-kernels';
import type { EndpointDragTransform, TransformState } from '@/tools/selection/types';
import { drawConnectorFlow } from './connector-flow';
import { drawAnchorDot, drawConnectorDashGuide, drawSnapFeedback } from './connector-render-atoms';
import { drawResizeHandles } from './handle-stamp';

// =============================================================================
// STYLING CONSTANTS
// =============================================================================

const SELECTION_STYLE = {
  PRIMARY: 'rgba(29, 78, 216, 1)',
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)',
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)',
  // Base stroke widths in CSS pixels — rendered as `basePx / scale` so they
  // stay constant on screen across zoom levels.
  HIGHLIGHT_WIDTH_PX: 1.5,
  BOX_WIDTH_PX: 1.75,
  MARQUEE_WIDTH_PX: 1.5,
} as const;

/**
 * **Handle visibility while EDITING — DO NOT collapse to a generic "is editing"
 * check.** This rule has been re-fixed multiple times; every time the overlay
 * is rewritten the kind discrimination gets dropped and shape/note label
 * editing loses its handles.
 *
 * Hide handles only when the editor's DOM occupies the ENTIRE bbox/frame:
 *   - `text` (standalone) → DOM = frame, zero padding. Handles would overlap
 *     the caret / drag-resize the box out from under the cursor. HIDE.
 *   - `code` (CodeMirror)  → DOM = frame, zero padding. Same reason. HIDE.
 *
 * Keep handles VISIBLE when editing happens INSIDE a padded shell:
 *   - `shape` (label) → bbox encloses the shape stroke; the label DOM lives
 *     packed strictly inside `computeLabelTextBox`. Handles sit on the bbox
 *     edge — well outside the editor — so they don't fight the caret.
 *   - `note`  (label) → bbox encloses note shadow + content padding. The
 *     editor DOM is packed inside; handles on the bbox edge are clear of it.
 *
 * Hit-testing already does the right thing (`SelectTool` gates on
 * `textTool.isEditingLabel()`); the bug surfaces purely on the render side
 * if this check is collapsed.
 */
function shouldHideHandlesForEditing(textEditingId: string | null, codeEditingId: string | null): boolean {
  if (codeEditingId !== null) return true; // code blocks are always pure-DOM
  if (textEditingId === null) return false;
  return getHandle(textEditingId)?.kind === 'text';
}

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
  const { selectedIds, mode, transform, textEditingId, codeEditingId, selectionLocked } = useSelectionStore.getState();
  const scale = useCameraStore.getState().scale;

  // 1. Marquee — independent of selection. Owned by SelectTool.
  const marqueeBBox = selectTool.getMarqueeBBox();
  if (marqueeBBox) drawMarqueeRect(ctx, marqueeBBox, scale);

  // 1b. Connector flows — buttons + hover preview + live drag connector. Drawn
  // before the empty-selection return so the drag preview survives the cleared
  // selection mid-drag. Self-gates internally.
  drawConnectorFlow(ctx);

  if (selectedIds.length === 0) return;

  const isTranslating = transform.kind === 'translate';

  // 2. Connector mode (single connector by invariant). Endpoint dots only — no bbox,
  // no polyline highlight, no resize handles. A locked connector draws no dots
  // (nothing to drag) and falls through to the plain selection box for feedback.
  if (mode === 'connector' && !selectionLocked) {
    if (!isTranslating) drawConnectorEndpointDots(ctx, selectedIds[0], transform);
    return;
  }

  const hideHandlesForEdit = shouldHideHandlesForEditing(textEditingId, codeEditingId);

  // 3. Single non-connector selection — bounds rect doubles as highlight.
  if (selectedIds.length === 1) {
    const handle = getHandle(selectedIds[0]);
    if (!handle) return;
    const bbox = currentBoundsForHandle(handle);
    drawSelectionBox(ctx, bbox, scale);
    if (!isTranslating && !hideHandlesForEdit && !selectionLocked && shouldShowHandles(bbox, scale)) {
      drawResizeHandles(ctx, computeHandles(bbox), scale);
    }
    return;
  }

  // 4. Multi-selection.
  const visible = getVisibleBoundsTuple();
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.HIGHLIGHT_WIDTH_PX / scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!handle) continue;
    const bbox = currentBoundsForHandle(handle);
    if (!bboxesIntersect(bbox, visible)) continue;
    ctx.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  }
  ctx.restore();

  // Selection-bounds rect + handles (sliding for scale, translated for translate, base for idle).
  const selRect = selectionRectForOverlay();
  if (selRect) {
    drawSelectionBox(ctx, selRect, scale);
    if (!isTranslating && !hideHandlesForEdit && !selectionLocked && shouldShowHandles(selRect, scale)) {
      drawResizeHandles(ctx, computeHandles(selRect), scale);
    }
  }
}

// =============================================================================
// PER-OBJECT BOUNDS / HIGHLIGHT
// =============================================================================

/** Module scratch for `currentBoundsForHandle` / `selectionRectForOverlay` —
 *  callers consume (strokeRect / computeHandles) before the next call. */
const _boundsScratch: BBoxTuple = [0, 0, 0, 0];
const _selRectScratch: BBoxTuple = [0, 0, 0, 0];

/**
 * Live per-object rect, routed through the gesture engine's sparse slot map:
 * topology connectors return their live `currBbox` ref; gesture entries the
 * out-bbox lanes (NO hasChange gate — seeded lanes ≡ the at-rest rect, and
 * for text the seeded fBBox is the TIGHT frame bbox, exactly the old idle
 * `frameOf` read); idle text the derived frame (italic-overhang pad lives on
 * the column rect, not the visual edge); everything else the column rect.
 * Returns a module scratch (or the entry ref) — consume immediately.
 */
function currentBoundsForHandle(handle: ObjectHandle): BBoxTuple {
  const sg = getGestureSlotMap();
  const g = sg[handle.slot];
  if (handle.kind === 'connector') {
    if (g >= 0 && (g & TOPO_TAG) !== 0) {
      const entries = getTopoEntries();
      if (entries) return entries[g & GIDX_MASK].currBbox;
    }
  } else {
    const tmode = getTransformModeCode();
    if (g >= 0 && (tmode === 1 || tmode === 2)) {
      const lanes = getGestureLanes();
      const b = g * G_STRIDE;
      _boundsScratch[0] = lanes[b + 8];
      _boundsScratch[1] = lanes[b + 9];
      _boundsScratch[2] = lanes[b + 10];
      _boundsScratch[3] = lanes[b + 11];
      return _boundsScratch;
    }
    if (handle.kind === 'text') {
      const f = frameOf(handle);
      if (f) {
        _boundsScratch[0] = f[0];
        _boundsScratch[1] = f[1];
        _boundsScratch[2] = f[0] + f[2];
        _boundsScratch[3] = f[1] + f[3];
        return _boundsScratch;
      }
    }
  }
  const col = getBBoxColumn();
  const o = handle.slot * 4;
  _boundsScratch[0] = col[o];
  _boundsScratch[1] = col[o + 1];
  _boundsScratch[2] = col[o + 2];
  _boundsScratch[3] = col[o + 3];
  return _boundsScratch;
}

// =============================================================================
// SELECTION BOX (multi-select)
// =============================================================================

/**
 * Sliding for scale, translated for translate, base bounds otherwise.
 * `transformHasChange()` short-circuits the transform paths to live
 * `computeSelectionBounds` before the first update fires.
 *
 * Scale: uses `uniformFactor` when `isOverlayUniform()` is true (every active kind
 * is `uniform`, OR all-connector selection on a corner). The all-connector branch
 * is the subtle one — connectors don't enter the lane buffer (topology owns
 * them), so their corner gesture transforms free endpoints via `uniformFactor`
 * and side gestures via per-axis `scaleAround` (rawScaleFactors hardcodes the
 * inactive axis to 1). The overlay must mirror that math — using `(sx, sy)` on
 * an all-connector corner would diagonal-stretch the rect while every connector
 * underneath uniform-scaled, breaking the "what you drag is what you get" cue.
 *
 * Translate: union frozen at `beginTranslate` (`getTranslateSelBounds`). Parallels
 * `scaleCtx.selBounds`; recomputing live every frame would let remote mid-drag
 * mutations wobble the rect. Both transform arms fill a module scratch
 * (alloc-free `scaleBBoxAround`/`translateBBox` ports).
 */
function selectionRectForOverlay(): BBoxTuple | null {
  const tmode = getTransformModeCode();
  if (tmode === 0 || !transformHasChange()) return computeSelectionBounds();
  if (tmode === 1) {
    const s = getTransformScaleCtx();
    if (!s) return null;
    let sx = s.sx;
    let sy = s.sy;
    if (isOverlayUniform()) {
      const uf = uniformFactor(s.sx, s.sy, s.handleId);
      sx = uf;
      sy = uf;
    }
    // scaleBBoxAround, inlined into the scratch (same math, no tuple alloc).
    const o = s.origin;
    const bb = s.selBounds;
    const x1 = o[0] + (bb[0] - o[0]) * sx;
    const y1 = o[1] + (bb[1] - o[1]) * sy;
    const x2 = o[0] + (bb[2] - o[0]) * sx;
    const y2 = o[1] + (bb[3] - o[1]) * sy;
    _selRectScratch[0] = Math.min(x1, x2);
    _selRectScratch[1] = Math.min(y1, y2);
    _selRectScratch[2] = Math.max(x1, x2);
    _selRectScratch[3] = Math.max(y1, y2);
    return _selRectScratch;
  }
  if (tmode === 2) {
    const base = getTranslateSelBounds();
    if (!base) return null;
    const dx = getTranslateDX();
    const dy = getTranslateDY();
    _selRectScratch[0] = base[0] + dx;
    _selRectScratch[1] = base[1] + dy;
    _selRectScratch[2] = base[2] + dx;
    _selRectScratch[3] = base[3] + dy;
    return _selRectScratch;
  }
  return computeSelectionBounds();
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, bounds: BBoxTuple, scale: number): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = SELECTION_STYLE.BOX_WIDTH_PX / scale;
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
  ctx.lineWidth = SELECTION_STYLE.MARQUEE_WIDTH_PX / scale;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

// =============================================================================
// CONNECTOR ENDPOINT DOTS
// =============================================================================

/**
 * Endpoint dots in connector mode. Idle and dragging branches are split into
 * separate functions: each owns its own straight-line logic with no `let`
 * accumulator dance. The dragging branch reads route points off the
 * controller's synthetic ConnectorEntry — same source the renderer uses,
 * so the dashed guide always agrees with the rerouted polyline.
 */
function drawConnectorEndpointDots(ctx: CanvasRenderingContext2D, connectorId: string, transform: TransformState): void {
  const handle = getHandle(connectorId);
  if (handle?.kind !== 'connector') return;
  const isStraight = getConnectorType(handle.y) === 'straight';

  if (transform.kind === 'endpointDrag' && transform.connectorId === connectorId) {
    drawDraggingConnectorDots(ctx, handle, transform, getEndpointDragEntry(), isStraight);
    return;
  }
  drawIdleConnectorDots(ctx, handle, isStraight);
}

function drawIdleConnectorDots(ctx: CanvasRenderingContext2D, handle: ObjectHandle, isStraight: boolean): void {
  const startPos = getEndpointEdgePosition(handle, 'start');
  const endPos = getEndpointEdgePosition(handle, 'end');
  drawAnchorDot(ctx, startPos, false);
  drawAnchorDot(ctx, endPos, false);
  if (!isStraight) return;
  const route = getConnectorRoute(handle.id);
  if (!route || route.length < 2) return;
  if (isInteriorAnchored(handle, SLOT_START)) drawConnectorDashGuide(ctx, startPos, route[0]);
  if (isInteriorAnchored(handle, SLOT_END)) drawConnectorDashGuide(ctx, endPos, route[route.length - 1]);
}

function drawDraggingConnectorDots(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  t: EndpointDragTransform,
  ce: EndpointDragEntry | null,
  isStraight: boolean,
): void {
  const { slot, currentPosition, currentSnap } = t;
  const draggedPos: Point = currentSnap ? currentSnap.position : currentPosition;
  const otherSlot = slotOther(slot);
  const otherPos = getEndpointEdgePosition(handle, slotKey(otherSlot));

  if (currentSnap) drawSnapFeedback(ctx, currentSnap);
  else drawAnchorDot(ctx, draggedPos, false);
  drawAnchorDot(ctx, otherPos, false);

  if (!isStraight || !ce || ce.validCount < 2) return;
  const { pointsBuf, validCount } = ce;

  if (currentSnap?.kind === 'straight' && currentSnap.interior) {
    drawConnectorDashGuide(ctx, currentSnap.position, pointsBuf[slotPointIndex(slot, validCount)]);
  }
  if (isInteriorAnchored(handle, otherSlot)) {
    drawConnectorDashGuide(ctx, otherPos, pointsBuf[slotPointIndex(otherSlot, validCount)]);
  }
}
