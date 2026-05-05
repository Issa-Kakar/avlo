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
import { getEnd, getStart } from '../accessors';
import { frameOf } from '../geometry/frame-of';
import type { FrameTuple, Point } from '../types/geometry';
import type { ConnectorEndpoint, ObjectHandle, StoredAnchor } from '../types/objects';
import { getConnectorRoute } from './connector-router';
import { directionVector } from './connector-utils';
import { EDGE_CLEARANCE_W } from './constants';
import { fillAnchorPoint } from './shape-geometry';
import type { Dir, SnapTarget } from './types';

const ZERO_POINT: Point = [0, 0];

/** Raw interpolation of a normalized anchor against a frame — no offset. Allocates. */
export function anchorFramePoint(anchor: Point, frame: FrameTuple): Point {
  const out: Point = [0, 0];
  fillAnchorPoint(anchor, frame, out);
  return out;
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
  const v = directionVector(dir);
  const out: Point = [0, 0];
  fillAnchorPoint(anchor, frame, out);
  out[0] += v[0] * EDGE_CLEARANCE_W;
  out[1] += v[1] * EDGE_CLEARANCE_W;
  return out;
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
 *
 * The route/zero fallbacks at the end are defensive: if a bound anchor's target frame
 * is missing, the doc is in a corrupted state (deletion didn't detach). We keep rendering
 * at the last-known position rather than asserting.
 */
export function getEndpointEdgePosition(handle: ObjectHandle, endpoint: 'start' | 'end'): Point {
  const ep: ConnectorEndpoint | undefined = endpoint === 'start' ? getStart(handle.y) : getEnd(handle.y);
  if (!ep) return ZERO_POINT;
  if (Array.isArray(ep)) return ep;
  // ep is StoredAnchor — try frame, then fall back to cached route.
  const frame = frameOf(getHandle((ep as StoredAnchor).id));
  if (frame) return anchorFramePoint(ep.anchor, frame);
  const route = getConnectorRoute(handle.id);
  if (route && route.length > 0) {
    const pt = endpoint === 'start' ? route[0] : route[route.length - 1];
    return [pt[0], pt[1]];
  }
  return ZERO_POINT;
}
