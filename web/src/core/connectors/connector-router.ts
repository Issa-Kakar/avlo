/**
 * Connector Router — local route cache + reverse map + reroute queue for bound connectors.
 *
 * Three private maps + one queue:
 *   - shapeToConnectors: shapeId → Set<connectorId>  (only bindable shapes)
 *   - anchorIds: connectorId → [startShapeId | null, endShapeId | null]  (mutated in place)
 *   - routes: connectorId → cached Point[]  (owned references — fresh from routing pipeline)
 *   - _rerouteQueue: connectorIds queued for canonical reroute (drained in Phase C)
 *
 * Driven by `RoomDocManager` deep observer via four typed events:
 *   - onConnectorAdded(id, y)              top-level add of a connector
 *   - onObjectDeleted(id)                  top-level delete of any object (connector or shape)
 *   - onConnectorEdited(id, y, startEnd)   start/end/connectorType key change
 *   - onBindableChanged(id)                bindable's bbox or shapeType changed (propagation)
 *
 * Public reads via module-level helpers (set on construct, cleared on destroy):
 *   getConnectorRoute(id)         → Point[] | null
 *   getAttachedConnectors(shapeId) → ReadonlySet<string> | undefined
 *
 * Performance discipline:
 *   - shapeToConnectors Sets allocated on first attach, deleted on last detach
 *   - anchorIds tuples mutated in place after first registration (no per-update alloc)
 *   - routes references stored as-is (routing pipeline already allocates fresh arrays)
 *   - removeConnector / removeShape are unconditional no-ops on unknown ids
 *
 * @module core/connectors/connector-router
 */

import type * as Y from 'yjs';
import { isLockedId, isRemoteLockedId } from '@/core/locks/lock-table';
import { getActiveRoomDoc, getObjects } from '@/runtime/room-runtime';
import { getConnectorType, getEnd, getEndCap, getStart, getStartCap, getWidth } from '../accessors';
import { computeConnectorBBoxFromPointsInto } from '../geometry/bbox';
import type { BBoxTuple, Point } from '../types/geometry';
import type { ConnectorEndpoint, StoredAnchor, StoredStraightAnchor } from '../types/objects';
import { unionConnectorLabelBBoxInto } from './connector-label';
import { bakeCanonicalEndpoint, buildRouteContext, type Pipeline } from './reroute-connector';
import { remapAnchorBetweenShapeTypes } from './shape-geometry';

function endpointShapeId(ep: ConnectorEndpoint | undefined): string | null {
  if (!ep || Array.isArray(ep)) return null;
  return ep.id;
}

export class ConnectorRouter {
  // shapeId → connectorIds attached. Self-loops dedupe inline (single set entry per pair).
  private readonly shapeToConnectors = new Map<string, Set<string>>();
  // connectorId → [startAnchorShapeId | null, endAnchorShapeId | null]. Tuple mutated in place.
  private readonly anchorIds = new Map<string, [string | null, string | null]>();
  // connectorId → cached routed Point[]. Fresh tuples — owned by router.
  private readonly routes = new Map<string, Point[]>();
  // Connector ids queued for canonical reroute. Drained in Phase C.
  private readonly _rerouteQueue = new Set<string>();

  // ============================================================
  // Event API — called by RoomDocManager observer (typed by event, not operation)
  // ============================================================

  /** Connector top-level add: register topology + queue for canonical reroute. */
  onConnectorAdded(id: string, y: Y.Map<unknown>): void {
    this.registerConnector(id, y);
    this._rerouteQueue.add(id);
  }

  /** Object top-level delete (any id, no-op if unknown). Combines the two prior calls. */
  onObjectDeleted(id: string): void {
    this.removeConnector(id);
    this.removeShape(id);
  }

  /** Connector start/end/connectorType key changed. `startEndChanged` controls anchor diff. */
  onConnectorEdited(id: string, y: Y.Map<unknown>, startEndChanged: boolean): void {
    if (startEndChanged) this.updateAnchors(id, y);
    this._rerouteQueue.add(id);
  }

  /** Bindable's bbox or shapeType changed — propagate to attached connectors. No-op if no attachments. */
  onBindableChanged(id: string): void {
    const attached = this.shapeToConnectors.get(id);
    if (!attached) return;
    for (const cid of attached) this._rerouteQueue.add(cid);
  }

  /** Phase B's "is this connector deferred to Phase C?" check. */
  isQueuedForReroute(id: string): boolean {
    return this._rerouteQueue.has(id);
  }

  /** Phase C iterator. Caller MUST exhaust before the next observer fire (Set is reused). */
  *drainRerouteQueue(): IterableIterator<string> {
    for (const id of this._rerouteQueue) yield id;
    this._rerouteQueue.clear();
  }

  // ============================================================
  // Map maintenance — composed by event API above
  // ============================================================

  /** New connector added: snapshot anchorIds + link both sides. */
  registerConnector(id: string, y: Y.Map<unknown>): void {
    const startId = endpointShapeId(getStart(y));
    const endId = endpointShapeId(getEnd(y));
    this.anchorIds.set(id, [startId, endId]);
    if (startId) this.addToShape(startId, id);
    if (endId && endId !== startId) this.addToShape(endId, id);
  }

  /**
   * Connector start/end anchor changed: diff old vs current, swap shape links.
   * Inline dedup with four `!==` checks against fixed slots — no Set allocation.
   */
  updateAnchors(id: string, y: Y.Map<unknown>): void {
    const newStartId = endpointShapeId(getStart(y));
    const newEndId = endpointShapeId(getEnd(y));
    const oldEntry = this.anchorIds.get(id);
    const oldStartId = oldEntry?.[0] ?? null;
    const oldEndId = oldEntry?.[1] ?? null;

    // Dedup: oldA always = oldStartId; oldB = oldEndId only if distinct (self-loop → null).
    const oldA = oldStartId;
    const oldB = oldStartId !== oldEndId ? oldEndId : null;
    const newA = newStartId;
    const newB = newStartId !== newEndId ? newEndId : null;

    if (oldA && oldA !== newA && oldA !== newB) this.removeFromShape(oldA, id);
    if (oldB && oldB !== newA && oldB !== newB) this.removeFromShape(oldB, id);
    if (newA && newA !== oldA && newA !== oldB) this.addToShape(newA, id);
    if (newB && newB !== oldA && newB !== oldB) this.addToShape(newB, id);

    if (oldEntry) {
      oldEntry[0] = newStartId;
      oldEntry[1] = newEndId;
    } else {
      this.anchorIds.set(id, [newStartId, newEndId]);
    }
  }

  /** Connector deleted: unlink from both shapes, drop anchorIds + routes. No-op on unknown id. */
  removeConnector(id: string): void {
    const entry = this.anchorIds.get(id);
    if (entry) {
      const [a, b] = entry;
      if (a) this.removeFromShape(a, id);
      if (b && b !== a) this.removeFromShape(b, id);
      this.anchorIds.delete(id);
    }
    this.routes.delete(id);
  }

  /**
   * Shape deleted: drop the shape→connectors entry. Stale anchorIds entries pointing
   * to a gone shape self-clean (subsequent removeFromShape calls are no-ops; resolver
   * falls back to cached route). No-op on unknown shapeId.
   */
  removeShape(shapeId: string): void {
    this.shapeToConnectors.delete(shapeId);
  }

  // ============================================================
  // Read API
  // ============================================================

  getAttached(shapeId: string): ReadonlySet<string> | undefined {
    return this.shapeToConnectors.get(shapeId);
  }

  getRoute(id: string): Point[] | null {
    return this.routes.get(id) ?? null;
  }

  // ============================================================
  // Reroute + bbox
  // ============================================================

  /**
   * Reroute from canonical Y.Map state. Caller passes `yObj` directly so the
   * router never round-trips through `getHandle(connectorId)` for the connector
   * itself — eliminates the bbox-dummy placeholder pattern in the observer.
   *
   * Bakes both endpoints directly via `bakeCanonicalEndpoint` and routes through
   * the pipeline — no override-decoder cost (canonical reroute never has overrides).
   *
   * Mutates the per-connector pooled buffer in `routes` (length trimmed to count —
   * canonical reroutes are steady-state). Writes the bbox into caller-owned
   * `outBbox`; returns `false` on routing failure (caller decides skip vs. leave-as-is).
   */
  rerouteCanonical(id: string, yObj: Y.Map<unknown>, outBbox: BBoxTuple): boolean {
    const ctx = buildRouteContext(id, yObj);
    if (!ctx) return false;
    const P = ctx.pipeline as Pipeline<unknown>;
    const start = bakeCanonicalEndpoint(P, ctx.start, ctx.cachedRoute, 'start');
    const end = bakeCanonicalEndpoint(P, ctx.end, ctx.cachedRoute, 'end');
    let buf = this.routes.get(id);
    if (!buf) {
      buf = [];
      this.routes.set(id, buf);
    }
    const count = P.routeInto(start, end, ctx.strokeWidth, buf);
    if (count < 2) {
      this.routes.delete(id);
      return false;
    }
    if (buf.length > count) buf.length = count;
    computeConnectorBBoxFromPointsInto(buf, count, ctx.strokeWidth, ctx.startCap, ctx.endCap, outBbox);
    // Bake the label rect (route-midpoint centred) into the published bbox so the
    // dirty rect covers the painted glyphs even after a midpoint-shifting reroute.
    unionConnectorLabelBBoxInto(id, yObj, buf, count, outBbox);
    return true;
  }

  /**
   * Bbox without re-routing — Phase B's connector-style-only branch (color/width/cap
   * change). Writes into `outBbox`. Returns `false` when no cached route exists.
   */
  computeBBox(id: string, y: Y.Map<unknown>, outBbox: BBoxTuple): boolean {
    const route = this.routes.get(id);
    if (!route || route.length < 2) return false;
    computeConnectorBBoxFromPointsInto(route, route.length, getWidth(y, 2), getStartCap(y), getEndCap(y), outBbox);
    // Style-only branch (Phase B) — label content/format edits land here too; union
    // the (possibly just-changed) label rect so add/remove/resize republishes correctly.
    unionConnectorLabelBBoxInto(id, y, route, route.length, outBbox);
    return true;
  }

  clear(): void {
    this.shapeToConnectors.clear();
    this.anchorIds.clear();
    this.routes.clear();
    this._rerouteQueue.clear();
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private addToShape(shapeId: string, connectorId: string): void {
    let set = this.shapeToConnectors.get(shapeId);
    if (!set) {
      set = new Set();
      this.shapeToConnectors.set(shapeId, set);
    }
    set.add(connectorId);
  }

  private removeFromShape(shapeId: string, connectorId: string): void {
    const set = this.shapeToConnectors.get(shapeId);
    if (!set) return;
    set.delete(connectorId);
    if (set.size === 0) this.shapeToConnectors.delete(shapeId);
  }
}

// ============================================================
// Module-level access
// Callers must run inside an active room scope (post-connectRoom, pre-disconnectRoom).
// ============================================================

export function getConnectorRoute(id: string): Point[] | null {
  return getActiveRoomDoc().connectorRouter.getRoute(id);
}

export function getAttachedConnectors(shapeId: string): ReadonlySet<string> | undefined {
  return getActiveRoomDoc().connectorRouter.getAttached(shapeId);
}

// ============================================================
// Connector-aware shape-deletion helper
// ============================================================

/**
 * Detach a connector from a shape that's being deleted, replacing the bound endpoint
 * with the cached route's first/last point so the connector remains visible at the
 * last-known position. Caller must run inside a transact() block.
 * No-op when no cached route exists — corrupted state.
 */
export function detachConnectorFromShape(connectorId: string, shapeId: string): void {
  // A peer holds this connector (mid-endpoint-drag) or it's durably locked — leave its
  // endpoints alone. Degrades to the survivable "peer deleted my anchor shape" case.
  if (isRemoteLockedId(connectorId) || isLockedId(connectorId)) return;
  const y = getObjects().get(connectorId);
  if (!y) return;
  const route = getActiveRoomDoc().connectorRouter.getRoute(connectorId);
  if (!route || route.length < 2) return;
  const start = y.get('start') as ConnectorEndpoint | undefined;
  const end = y.get('end') as ConnectorEndpoint | undefined;
  if (start && !Array.isArray(start) && (start as StoredAnchor).id === shapeId) {
    y.set('start', [route[0][0], route[0][1]]);
  }
  if (end && !Array.isArray(end) && (end as StoredAnchor).id === shapeId) {
    y.set('end', [route[route.length - 1][0], route[route.length - 1][1]]);
  }
}

// ============================================================
// Anchor renormalization on shapeType change
// ============================================================

const ANCHOR_REMAP_EPS = 1e-9; // matches MIDPOINT_EPS; skips identity writes

/**
 * Rewrite one endpoint of `y` if bound to `shapeId`. Fresh record + fresh anchor
 * array (stored records are plain values — never mutated/reused). Skips the write
 * when the remap is identity within eps (cardinal midpoints, center, rect↔roundedRect).
 */
function remapBoundEndpoint(
  y: Y.Map<unknown>,
  key: 'start' | 'end',
  shapeId: string,
  fromShapeType: string,
  toShapeType: string,
  isStraight: boolean,
): void {
  const ep = y.get(key) as ConnectorEndpoint | undefined;
  if (!ep || Array.isArray(ep) || ep.id !== shapeId) return;
  const interior = isStraight && ((ep as StoredStraightAnchor).interior ?? false);
  const next = remapAnchorBetweenShapeTypes(ep.anchor, fromShapeType, toShapeType, interior);
  if (Math.abs(next[0] - ep.anchor[0]) < ANCHOR_REMAP_EPS && Math.abs(next[1] - ep.anchor[1]) < ANCHOR_REMAP_EPS) return;
  y.set(key, isStraight ? { id: shapeId, interior, anchor: next } : { id: shapeId, anchor: next });
}

/**
 * Remap every anchor bound to `shapeId` so its position relative to the shape
 * outline carries over across a shapeType change (center-ray remap — see
 * `remapAnchorBetweenShapeTypes`). Endpoints bound to other shapes and free
 * Points are skipped; self-loops remap both endpoints in one pass.
 *
 * MUST run inside the same `transact()` as the shapeType write, at the call
 * site — never from an observer (observer-driven writes would re-enter routing
 * scratches and make every remote peer remap → write storms). Sharing the
 * transaction means one observer fire: start/end keychanges and the shapeType
 * keychange dedupe into one reroute via `_rerouteQueue`, and undo restores
 * shapeType + anchors as a single step.
 */
export function renormalizeAttachedAnchors(shapeId: string, fromShapeType: string, toShapeType: string): void {
  if (fromShapeType === toShapeType) return;
  const attached = getAttachedConnectors(shapeId);
  if (!attached) return;
  const objects = getObjects();
  for (const connectorId of attached) {
    if (isRemoteLockedId(connectorId) || isLockedId(connectorId)) continue; // peer-held or durably locked — anchors stay put
    const y = objects.get(connectorId);
    if (!y) continue;
    const isStraight = getConnectorType(y) === 'straight';
    remapBoundEndpoint(y, 'start', shapeId, fromShapeType, toShapeType, isStraight);
    remapBoundEndpoint(y, 'end', shapeId, fromShapeType, toShapeType, isStraight);
  }
}
