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
 *
 * Connector route + reverse-map state lives in `ConnectorRouter` owned by RoomDocManager.
 * Cleared via `connectorRouter.clear()` in `destroy()`, not from here.
 */

import { bookmarkCache } from '@/core/bookmark/bookmark-render';
import { codeSystem } from '@/core/code/code-system';
import { textLayoutCache } from '@/core/text/text-system';
import type { ObjectKind } from '@/core/types/objects';
import { clearGeometry, evictGeometry } from './geometry-cache';

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
}
