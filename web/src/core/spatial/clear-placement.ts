/**
 * Clear-spot search — the collision-avoidance core behind connector-flow's
 * sibling placement and the py-figure auto-placement. Slides a probe frame
 * along one axis until it clears every bindable in the spatial index.
 */

import { setBBoxXYWH } from '@/core/geometry/bounds';
import type { BBoxTuple, FrameTuple } from '@/core/types/geometry';
import { isBindableKind } from '@/core/types/objects';
import { getSpatialIndex } from '@/runtime/room-runtime';

// Module scratches for the clear-spot search — written + read synchronously.
const _spotFrame: FrameTuple = [0, 0, 0, 0];
const _spotBbox: BBoxTuple = [0, 0, 0, 0];

/**
 * Slide a placement frame along the perpendicular axis from `startC` until it
 * clears every bindable, stepping just past each blocker's edge (+ `gap`).
 * `base` fixes the along-axis position + extents; only `base[pIdx]` moves.
 * Returns the cleared perpendicular centre, or `null` once `c` runs past `limit`.
 */
export function slideClear(
  base: FrameTuple,
  pIdx: number,
  half: number,
  gap: number,
  dir: number,
  startC: number,
  limit: number,
): number | null {
  let c = startC;
  for (let guard = 0; guard < 64; guard++) {
    if (dir > 0 ? c > limit : c < limit) return null;
    _spotFrame[0] = base[0];
    _spotFrame[1] = base[1];
    _spotFrame[2] = base[2];
    _spotFrame[3] = base[3];
    _spotFrame[pIdx] = c - half;
    setBBoxXYWH(_spotBbox, _spotFrame[0], _spotFrame[1], _spotFrame[2], _spotFrame[3]);
    const hits = getSpatialIndex().queryBBox(_spotBbox);
    let blocked = false;
    let next = c;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!isBindableKind(h.kind)) continue;
      blocked = true;
      // Centre that puts the probe's near edge `gap` past this blocker's edge.
      const past = dir > 0 ? (pIdx === 0 ? h.maxX : h.maxY) + gap + half : (pIdx === 0 ? h.minX : h.minY) - gap - half;
      if (dir > 0 ? past > next : past < next) next = past;
    }
    if (!blocked) return c;
    c = next;
  }
  return null;
}
