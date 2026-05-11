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
import { drawHoveredOpenButton } from '@/core/bookmark/bookmark-render';
import { getEndpointEdgePosition, isInteriorAnchored } from '@/core/connectors/anchor-atoms';
import { SLOT_END, SLOT_START, slotKey, slotOther, slotPointIndex } from '@/core/connectors/reroute-connector';
import { frameToBbox, scaleBBoxAround, translateBBox } from '@/core/geometry/bounds';
import { frameOf } from '@/core/geometry/frame-of';
import { bboxesIntersect } from '@/core/geometry/hit-primitives';
import { uniformFactor } from '@/core/geometry/scale-system';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';
import { getConnectorRoute, getHandle } from '@/runtime/room-runtime';
import { selectTool } from '@/runtime/tool-registry';
import { getVisibleBoundsTuple, useCameraStore } from '@/stores/camera-store';
import { computeHandles, computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';
import type { EndpointDragEntry } from '@/tools/selection/connector-topology';
import {
  getController,
  getEndpointDragEntry,
  getScaleEntry,
  getTransformScaleCtx,
  getTransformTopology,
  getTranslateSelBounds,
  isOverlayUniform,
  type KindWithBBoxGeo,
  transformHasChange,
} from '@/tools/selection/transform';
import type { EndpointDragTransform, TransformState } from '@/tools/selection/types';
import { drawAnchorDot, drawConnectorDashGuide, drawSnapFeedback } from './connector-render-atoms';
import { drawResizeHandles } from './handle-stamp';

// =============================================================================
// STYLING CONSTANTS
// =============================================================================

const SELECTION_STYLE = {
  PRIMARY: 'rgba(29, 78, 216, 1)',
  PRIMARY_FILL: 'rgba(29, 78, 216, 0.15)',
  PRIMARY_MUTED: 'rgba(29, 78, 216, 0.7)',
  // Base stroke widths in CSS pixels at scale=1. Sized for "crisp" — slightly
  // thinner than a normal 2px hairline. World-space cap (`STROKE_WORLD_FACTOR`)
  // takes over for highlights/box when zoomed far out (see
  // `selectionStrokeWidthW`); the marquee keeps its plain `width / scale`
  // behaviour (no cap) — its visual weight at low zoom was deliberate.
  HIGHLIGHT_WIDTH_PX: 1.5,
  BOX_WIDTH_PX: 1.5,
  MARQUEE_WIDTH_PX: 1.5,
} as const;

/**
 * Selection-overlay stroke width in world units, capped so it doesn't grow
 * unboundedly as the user zooms out.
 *
 * Pure screen-space (`basePx / scale`) at normal zoom; clamped at
 * `basePx * STROKE_WORLD_FACTOR` world units below the threshold zoom. The
 * cap engages at `scale ≤ 1 / STROKE_WORLD_FACTOR` (i.e. 0.5 with factor 2),
 * so above that the overlay looks identical to the old pure-screen-space form.
 *
 * Below the threshold the line gets thinner ON SCREEN as the user zooms out
 * further — keeps highlights/bboxes from dominating small zoomed-out objects.
 * "Understanding of world space": the line tracks world units when zoomed-out
 * geometry is the limiting factor.
 */
const STROKE_WORLD_FACTOR = 2;
function selectionStrokeWidthW(basePx: number, scale: number): number {
  return Math.min(basePx / scale, basePx * STROKE_WORLD_FACTOR);
}

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
 * Bookmark Open-button hover paints FIRST — it's a continuation of the base
 * canvas's own button paint (the bookmark's face), not standard overlay UI.
 * Selection bbox stroke + resize handles must draw above it, exactly as they
 * do for any other selected object. Runs even with empty selection so a hover-
 * only state still paints — `drawSelectionPrimary` early-returns on empty.
 */
export function drawSelectionOverlay(ctx: CanvasRenderingContext2D): void {
  const hoveredId = selectTool.getHoveredOpenBookmarkId();
  if (hoveredId !== null) drawHoveredOpenButton(ctx, hoveredId);
  drawSelectionPrimary(ctx);
}

/**
 * Selection primary visuals (marquee, per-object highlights, bounds rect,
 * handles, connector endpoint dots).
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
function drawSelectionPrimary(ctx: CanvasRenderingContext2D): void {
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

  const hideHandlesForEdit = shouldHideHandlesForEditing(textEditingId, codeEditingId);

  // 3. Single non-connector selection — bounds rect doubles as highlight.
  if (selectedIds.length === 1) {
    const handle = getHandle(selectedIds[0]);
    if (!handle) return;
    const bbox = currentBoundsForHandle(handle, transform);
    drawSelectionBox(ctx, bbox, scale);
    if (!isTranslating && !hideHandlesForEdit && shouldShowHandles(bbox, scale)) {
      drawResizeHandles(ctx, computeHandles(bbox), scale);
    }
    return;
  }

  // 4. Multi-selection.
  const visible = getVisibleBoundsTuple();
  ctx.save();
  ctx.strokeStyle = SELECTION_STYLE.PRIMARY;
  ctx.lineWidth = selectionStrokeWidthW(SELECTION_STYLE.HIGHLIGHT_WIDTH_PX, scale);
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
    if (!isTranslating && !hideHandlesForEdit && shouldShowHandles(selRect, scale)) {
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
  ctx.lineWidth = selectionStrokeWidthW(SELECTION_STYLE.BOX_WIDTH_PX, scale);
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
  if (!handle || handle.kind !== 'connector') return;
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
