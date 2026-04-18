/**
 * Handle hit testing — non-spatial sibling layer.
 *
 * Resize handles and connector endpoint dots are tiny, transient, and derived
 * from selection state — they don't live in the spatial index. But the mental
 * model ("find the nearest probe within a radius") matches the spatial
 * pipeline, so we keep the same vocabulary here without touching the spatial
 * index.
 *
 * Scale conversion is owned inside via tagged `Radius` — no call site does
 * its own `/scale`.
 */

import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { HandleId } from '@/tools/types';
import { computeHandles } from '@/stores/selection-store';
import { getHandle } from '@/runtime/room-runtime';
import { getEndpointEdgePosition } from '@/core/connectors/connector-utils';
import { type Radius, resolveRadius } from './radius';

// ============================================================================
// Generic point-probe nearest lookup
// ============================================================================

export interface HandleProbe<T> {
  readonly center: Point;
  readonly value: T;
}

/**
 * Find the nearest probe within `radius` of `at`. Returns the probe's value,
 * or `null` if no probe is in range. Squared-distance comparison — no
 * `Math.hypot` per probe.
 */
export function hitNearest<T>(opts: { at: Point; radius: Radius; probes: Iterable<HandleProbe<T>> }): T | null {
  const r = resolveRadius(opts.radius);
  const r2 = r * r;
  const [px, py] = opts.at;
  let bestDist2 = Infinity;
  let best: T | null = null;
  for (const probe of opts.probes) {
    const dx = px - probe.center[0];
    const dy = py - probe.center[1];
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestDist2) {
      bestDist2 = d2;
      best = probe.value;
    }
  }
  return best;
}

// ============================================================================
// Resize handles (bespoke — side handles are edge strips, not midpoints)
// ============================================================================

/** Screen-space hit radius for resize handles */
export const HANDLE_HIT_PX = 10;

/**
 * Resize-handle hit test. Kept bespoke: corners are point-probes but the
 * N/S/E/W side handles are edge strips (hit anywhere along the edge, not just
 * the midpoint). A pure `hitNearest` circle probe would be harder to grab.
 */
export function hitResizeHandle(at: Point, bbox: BBoxTuple): HandleId | null {
  const handleRadius = resolveRadius({ px: HANDLE_HIT_PX });
  const [worldX, worldY] = at;
  const corners = computeHandles(bbox);

  for (const h of corners) {
    const dx = worldX - h.x;
    const dy = worldY - h.y;
    if (dx * dx + dy * dy <= handleRadius * handleRadius) {
      return h.id;
    }
  }

  const edgeTolerance = handleRadius;

  if (Math.abs(worldY - bbox[1]) <= edgeTolerance && worldX > bbox[0] + handleRadius && worldX < bbox[2] - handleRadius) {
    return 'n';
  }
  if (Math.abs(worldY - bbox[3]) <= edgeTolerance && worldX > bbox[0] + handleRadius && worldX < bbox[2] - handleRadius) {
    return 's';
  }
  if (Math.abs(worldX - bbox[0]) <= edgeTolerance && worldY > bbox[1] + handleRadius && worldY < bbox[3] - handleRadius) {
    return 'w';
  }
  if (Math.abs(worldX - bbox[2]) <= edgeTolerance && worldY > bbox[1] + handleRadius && worldY < bbox[3] - handleRadius) {
    return 'e';
  }

  return null;
}

// ============================================================================
// Connector endpoint dots (hitNearest + generator)
// ============================================================================

/** Screen-space hit radius for connector endpoint dots */
export const ENDPOINT_DOT_HIT_PX = 10;

export interface EndpointHit {
  connectorId: string;
  endpoint: 'start' | 'end';
}

function* iterEndpointDotProbes(selectedIds: readonly string[]): Generator<HandleProbe<EndpointHit>> {
  for (const id of selectedIds) {
    const handle = getHandle(id);
    if (!handle || handle.kind !== 'connector') continue;
    yield { center: getEndpointEdgePosition(handle, 'start'), value: { connectorId: id, endpoint: 'start' } };
    yield { center: getEndpointEdgePosition(handle, 'end'), value: { connectorId: id, endpoint: 'end' } };
  }
}

/** Nearest connector endpoint dot within screen-space radius. */
export function hitEndpointDot(at: Point, selectedIds: readonly string[]): EndpointHit | null {
  return hitNearest({ at, radius: { px: ENDPOINT_DOT_HIT_PX }, probes: iterEndpointDotProbes(selectedIds) });
}
