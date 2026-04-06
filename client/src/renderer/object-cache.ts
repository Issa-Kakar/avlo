/**
 * Object Cache — unified dispatcher for all per-object-id caches.
 *
 * Two operations:
 * - removeObjectCaches(id, kind): Object DELETED → evict geometry + kind-specific layout cache
 * - clearAllObjectCaches(): Room teardown → clear everything
 *
 * For update-path geometry eviction (bbox changed), use evictGeometry(id) from geometry-cache.ts directly.
 *
 * Kind-to-cache mapping:
 *   stroke, shape, connector → geometry cache (Path2D / ConnectorPaths)
 *   text, shape, note       → text layout cache (shape labels use text cache too)
 *   code                    → code system cache
 *   bookmark                → bookmark layout cache
 *   image                   → no per-id cache (managed by image-manager)
 */

import type { ObjectKind } from '@/types/objects';
import { evictGeometry, clearGeometry } from './geometry-cache';
import { textLayoutCache } from '@/lib/text/text-system';
import { codeSystem } from '@/lib/code/code-system';
import { bookmarkCache } from '@/lib/bookmark/bookmark-render';
import { clearConnectorLookup } from '@/lib/connectors';

/** Object deleted — remove from all relevant caches */
export function removeObjectCaches(id: string, kind: ObjectKind): void {
  evictGeometry(id);
  switch (kind) {
    case 'text':
    case 'shape':
    case 'note':
      textLayoutCache.evict(id);
      break;
    case 'code':
      codeSystem.evict(id);
      break;
    case 'bookmark':
      bookmarkCache.evict(id);
      break;
  }
}

/** Clear all object-id-keyed caches (room teardown / hydration) */
export function clearAllObjectCaches(): void {
  clearGeometry();
  textLayoutCache.clear();
  codeSystem.clear();
  bookmarkCache.clear();
  clearConnectorLookup();
}
