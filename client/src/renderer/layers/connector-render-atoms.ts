/**
 * Shared connector draw atoms.
 *
 * Single home for the pixel-level draw primitives any connector layer needs:
 *
 *  - `paintConnector` — strokes a connector's polyline + arrow caps using the
 *    user-supplied color/width/opacity. Shared by `objects.ts` (committed /
 *    transform-preview connectors) and `connector-preview.ts` (in-flight).
 *  - Selection/preview decoration atoms (`drawAnchorDot`, `drawConnectorDashGuide`,
 *    `drawSnapTargetHighlight`, `drawShapeMidpoints`, `drawStraightCenterDot`,
 *    `drawSnapFeedback`) — constant blue/black styling for the UI overlays in
 *    `connector-preview.ts` and `selection-overlay.ts`.
 *
 * Atoms never re-lookup what the caller already has (`handle`, `frame`, `shapeType`).
 *
 * @module renderer/layers/connector-render-atoms
 */

import type { FrameTuple } from '@/core/types/geometry';
import { type ObjectHandle, isBindableHandle } from '@/core/types/objects';
import { type Dir, type SnapTarget, isAnchorInterior } from '@/core/connectors/types';
import { ANCHOR_DOT_CONFIG, getAnchorDotMetricsWorld, getGuideMetricsWorld } from '@/core/connectors/constants';
import { getShapeTypeMidpoints } from '@/core/connectors/connector-utils';
import { type ConnectorPaths, ARROW_ROUNDING_LINE_WIDTH } from '@/core/connectors/connector-paths';
import { getPath } from '../geometry-cache';
import { getWidth, getHandleShapeType } from '@/core/accessors';
import { useCameraStore } from '@/stores/camera-store';
import { getHandle } from '@/runtime/room-runtime';
import { frameOf } from '@/core/geometry/frame-of';

/**
 * Stroke a connector's polyline + fill/stroke its arrow caps in one call.
 *
 * The same paint pass is used in four places — two in `objects.ts` (cached
 * connectors via `drawConnector`, rerouted connectors via `drawConnectorFromPoints`)
 * and one in `connector-preview.ts` (in-flight connector during creation) — so
 * the context setup and Path2D drawing live here to keep them in lock-step.
 * Callers provide the already-built `ConnectorPaths` and the user style.
 */
export function paintConnector(ctx: CanvasRenderingContext2D, paths: ConnectorPaths, color: string, width: number, opacity: number): void {
  ctx.save();
  ctx.globalAlpha = opacity;

  // Pass 1: polyline stroke with rounded caps/joins
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(paths.polyline);

  // Pass 2: arrows (fill + stroke for rounded corners at a fixed width)
  ctx.fillStyle = color;
  ctx.lineWidth = ARROW_ROUNDING_LINE_WIDTH;

  if (paths.startArrow) {
    ctx.fill(paths.startArrow);
    ctx.stroke(paths.startArrow);
  }
  if (paths.endArrow) {
    ctx.fill(paths.endArrow);
    ctx.stroke(paths.endArrow);
  }

  ctx.restore();
}

/**
 * Dashed guide line between two world points.
 *
 * Constant 1.5/scale width, solid black with 0.5 alpha. Used for interior
 * anchor guides on straight connectors in both preview and selection states.
 */
export function drawConnectorDashGuide(ctx: CanvasRenderingContext2D, from: [number, number], to: [number, number]): void {
  const scale = useCameraStore.getState().scale;
  const { dashLength, gapLength } = getGuideMetricsWorld();
  ctx.save();
  ctx.setLineDash([dashLength, gapLength]);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5 / scale;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Single anchor dot — sits on the shape frame point, never offset outward.
 *
 * `active=true` → large radius, blue fill, white stroke, subtle glow.
 * `active=false` → small radius, white fill, blue stroke.
 */
export function drawAnchorDot(ctx: CanvasRenderingContext2D, position: [number, number], active: boolean): void {
  const { smallRadius, largeRadius, strokeWidth, glowBlur } = getAnchorDotMetricsWorld();
  const radius = active ? largeRadius : smallRadius;
  ctx.save();
  if (active) {
    ctx.shadowColor = ANCHOR_DOT_CONFIG.GLOW_COLOR;
    ctx.shadowBlur = glowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.beginPath();
  ctx.arc(position[0], position[1], radius, 0, Math.PI * 2);
  ctx.fillStyle = active ? ANCHOR_DOT_CONFIG.ACTIVE_FILL : ANCHOR_DOT_CONFIG.INACTIVE_FILL;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.strokeStyle = active ? ANCHOR_DOT_CONFIG.ACTIVE_STROKE : ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
  ctx.restore();
}

/**
 * Target shape outline — blue highlight around the shape the connector would snap to.
 * Uses the cached shape Path2D when available (handles rounded rects, ellipses, diamonds);
 * falls back to a strokeRect on the frame for text/code/image/note/bookmark.
 */
export function drawSnapTargetHighlight(ctx: CanvasRenderingContext2D, handle: ObjectHandle | null, frame: FrameTuple): void {
  const scale = useCameraStore.getState().scale;
  ctx.save();
  ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = 'round';
  if (handle?.kind === 'shape') {
    const path = getPath(handle.id, handle);
    const sw = getWidth(handle.y, 2);
    const [fx, fy, fw, fh] = frame;
    const cx = fx + fw / 2;
    const cy = fy + fh / 2;
    const sx = fw > 0 ? (fw + sw) / fw : 1;
    const sy = fh > 0 ? (fh + sw) / fh : 1;
    ctx.translate(cx, cy);
    ctx.scale(sx, sy);
    ctx.translate(-cx, -cy);
    ctx.stroke(path);
  } else {
    ctx.strokeRect(frame[0], frame[1], frame[2], frame[3]);
  }
  ctx.restore();
}

/**
 * The four midpoint dots on a shape.
 *
 * All four are drawn inactive (blue-stroke-on-white). When `isMidpointActive` is
 * true, sizes grow to `largeRadius` and the `activeSide` midpoint is skipped so
 * the caller can render the glowing active dot over the top with `drawAnchorDot`.
 */
export function drawShapeMidpoints(
  ctx: CanvasRenderingContext2D,
  frame: FrameTuple,
  shapeType: string,
  activeSide: Dir | null,
  isMidpointActive: boolean,
): void {
  const { smallRadius, largeRadius, strokeWidth } = getAnchorDotMetricsWorld();
  const radius = isMidpointActive ? largeRadius : smallRadius;
  const midpoints = getShapeTypeMidpoints(frame, shapeType);
  ctx.save();
  ctx.lineWidth = strokeWidth;
  ctx.fillStyle = ANCHOR_DOT_CONFIG.INACTIVE_FILL;
  ctx.strokeStyle = ANCHOR_DOT_CONFIG.INACTIVE_STROKE;
  for (const [s, pos] of Object.entries(midpoints) as [Dir, [number, number]][]) {
    if (isMidpointActive && s === activeSide) continue;
    ctx.beginPath();
    ctx.arc(pos[0], pos[1], radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Center dot for straight connectors. `active=true` when snapped to center.
 */
export function drawStraightCenterDot(ctx: CanvasRenderingContext2D, frame: FrameTuple, active: boolean): void {
  const cx = frame[0] + frame[2] / 2;
  const cy = frame[1] + frame[3] / 2;
  drawAnchorDot(ctx, [cx, cy], active);
}

// =============================================================================
// SNAP-DRIVEN COMPOSITES
// =============================================================================

/** True when a snap target is pinned to the shape's interior center `[0.5, 0.5]`. */
export function isCenterSnap(snap: SnapTarget): boolean {
  return isAnchorInterior(snap.normalizedAnchor) && snap.normalizedAnchor[0] === 0.5 && snap.normalizedAnchor[1] === 0.5;
}

/**
 * Resolve the shape a snap target points at — handle + frame + shape type in one step.
 * Returns null when the target isn't bindable or the shape hasn't hydrated a frame yet.
 */
export function resolveSnapContext(snap: SnapTarget): { handle: ObjectHandle; frame: FrameTuple; shapeType: string } | null {
  const handle = getHandle(snap.shapeId);
  if (!isBindableHandle(handle)) return null;
  const frame = frameOf(handle);
  if (!frame) return null;
  return { handle, frame, shapeType: getHandleShapeType(handle) };
}

/**
 * Full snap-target feedback in one call: shape outline highlight, midpoint dots,
 * straight-center dot, and the active anchor dot at `snap.edgePosition`. When the
 * snap sits at the straight center, the center dot doubles as the active dot and
 * the edge-position dot is skipped to avoid double-stamping.
 *
 * Shared by `connector-preview.ts` (hover during creation) and `selection-overlay.ts`
 * (endpoint drag). Pass `null` to no-op — keeps call sites flat.
 */
export function drawSnapFeedback(ctx: CanvasRenderingContext2D, snap: SnapTarget | null, isStraight: boolean): void {
  if (!snap) return;
  const snapCtx = resolveSnapContext(snap);
  if (!snapCtx) return;
  const centered = isStraight && isCenterSnap(snap);
  drawSnapTargetHighlight(ctx, snapCtx.handle, snapCtx.frame);
  drawShapeMidpoints(ctx, snapCtx.frame, snapCtx.shapeType, snap.side, snap.isMidpoint);
  if (isStraight) drawStraightCenterDot(ctx, snapCtx.frame, centered);
  if (!centered) drawAnchorDot(ctx, snap.edgePosition, true);
}
