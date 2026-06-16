/**
 * Bookmark side-effecting actions — URL navigation, future re-unfurl, etc.
 *
 * Separate from `bookmark-render.ts` (paint), `bookmark-unfurl.ts` (lifecycle),
 * and `bookmark-placeholder.ts` (DOM placeholders). Mirrors `image-actions.ts`.
 */

import { isValidHttpUrl, normalizeUrl } from '@avlo/shared';
import { getBookmarkProps } from '@/core/accessors';
import { getHandle } from '@/runtime/room-runtime';

/**
 * Open a bookmark's URL in a new tab. Two-pass scheme validation:
 *   1. `isValidHttpUrl` — cheap predicate, gates http:/https: only.
 *   2. `normalizeUrl` — re-parses via the URL constructor, re-applies the
 *      protocol gate AND the private-hostname gate. Belt-and-suspenders against
 *      any field-level tampering between unfurl and now.
 *
 * `'noopener,noreferrer'` isolates the new window's JS context (no opener
 * back-channel — defends against window.opener tabnabbing) and strips the
 * Referer header. Required for untrusted user-provided URLs.
 *
 * Invoked synchronously from a pointerup handler → browser popup blockers
 * preserve the user-gesture chain and won't block.
 */
export function openBookmarkUrl(id: string): void {
  const handle = getHandle(id);
  if (handle?.kind !== 'bookmark') return;
  const props = getBookmarkProps(handle.y);
  if (!props) return;
  const url = props.url;
  if (typeof url !== 'string' || !url || !isValidHttpUrl(url)) return;
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  window.open(normalized, '_blank', 'noopener,noreferrer');
}
