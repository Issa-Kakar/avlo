/**
 * Anchor ↔ Point Math Atoms
 *
 * Tiny module for anchor interpolation + offset math. The old `sideFromAnchor`
 * classifier and shape-agnostic `isAnchorInterior` are gone — interior-ness is
 * a stored fact (committed at snap time), and elbow sides come directly from
 * the stored anchor. Nothing in here recomputes a direction anymore.
 *
 * @module core/connectors/anchor-atoms
 */
import type { FrameTuple, Point } from '../types/geometry';
import type { SnapTarget, StoredAnchor, StoredElbowAnchor } from './types';
import { EDGE_CLEARANCE_W } from './constants';
import { directionVector } from './connector-utils';

/** Raw interpolation of a normalized anchor against a frame — no offset. */
export function anchorFramePoint(anchor: Point, frame: FrameTuple): Point {
  return [frame[0] + anchor[0] * frame[2], frame[1] + anchor[1] * frame[3]];
}

/**
 * Elbow-only: frame point shifted `EDGE_CLEARANCE_W` outward along the stored side.
 * Callers pass the stored `StoredElbowAnchor` directly — side is authoritative, never re-derived.
 */
export function elbowAnchorPoint(anchor: StoredElbowAnchor, frame: FrameTuple): Point {
  const [px, py] = anchorFramePoint(anchor.anchor, frame);
  const [dx, dy] = directionVector(anchor.side);
  return [px + dx * EDGE_CLEARANCE_W, py + dy * EDGE_CLEARANCE_W];
}

/** Same-shape test — both endpoints share a bound shape id. */
export function isSameShape(a: { shapeId?: string } | null | undefined, b: { shapeId?: string } | null | undefined): boolean {
  return !!(a?.shapeId && b?.shapeId && a.shapeId === b.shapeId);
}

/**
 * Build the Y.Map anchor record for a snap target.
 * Shape matches connector type: elbow stores `side`, straight stores `interior`.
 */
export function anchorRecordFromSnap(snap: SnapTarget): StoredAnchor {
  return snap.kind === 'elbow'
    ? { id: snap.shapeId, side: snap.side, anchor: snap.normalizedAnchor }
    : { id: snap.shapeId, interior: snap.interior, anchor: snap.normalizedAnchor };
}
