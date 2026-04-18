/**
 * Radius — tagged screen-vs-world hit tolerance for the query pipeline.
 *
 * Every hit test is either a screen-pixel tolerance (`{ px }`) that should
 * shrink as the user zooms in, or a world-unit tolerance (`{ world }`) that
 * stays constant in world space (e.g. connector snap radii from config).
 *
 * Callers pass a tagged `Radius` into the query opts; the query layer
 * resolves to world units via the active camera scale. One place owns the
 * `/scale` division instead of every call site.
 */

import { useCameraStore } from '@/stores/camera-store';

export type Radius = { readonly px: number } | { readonly world: number };

/** Resolve a tagged radius to world units. `{ px }` divides by camera scale. */
export function resolveRadius(r: Radius): number {
  if ('world' in r) return r.world;
  const s = Math.max(0.001, useCameraStore.getState().scale);
  return r.px / s;
}
