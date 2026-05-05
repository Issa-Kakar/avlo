/**
 * Connector Router — local route cache + reverse map for bound connectors.
 *
 * Three private maps:
 *   - shapeToConnectors: shapeId → Set<connectorId>  (only bindable shapes)
 *   - anchorIds: connectorId → [startShapeId | null, endShapeId | null]  (mutated in place)
 *   - routes: connectorId → cached Point[]  (owned references — fresh from routing pipeline)
 *
 * Maintained by `RoomDocManager` deep observer:
 *   - top-level add/delete → registerConnector / removeConnector + removeShape
 *   - direct edits on connector (start/end/connectorType keys) → updateAnchors
 *   - direct edits on bindable shape (frame/origin/etc.) → propagate via getAttached
 *   - shape kind=='shape' shapeType swap → also propagate via getAttached
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
import { getObjects } from '@/runtime/room-runtime';
import { getEnd, getStart } from '../accessors';
import { computeConnectorBBoxFromPoints } from '../geometry/bbox';
import type { BBoxTuple, Point } from '../types/geometry';
import type { ConnectorEndpoint, StoredAnchor } from '../types/objects';
import { rerouteConnectorTransform } from './reroute-connector';

const ZERO_BBOX: BBoxTuple = [0, 0, 0, 0];

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

  // ============================================================
  // Map maintenance — called by RoomDocManager observer
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
   * Reroute from canonical Y.Map state, write to cache, return new bbox.
   * Called by RoomDocManager Phase C for any connector in `rerouteIds`.
   * `rerouteConnectorTransform` reads the Y.Map via `getHandle(id)` internally; the
   * `id` parameter is sufficient for the lookup.
   * On reroute failure (defensive — malformed connector), returns zero bbox and skips
   * the cache write — next observer pass corrects.
   */
  rerouteCanonical(id: string): BBoxTuple {
    const result = rerouteConnectorTransform(id, null, null);
    if (!result) return [0, 0, 0, 0];
    this.routes.set(id, result.points);
    return result.bbox;
  }

  /**
   * Bbox without re-routing — Phase B's connector-style-only branch (color/width/cap
   * change). Reads cached route + style from Y.Map (caller passes the Y.Map for
   * style fields like cap/width/color).
   */
  computeBBox(id: string, y: Y.Map<unknown>): BBoxTuple {
    const route = this.routes.get(id);
    if (!route || route.length < 2) return ZERO_BBOX;
    return computeConnectorBBoxFromPoints(route, y);
  }

  clear(): void {
    this.shapeToConnectors.clear();
    this.anchorIds.clear();
    this.routes.clear();
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
// Module-level access — set on construct, cleared on destroy
// ============================================================

let active: ConnectorRouter | null = null;

export function setActiveConnectorRouter(router: ConnectorRouter | null): void {
  active = router;
}

export function getConnectorRoute(id: string): Point[] | null {
  return active?.getRoute(id) ?? null;
}

export function getAttachedConnectors(shapeId: string): ReadonlySet<string> | undefined {
  return active?.getAttached(shapeId);
}

// ============================================================
// Connector-aware shape-deletion helper
// ============================================================

/**
 * Detach a connector from a shape that's being deleted, replacing the bound endpoint
 * with the cached route's first/last point so the connector remains visible at the
 * last-known position. Caller must run inside a transact() block.
 *
 * If no cached route exists (connector never routed), no-op — caller's choice whether
 * to delete the connector or leave it dangling.
 */
export function detachConnectorFromShape(connectorId: string, shapeId: string): void {
  const y = getObjects().get(connectorId);
  if (!y) return;
  const route = active?.getRoute(connectorId);
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
