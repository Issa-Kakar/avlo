/**
 * Anchor ↔ Point Math Atoms
 *
 * Tiny module for anchor interpolation + offset math + endpoint position.
 * No classifiers, no re-derivation: interior-ness is a stored fact (committed
 * at snap time), and elbow sides come directly from the stored anchor. Nothing
 * in here recomputes a direction.
 *
 * @module core/connectors/anchor-atoms
 */

import { getHandle } from '@/runtime/room-runtime';
import { getEnd, getEndAnchor, getStart, getStartAnchor } from '../accessors';
import { frameOf } from '../geometry/frame-of';
import type { FrameTuple, Point } from '../types/geometry';
import type { ObjectHandle, StoredAnchor } from '../types/objects';
import { directionVector } from './connector-utils';
import { EDGE_CLEARANCE_W } from './constants';
import type { Dir, SnapTarget } from './types';

const ZERO_POINT: Point = [0, 0];

/** Raw interpolation of a normalized anchor against a frame — no offset. */
export function anchorFramePoint(anchor: Point, frame: FrameTuple): Point {
  return [frame[0] + anchor[0] * frame[2], frame[1] + anchor[1] * frame[3]];
}

/**
 * Elbow-only: frame point shifted `EDGE_CLEARANCE_W` outward along the given cardinal.
 *
 * `dir` is supplied by the caller (derived at route time via `projectAnchorToEdge`) —
 * cardinal-aligned by design so A* gets axis-aligned escape segments. On stretched
 * diamonds the projected outward normal is non-cardinal, but the offset stays
 * cardinal so the stub stays orthogonal to the routing grid.
 */
export function elbowAnchorPoint(anchor: Point, frame: FrameTuple, dir: Dir): Point {
  const [ax, ay] = anchor;
  const [dx, dy] = directionVector(dir);
  return [frame[0] + ax * frame[2] + dx * EDGE_CLEARANCE_W, frame[1] + ay * frame[3] + dy * EDGE_CLEARANCE_W];
}

/** Same-shape test — both endpoints share a bound shape id. */
export function isSameShape(a: { shapeId?: string } | null | undefined, b: { shapeId?: string } | null | undefined): boolean {
  return !!(a?.shapeId && b?.shapeId && a.shapeId === b.shapeId);
}

/**
 * Build the Y.Map anchor record for a snap target.
 * Elbow stores `{ id, anchor }` — `side` is derived at route time, never persisted.
 * Straight stores `{ id, interior, anchor }` — `interior` is committed at snap time.
 */
export function anchorRecordFromSnap(snap: SnapTarget): StoredAnchor {
  return snap.kind === 'elbow'
    ? { id: snap.shapeId, anchor: snap.normalizedAnchor }
    : { id: snap.shapeId, interior: snap.interior, anchor: snap.normalizedAnchor };
}

/**
 * The on-edge (or interior) world position for a connector endpoint — no clearance offset.
 * Anchored: interpolate stored normalized anchor against current shape frame.
 * Free: return stored position as-is. Used by hit testing and endpoint-dot rendering.
 */
export function getEndpointEdgePosition(handle: ObjectHandle, endpoint: 'start' | 'end'): Point {
  const yMap = handle.y;
  const storedPos = endpoint === 'start' ? getStart(yMap) : getEnd(yMap);
  const anchor = endpoint === 'start' ? getStartAnchor(yMap) : getEndAnchor(yMap);
  if (!anchor) return storedPos ?? ZERO_POINT;
  const frame = frameOf(getHandle(anchor.id));
  if (!frame) return storedPos ?? ZERO_POINT;
  return anchorFramePoint(anchor.anchor, frame);
}
