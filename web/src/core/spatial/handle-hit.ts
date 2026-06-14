/**
 * Handle hit testing — non-spatial sibling layer.
 *
 * Resize handles and connector endpoint dots are tiny, transient, and derived
 * from selection state — they don't live in the spatial index. Same `Radius`
 * vocabulary, no spatial index, no paint logic.
 *
 * Scale conversion is owned inside via tagged `Radius` — no call site does
 * its own `/scale`.
 */

import { getEndpointEdgePosition } from '@/core/connectors/anchor-atoms';
import { SLOT_END, SLOT_START, type Slot } from '@/core/connectors/reroute-connector';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { getHandle } from '@/runtime/room-runtime';
import { useCameraStore } from '@/stores/camera-store';
import type { HandleId } from '@/tools/types';
import { resolveRadius } from './object-query';

// ============================================================================
// Resize handles (bespoke — side handles are edge strips, not midpoints)
// ============================================================================

/** Screen-space hit radius for resize handles */
export const HANDLE_HIT_PX = 10;

/**
 * Min bbox size (in screen px) below which handles are hidden + non-hittable.
 * Equals the visual handle diameter (`HANDLE_RADIUS_PX = 6` × 2 in handle-stamp.ts) —
 * handles physically overlap below this.
 */
export const HANDLE_MIN_BBOX_PX = 12;

/**
 * Single gate for handle visibility/hit-testing/cursor. Compares the bbox's larger
 * screen-space dimension against `HANDLE_MIN_BBOX_PX` — handles vanish only when the
 * corner stamps would physically meet. Using `Math.max` keeps handles available on
 * ultra-thin geometry (e.g. a 5wu-wide tall shape) and prevents premature hiding on
 * zoom-out.
 */
export function shouldShowHandles(bbox: BBoxTuple, scale?: number): boolean {
  const s = scale ?? useCameraStore.getState().scale;
  const w = (bbox[2] - bbox[0]) * s;
  const h = (bbox[3] - bbox[1]) * s;
  return Math.max(w, h) >= HANDLE_MIN_BBOX_PX;
}

/**
 * Resize-handle hit test. Corner-tie order (NW first, then NE/SE/SW) is preserved
 * — matches pre-refactor first-match semantics for zero-size bbox edge cases.
 * Side handles are edge strips (hit anywhere along the edge, not just the midpoint).
 */
export function hitResizeHandle(at: Point, bbox: BBoxTuple): HandleId | null {
  if (!shouldShowHandles(bbox)) return null;
  const handleRadius = resolveRadius({ px: HANDLE_HIT_PX });
  const r2 = handleRadius * handleRadius;
  const wx = at[0];
  const wy = at[1];
  const x0 = bbox[0];
  const y0 = bbox[1];
  const x2 = bbox[2];
  const y2 = bbox[3];

  const dxL = wx - x0;
  const dxR = wx - x2;
  const dyT = wy - y0;
  const dyB = wy - y2;
  if (dxL * dxL + dyT * dyT <= r2) return 'nw';
  if (dxR * dxR + dyT * dyT <= r2) return 'ne';
  if (dxR * dxR + dyB * dyB <= r2) return 'se';
  if (dxL * dxL + dyB * dyB <= r2) return 'sw';

  const edgeTolerance = handleRadius;
  if (Math.abs(wy - y0) <= edgeTolerance && wx > x0 + handleRadius && wx < x2 - handleRadius) return 'n';
  if (Math.abs(wy - y2) <= edgeTolerance && wx > x0 + handleRadius && wx < x2 - handleRadius) return 's';
  if (Math.abs(wx - x0) <= edgeTolerance && wy > y0 + handleRadius && wy < y2 - handleRadius) return 'w';
  if (Math.abs(wx - x2) <= edgeTolerance && wy > y0 + handleRadius && wy < y2 - handleRadius) return 'e';

  return null;
}

// ============================================================================
// Connector endpoint dots
// ============================================================================

/** Screen-space hit radius for connector endpoint dots */
export const ENDPOINT_DOT_HIT_PX = 10;

export interface EndpointHit {
  connectorId: string;
  slot: Slot;
}

/**
 * Nearest connector endpoint dot within screen-space radius. Two slots per
 * connector are unrolled for monomorphism; corner-tie order matches the
 * pre-refactor generator (walks `selectedIds` order, end-after-start within
 * each connector).
 *
 * Allocation: zero per probed connector; one terminal `EndpointHit` per hit
 * (returns `null` on miss).
 *
 * `getEndpointEdgePosition` still allocates a `Point` tuple per call — an
 * `*Into(out)` variant in `core/connectors/anchor-atoms.ts` would close the
 * last per-pointermove alloc on this path (out of scope here).
 */
export function hitEndpointDot(at: Point, selectedIds: readonly string[]): EndpointHit | null {
  const r = resolveRadius({ px: ENDPOINT_DOT_HIT_PX });
  const r2 = r * r;
  const px = at[0];
  const py = at[1];
  let bestD2 = Infinity;
  let bestId: string | null = null;
  let bestSlot: Slot = SLOT_START;

  for (const id of selectedIds) {
    const h = getHandle(id);
    if (!h || h.kind !== 'connector') continue;
    const startPos = getEndpointEdgePosition(h, 'start');
    let dx = px - startPos[0];
    let dy = py - startPos[1];
    let d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      bestD2 = d2;
      bestId = id;
      bestSlot = SLOT_START;
    }

    const endPos = getEndpointEdgePosition(h, 'end');
    dx = px - endPos[0];
    dy = py - endPos[1];
    d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      bestD2 = d2;
      bestId = id;
      bestSlot = SLOT_END;
    }
  }

  return bestId === null ? null : { connectorId: bestId, slot: bestSlot };
}
