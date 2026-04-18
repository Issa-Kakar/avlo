/**
 * Region — tagged discriminated union for spatial query inputs.
 *
 * Two shapes share the same query pipeline:
 *   - point + radius: probes around a cursor (clicks, snap, eraser)
 *   - rect (bbox):    overlap queries (marquee, region membership)
 *
 * The discriminant lets the scanner dispatch without `'in' in region` checks,
 * and is extensible (`'circle'` etc.) without breaking exhaustive switches.
 *
 * Point regions store world-unit `r`; `atPoint` accepts a tagged `Radius`
 * and does the scale conversion once at construction. No caller does `/scale`
 * inline.
 */

import type { BBoxTuple, Point } from '@/core/types/geometry';
import { type Radius, resolveRadius } from './radius';

export type Region =
  | { readonly kind: 'point'; readonly p: Point; readonly r: number }
  | { readonly kind: 'rect'; readonly bbox: BBoxTuple };

export const atPoint = (p: Point, radius: Radius): Region => ({ kind: 'point', p, r: resolveRadius(radius) });

export const inBBox = (bbox: BBoxTuple): Region => ({ kind: 'rect', bbox });

/** Extract the spatial-index query envelope from any region. */
export function regionEnvelope(region: Region): BBoxTuple {
  if (region.kind === 'rect') return region.bbox;
  const [x, y] = region.p;
  return [x - region.r, y - region.r, x + region.r, y + region.r];
}
