/**
 * Scale Transform Math Utilities
 *
 * Pure functions for computing scale transforms, shared by:
 * - SelectTool.ts (selection scaling)
 * - objects.ts (scale preview rendering)
 */

import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds } from '@avlo/shared';
import { translateBounds, scaleBoundsAround } from '@avlo/shared';
import { isCornerHandle } from '@/stores/selection-store';

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
  uniformScale: number
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
 * Compute translation for a stroke in mixed + side handle scenario.
 * Uses edge-pinning logic:
 * - Anchor strokes (those that define the anchor edge) stay pinned
 * - On scale flip (negative), anchor strokes shift to define the opposite edge
 * - Interior strokes translate proportionally based on origin
 */
export function computeStrokeTranslation(
  handle: ObjectHandleForScale,
  originBounds: WorldRect,
  scaleX: number,
  scaleY: number,
  origin: [number, number],
  handleId: HandleId
): { dx: number; dy: number } {
  // Get stroke geometry (not bbox with width inflation)
  // NOTE: Using raw y.get() here because ObjectHandleForScale has a simplified y interface
  const points = handle.y.get('points') as [number, number][] | undefined;
  if (!points || points.length === 0) return { dx: 0, dy: 0 };

  // Compute geometry bounds
  let minX = points[0][0], maxX = points[0][0];
  let minY = points[0][1], maxY = points[0][1];
  for (const [px, py] of points) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const [ox, oy] = origin;

  const EPS = 1e-3;
  const isHorizontal = handleId === 'e' || handleId === 'w';
  const isVertical = handleId === 'n' || handleId === 's';

  let dx = 0;
  let dy = 0;

  if (isHorizontal) {
    // E handle: anchor at minX (west edge), W handle: anchor at maxX (east edge)
    const anchorX = handleId === 'e' ? originBounds.minX : originBounds.maxX;

    const touchesLeft = Math.abs(minX - anchorX) < EPS;
    const touchesRight = Math.abs(maxX - anchorX) < EPS;
    const isAnchor = touchesLeft || touchesRight;

    if (isAnchor) {
      if (scaleX >= 0) {
        // Pre-flip: pin original touching edge
        const edgeX = touchesLeft ? minX : maxX;
        dx = anchorX - edgeX; // ≈ 0 since edge ≈ anchor
      } else {
        // Post-flip: pin opposite edge (shift by stroke width)
        const edgeX = touchesLeft ? maxX : minX;
        dx = anchorX - edgeX;
      }
      dy = 0;
    } else {
      // Non-anchor stroke: origin-based translation + shift at flip
      const newCx = ox + (cx - ox) * scaleX;
      dx = newCx - cx;
      // At flip (scaleX < 0), shift by half stroke width (OPPOSITE direction of anchor strokes)
      if (scaleX < 0) {
        const halfWidth = (maxX - minX) / 2;
        // W handle: anchor shifts RIGHT, so non-anchor shifts LEFT (-)
        // E handle: anchor shifts LEFT, so non-anchor shifts RIGHT (+)
        dx += handleId === 'w' ? -halfWidth : halfWidth;
      }
      dy = 0;
    }
  } else if (isVertical) {
    // S handle: anchor at minY (top edge), N handle: anchor at maxY (bottom edge)
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
      dx = 0;
    } else {
      // Non-anchor stroke: origin-based translation + shift at flip
      const newCy = oy + (cy - oy) * scaleY;
      dy = newCy - cy;
      // At flip (scaleY < 0), shift by half stroke height (OPPOSITE direction of anchor strokes)
      if (scaleY < 0) {
        const halfHeight = (maxY - minY) / 2;
        // S handle: shift DOWN (+), N handle: shift UP (-)
        dy += handleId === 's' ? halfHeight : -halfHeight;
      }
      dx = 0;
    }
  } else {
    // Corner handle (shouldn't reach here for mixed+side, but fallback)
    const newCx = ox + (cx - ox) * scaleX;
    const newCy = oy + (cy - oy) * scaleY;
    dx = newCx - cx;
    dy = newCy - cy;
  }

  return { dx, dy };
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
  transform: TransformForBounds
): WorldRect {
  if (transform.kind === 'translate' && transform.dx !== undefined && transform.dy !== undefined) {
    return translateBounds(bounds, transform.dx, transform.dy);
  }

  if (transform.kind === 'scale' && transform.origin && transform.scaleX !== undefined && transform.scaleY !== undefined) {
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
  transform: ScaleTransformState
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
  const safeDx = Math.abs(initDx) > MIN_DELTA ? initDx : (initDx >= 0 ? MIN_DELTA : -MIN_DELTA);
  const safeDy = Math.abs(initDy) > MIN_DELTA ? initDy : (initDy >= 0 ? MIN_DELTA : -MIN_DELTA);

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
