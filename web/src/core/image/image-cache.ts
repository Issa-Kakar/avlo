/**
 * Image asset-metadata cache — the image subsystem's per-object-id cache,
 * parallel to bookmarkCache / codeSystem / textLayoutCache.
 *
 * Holds the immutable asset digest (assetId + natural dims). Populated
 * insert-only by the computeBBoxForInto dispatch (bbox.ts case 'image');
 * evicted by removeObjectCaches; cleared by clearAllObjectCaches. Read by
 * the renderer (drawImage) and image-manager (viewport mark + hydrate).
 */
import type * as Y from 'yjs';
import { getImageProps } from '../accessors';

export interface ImageMetaEntry {
  assetId: string;
  nw: number;
  nh: number;
}

const imageMeta = new Map<string, ImageMetaEntry>();

/** Insert-only populate. assetId + natural dims are immutable post-creation,
 *  so first compute wins and every later touch is a single Map.has. */
export function ensureImageMeta(id: string, yMap: Y.Map<unknown>): void {
  if (imageMeta.has(id)) return;
  const props = getImageProps(yMap);
  if (!props) return;
  imageMeta.set(id, { assetId: props.assetId, nw: props.naturalWidth, nh: props.naturalHeight });
}

/** Per-id read — renderer hot path + image-manager per-frame mark. */
export function getImageMeta(id: string): ImageMetaEntry | null {
  return imageMeta.get(id) ?? null;
}

/** Cold-path iteration — image-manager hydrate + bitmap-region fallback. */
export function forEachImageMeta(fn: (id: string, meta: ImageMetaEntry) => void): void {
  for (const [id, meta] of imageMeta) fn(id, meta);
}

/** Eviction surface for renderer/object-cache.ts (mirrors bookmarkCache). */
export const imageCache = {
  evict(id: string): void {
    imageMeta.delete(id);
  },
  clear(): void {
    imageMeta.clear();
  },
};
