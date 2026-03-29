/**
 * Scale Transform Math Utilities
 *
 * Pure functions for computing scale transforms, shared by:
 * - SelectTool.ts (selection scaling)
 * - objects.ts (scale preview rendering)
 */

import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds, FrameTuple, ObjectKind } from '@avlo/shared';
import { translateBounds, scaleBoundsAround } from './bounds';
import { isCornerHandle } from '@/stores/selection-store';
import type { TranslateTransform, ScaleTransform } from '@/stores/selection-store';

/**
 * WorldRect is an alias for WorldBounds from the shared package.
 * @deprecated Prefer using WorldBounds directly from @avlo/shared
 */
export type WorldRect = WorldBounds;

// Minimal ObjectHandle interface for stroke translation
export interface ObjectHandleForScale {
  bbox: [number, number, number, number];
  y: {
    get: (key: string) => unknown;
  };
}

/**
 * Compute uniform scale with NO threshold - immediate flip when dominant < 0.
 * Used for stroke "copy-paste" behavior where we want snap positioning.
 */
export function computeUniformScaleNoThreshold(scaleX: number, scaleY: number): number {
  const absX = Math.abs(scaleX);
  const absY = Math.abs(scaleY);
  const STROKE_MIN = 0.001;

  // Both negative → immediate flip
  if (scaleX < 0 && scaleY < 0) {
    const magnitude = Math.max(absX, absY, STROKE_MIN);
    return -magnitude;
  }

  // Side handles → use ONLY the active axis magnitude (allows shrinking below 1)
  if (scaleY === 1 && scaleX !== 1) {
    const magnitude = Math.max(absX, STROKE_MIN);
    return scaleX < 0 ? -magnitude : magnitude;
  }
  if (scaleX === 1 && scaleY !== 1) {
    const magnitude = Math.max(absY, STROKE_MIN);
    return scaleY < 0 ? -magnitude : magnitude;
  }

  // Corner drag → immediate flip when dominant < 0 (NO threshold)
  const magnitude = Math.max(absX, absY, STROKE_MIN);
  const dominantScale = absX >= absY ? scaleX : scaleY;
  return dominantScale < 0 ? -magnitude : magnitude;
}

/**
 * Compute position that preserves relative arrangement in selection box.
 * When flipping, objects maintain their relative position (0-1) within the box
 * instead of inverting (close-to-origin becomes far-from-origin).
 */
export function computePreservedPosition(
  cx: number,
  cy: number,
  originBounds: WorldRect,
  origin: [number, number],
  uniformScale: number,
): [number, number] {
  const [ox, oy] = origin;
  const { minX, minY, maxX, maxY } = originBounds;
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;

  // Relative position in original box (0-1)
  const tx = boxWidth > 0 ? (cx - minX) / boxWidth : 0.5;
  const ty = boxHeight > 0 ? (cy - minY) / boxHeight : 0.5;

  // Compute new box corners (both transform around origin)
  const newCorner1X = ox + (minX - ox) * uniformScale;
  const newCorner1Y = oy + (minY - oy) * uniformScale;
  const newCorner2X = ox + (maxX - ox) * uniformScale;
  const newCorner2Y = oy + (maxY - oy) * uniformScale;

  // Get actual min/max (handles flip)
  const newMinX = Math.min(newCorner1X, newCorner2X);
  const newMinY = Math.min(newCorner1Y, newCorner2Y);
  const newBoxWidth = Math.abs(newCorner2X - newCorner1X);
  const newBoxHeight = Math.abs(newCorner2Y - newCorner1Y);

  // Apply same relative position in new box
  return [newMinX + tx * newBoxWidth, newMinY + ty * newBoxHeight];
}

/**
 * Compute edge-pinning translation from geometry bounds.
 * Core logic shared by strokes (via points) and text (via frame).
 */
export function computeEdgePinTranslation(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId,
): { dx: number; dy: number } {
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const [ox, oy] = origin;

  const EPS = 1e-3;
  const isHorizontal = handleId === 'e' || handleId === 'w';
  const isVertical = handleId === 'n' || handleId === 's';

  let dx = 0;
  let dy = 0;

  if (isHorizontal) {
    const anchorX = handleId === 'e' ? originBounds.minX : originBounds.maxX;

    const touchesLeft = Math.abs(minX - anchorX) < EPS;
    const touchesRight = Math.abs(maxX - anchorX) < EPS;
    const isAnchor = touchesLeft || touchesRight;

    if (isAnchor) {
      if (scaleX >= 0) {
        const edgeX = touchesLeft ? minX : maxX;
        dx = anchorX - edgeX;
      } else {
        const edgeX = touchesLeft ? maxX : minX;
        dx = anchorX - edgeX;
      }
    } else {
      const newCx = ox + (cx - ox) * scaleX;
      dx = newCx - cx;
      if (scaleX < 0) {
        const halfWidth = (maxX - minX) / 2;
        dx += handleId === 'w' ? -halfWidth : halfWidth;
      }
    }
  } else if (isVertical) {
    const anchorY = handleId === 's' ? originBounds.minY : originBounds.maxY;

    const touchesTop = Math.abs(minY - anchorY) < EPS;
    const touchesBottom = Math.abs(maxY - anchorY) < EPS;
    const isAnchor = touchesTop || touchesBottom;

    if (isAnchor) {
      if (scaleY >= 0) {
        const edgeY = touchesTop ? minY : maxY;
        dy = anchorY - edgeY;
      } else {
        const edgeY = touchesTop ? maxY : minY;
        dy = anchorY - edgeY;
      }
    } else {
      const newCy = oy + (cy - oy) * scaleY;
      dy = newCy - cy;
      if (scaleY < 0) {
        const halfHeight = (maxY - minY) / 2;
        dy += handleId === 's' ? halfHeight : -halfHeight;
      }
    }
  } else {
    const newCx = ox + (cx - ox) * scaleX;
    const newCy = oy + (cy - oy) * scaleY;
    dx = newCx - cx;
    dy = newCy - cy;
  }

  return { dx, dy };
}

/**
 * Compute translation for a bookmark during corner/bookmarksOnly scale.
 * Bookmark dimensions stay fixed — only the center translates using preserved position logic.
 */
export function computeBookmarkCornerTranslation(
  frame: FrameTuple,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
): { dx: number; dy: number } {
  const cx = frame[0] + frame[2] / 2;
  const cy = frame[1] + frame[3] / 2;
  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);
  return { dx: newCx - cx, dy: newCy - cy };
}

/**
 * Compute translation for a stroke in mixed + side handle scenario.
 * Reads points from handle, computes geometry bounds, delegates to computeEdgePinTranslation.
 */
export function computeStrokeTranslation(
  handle: ObjectHandleForScale,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId,
): { dx: number; dy: number } {
  const points = handle.y.get('points') as [number, number][] | undefined;
  if (!points || points.length === 0) return { dx: 0, dy: 0 };

  let minX = points[0][0],
    maxX = points[0][0];
  let minY = points[0][1],
    maxY = points[0][1];
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  return computeEdgePinTranslation(
    minX,
    maxX,
    minY,
    maxY,
    originBounds,
    scaleX,
    scaleY,
    origin,
    handleId,
  );
}

// === Transform Application Helpers ===

/**
 * Transform state interface for bounds application.
 */
export interface TransformForBounds {
  kind: string;
  dx?: number;
  dy?: number;
  scaleX?: number;
  scaleY?: number;
  origin?: [number, number];
}

/**
 * Apply a transform (translate or scale) to bounds.
 * Returns new bounds with transform applied.
 */
export function applyTransformToBounds(
  bounds: WorldRect,
  transform: TransformForBounds,
): WorldRect {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return translateBounds(bounds, transform.dx, transform.dy);
  }

  if (
    transform.kind === 'scale' &&
    transform.origin &&
    transform.scaleX !== undefined &&
    transform.scaleY !== undefined
  ) {
    // CRITICAL: scaleBoundsAround normalizes for negative scale (flip) - ensures minX < maxX, minY < maxY
    return scaleBoundsAround(bounds, transform.origin, transform.scaleX, transform.scaleY);
  }

  return bounds;
}

/**
 * Scale transform state interface for computing scale factors.
 */
export interface ScaleTransformState {
  origin: [number, number];
  initialDelta: [number, number];
  handleId: HandleId;
}

/**
 * Compute scale factors from cursor position relative to transform state.
 *
 * @param worldX - Current cursor X in world coordinates
 * @param worldY - Current cursor Y in world coordinates
 * @param transform - Scale transform state with origin, initialDelta, and handleId
 */
export function computeScaleFactors(
  worldX: number,
  worldY: number,
  transform: ScaleTransformState,
): { scaleX: number; scaleY: number } {
  const { origin, initialDelta, handleId } = transform;
  const [ox, oy] = origin;
  const [initDx, initDy] = initialDelta;

  // Vector from origin to cursor
  const dx = worldX - ox;
  const dy = worldY - oy;

  let scaleX = 1;
  let scaleY = 1;

  const isCorner = isCornerHandle(handleId);
  const isSideH = handleId === 'e' || handleId === 'w';
  const isSideV = handleId === 'n' || handleId === 's';

  // Use initialDelta as denominator (NOT selection bounds width)
  // This ensures scaleX=1.0 exactly when cursor == downWorld (start position)
  // Sign handling is implicit: if initDx is negative (left handle), scale sign is preserved
  const MIN_DELTA = 0.001;
  const safeDx = Math.abs(initDx) > MIN_DELTA ? initDx : initDx >= 0 ? MIN_DELTA : -MIN_DELTA;
  const safeDy = Math.abs(initDy) > MIN_DELTA ? initDy : initDy >= 0 ? MIN_DELTA : -MIN_DELTA;

  if (isCorner) {
    // Corner handles: free scale in both axes
    scaleX = dx / safeDx;
    scaleY = dy / safeDy;
  } else if (isSideH) {
    // East/West handle: X scales, Y = 1
    scaleX = dx / safeDx;
    scaleY = 1;
  } else if (isSideV) {
    // North/South handle: Y scales, X = 1
    scaleY = dy / safeDy;
    scaleX = 1;
  }

  // Raw scales pass through - no dead zone
  // Shapes: Use raw negative scales for immediate flip
  // Strokes: computeUniformScaleNoThreshold() handles flip logic
  return { scaleX, scaleY };
}

// === Frame & Uniform Scale Helpers ===

/**
 * Apply a transform (translate or scale) to a frame tuple.
 * Returns new frame with transform applied.
 * For scale: corners scale around origin, result is normalized (positive w/h).
 */
export function applyTransformToFrame(
  frame: [number, number, number, number],
  transform: TransformForBounds,
): [number, number, number, number] {
  const [x, y, w, h] = frame;

  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return [x + transform.dx, y + transform.dy, w, h];
  }

  if (
    transform.kind === 'scale' &&
    transform.origin &&
    transform.scaleX !== undefined &&
    transform.scaleY !== undefined
  ) {
    const [ox, oy] = transform.origin;
    const { scaleX, scaleY } = transform;

    const newX1 = ox + (x - ox) * scaleX;
    const newY1 = oy + (y - oy) * scaleY;
    const newX2 = ox + (x + w - ox) * scaleX;
    const newY2 = oy + (y + h - oy) * scaleY;

    return [
      Math.min(newX1, newX2),
      Math.min(newY1, newY2),
      Math.abs(newX2 - newX1),
      Math.abs(newY2 - newY1),
    ];
  }

  return frame;
}

/**
 * Apply uniform scale to stroke/polyline points with position preservation.
 *
 * Center-based scaling with "copy-paste" flip behavior:
 * - Position preserves relative arrangement in selection box
 * - Geometry uses absolute magnitude (never inverted/mirrored)
 *
 * @param points - Original polyline points
 * @param bbox - Object bbox tuple [minX, minY, maxX, maxY]
 * @param originBounds - Selection bounds before transform
 * @param origin - Scale origin point
 * @param scaleX - Raw X scale factor
 * @param scaleY - Raw Y scale factor
 * @returns Transformed points and the absScale used (for width scaling)
 */
export function applyUniformScaleToPoints(
  points: [number, number][],
  bbox: [number, number, number, number],
  originBounds: WorldRect,
  origin: [number, number],
  scaleX: number,
  scaleY: number,
): { points: [number, number][]; absScale: number } {
  const [minX, minY, maxX, maxY] = bbox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  const scaledPoints: [number, number][] = points.map(([x, y]) => [
    newCx + (x - cx) * absScale,
    newCy + (y - cy) * absScale,
  ]);

  return { points: scaledPoints, absScale };
}

/**
 * Apply uniform scale to a frame with center-based position preservation.
 * Used for shapes in mixed+corner selection (matches stroke behavior).
 *
 * @param frame - Original frame [x, y, w, h]
 * @param originBounds - Selection bounds before transform
 * @param origin - Scale origin point
 * @param scaleX - Raw X scale factor
 * @param scaleY - Raw Y scale factor
 * @returns Transformed frame [x, y, w, h]
 */
export function applyUniformScaleToFrame(
  frame: [number, number, number, number],
  originBounds: WorldRect,
  origin: [number, number],
  scaleX: number,
  scaleY: number,
): [number, number, number, number] {
  const [x, y, w, h] = frame;
  const cx = x + w / 2;
  const cy = y + h / 2;

  const uniformScale = computeUniformScaleNoThreshold(scaleX, scaleY);
  const absScale = Math.abs(uniformScale);

  const [newCx, newCy] = computePreservedPosition(cx, cy, originBounds, origin, uniformScale);

  const newW = w * absScale;
  const newH = h * absScale;

  return [newCx - newW / 2, newCy - newH / 2, newW, newH];
}

// === Topology Transform Helpers ===

/**
 * Transform a shape frame for connector topology rerouting.
 * Dispatches to uniform or non-uniform scale based on selection context.
 */
export function transformFrameForTopology(
  frame: FrameTuple,
  transform: TranslateTransform | ScaleTransform,
  kind?: ObjectKind,
): FrameTuple {
  if (transform.kind === 'translate') {
    return [frame[0] + transform.dx, frame[1] + transform.dy, frame[2], frame[3]];
  }
  const { origin, scaleX, scaleY, selectionKind, handleKind, handleId, originBounds } = transform;

  // Images: always uniform, except mixed+side = edge-pin translate
  if (kind === 'image') {
    if (selectionKind === 'mixed' && handleKind === 'side') {
      const { dx, dy } = computeEdgePinTranslation(
        frame[0], frame[0] + frame[2], frame[1], frame[1] + frame[3],
        originBounds, scaleX, scaleY, origin, handleId,
      );
      return [frame[0] + dx, frame[1] + dy, frame[2], frame[3]];
    }
    return applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
  }

  // Bookmarks: fixed size — side = edge-pin translate, corner = preserved-position translate
  if (kind === 'bookmark') {
    if (handleKind === 'side') {
      const { dx, dy } = computeEdgePinTranslation(
        frame[0], frame[0] + frame[2], frame[1], frame[1] + frame[3],
        originBounds, scaleX, scaleY, origin, handleId,
      );
      return [frame[0] + dx, frame[1] + dy, frame[2], frame[3]];
    }
    const { dx, dy } = computeBookmarkCornerTranslation(frame, originBounds, scaleX, scaleY, origin);
    return [frame[0] + dx, frame[1] + dy, frame[2], frame[3]];
  }

  if (
    ((selectionKind === 'mixed' || selectionKind === 'textOnly' || selectionKind === 'codeOnly') && handleKind === 'corner')
  ) {
    return applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
  }
  return applyTransformToFrame(frame, { kind: 'scale', origin, scaleX, scaleY });
}

/**
 * Transform a free endpoint position for connector topology rerouting.
 * Uses position preservation for uniform-scaling selection kinds, raw scale otherwise.
 */
export function transformPositionForTopology(
  position: [number, number],
  transform: TranslateTransform | ScaleTransform,
): [number, number] {
  if (transform.kind === 'translate') {
    return [position[0] + transform.dx, position[1] + transform.dy];
  }
  const { origin, scaleX, scaleY, selectionKind, handleKind, originBounds } = transform;
  if (
    selectionKind === 'imagesOnly' || selectionKind === 'bookmarksOnly' ||
    ((selectionKind === 'mixed' || selectionKind === 'textOnly' || selectionKind === 'codeOnly') && handleKind === 'corner')
  ) {
    const u = computeUniformScaleNoThreshold(scaleX, scaleY);
    return computePreservedPosition(position[0], position[1], originBounds, origin, u);
  }
  const [ox, oy] = origin;
  return [ox + (position[0] - ox) * scaleX, oy + (position[1] - oy) * scaleY];
}
