/**
 * Anchor ↔ Point Math Atoms
 *
 * Single home for normalized-anchor interpolation, offset application, and
 * side derivation. Every consumer that used to read `anchor.side` directly
 * now goes through `sideFromAnchor` here — when `side` is eventually removed
 * from `StoredAnchor`, this file is the only math module that needs to care.
 *
 * @module core/connectors/anchor-atoms
 */

import type { FrameTuple, Point } from '../types/geometry';
import type { Dir } from './types';
import { isAnchorInterior } from './types';
import { EDGE_CLEARANCE_W } from './constants';
import { directionVector, getShapeTypeMidpoints } from './connector-utils';

/** Raw interpolation of a normalized anchor against a frame — no offset. */
export function anchorFramePoint(anchor: Point, frame: FrameTuple): Point {
  return [frame[0] + anchor[0] * frame[2], frame[1] + anchor[1] * frame[3]];
}

/**
 * Derive the cardinal side a normalized anchor logically sits on.
 *
 * - Edge anchors (one coord at 0 or 1) map trivially.
 * - Interior anchors map to the nearest visual midpoint — shape-type aware
 *   so diamond / ellipse frames resolve correctly via `getShapeTypeMidpoints`.
 */
export function sideFromAnchor(anchor: Point, frame: FrameTuple, shapeType: string): Dir {
  const [nx, ny] = anchor;
  if (!isAnchorInterior(anchor)) {
    if (nx <= 1e-6) return 'W';
    if (nx >= 1 - 1e-6) return 'E';
    if (ny <= 1e-6) return 'N';
    return 'S';
  }
  const px = frame[0] + nx * frame[2];
  const py = frame[1] + ny * frame[3];
  const midpoints = getShapeTypeMidpoints(frame, shapeType);
  let bestSide: Dir = 'N';
  let bestDistSq = Infinity;
  for (const s of ['N', 'E', 'S', 'W'] as const) {
    const [mx, my] = midpoints[s];
    const dx = px - mx;
    const dy = py - my;
    const d = dx * dx + dy * dy;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestSide = s;
    }
  }
  return bestSide;
}

/**
 * Interpolate anchor + apply `EDGE_CLEARANCE_W` outward offset.
 *
 * Replaces the legacy `applyAnchorToFrame` — derives side internally so the
 * future `StoredAnchor.side` removal becomes a zero-touch change at call sites.
 * Interior anchors skip the offset (used by straight connector routing).
 */
export function anchorOffsetPoint(anchor: Point, frame: FrameTuple, shapeType: string): Point {
  const posX = frame[0] + anchor[0] * frame[2];
  const posY = frame[1] + anchor[1] * frame[3];
  if (isAnchorInterior(anchor)) return [posX, posY];
  const [dx, dy] = directionVector(sideFromAnchor(anchor, frame, shapeType));
  return [posX + dx * EDGE_CLEARANCE_W, posY + dy * EDGE_CLEARANCE_W];
}

/** Same-shape test — both endpoints share a bound shape id. */
export function isSameShape(a: { shapeId?: string } | null | undefined, b: { shapeId?: string } | null | undefined): boolean {
  return !!(a?.shapeId && b?.shapeId && a.shapeId === b.shapeId);
}
