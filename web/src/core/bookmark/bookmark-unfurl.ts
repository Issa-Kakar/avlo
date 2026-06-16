/**
 * Bookmark Unfurl Coordinator v2 — single atomic transaction design.
 *
 * No Y.Doc write until unfurl completes (online) or first failure (offline).
 * Loading state is local-only via HTML placeholder.
 */

import { extractDomain, generateZAtTop } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getHandle, getObjects, getZOrder, hasActiveRoom, transact } from '@/runtime/room-runtime';
import { getCurrentTool } from '@/runtime/tool-registry';
import { getUserId } from '@/stores/auth-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { pasteUrlAsText } from '../clipboard/clipboard-actions';
import { rasterizeSvg } from '../image/image-actions';
import { ingest, postToPrimary } from '../image/image-manager';
import { createPlaceholder, removeAllPlaceholders, removePlaceholder } from './bookmark-placeholder';
import { BOOKMARK_WIDTH, bookmarkCache, computeBookmarkHeight } from './bookmark-render';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingBookmark {
  url: string;
  domain: string;
  worldX: number;
  worldY: number;
  objectId: string;
}

export interface UnfurlResultData {
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  faviconAssetId?: string;
  faviconSvgBase64?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

/**
 * Resolve favicon to a raster assetId. SVG branch rasterizes on main thread
 * via the existing `rasterizeSvg` pipeline, then ingests the PNG (which
 * uploads to R2 and decodes to a bitmap). Returns undefined on failure —
 * bookmark still renders without a favicon.
 */
async function resolveFaviconAssetId(data: UnfurlResultData): Promise<string | undefined> {
  if (data.faviconAssetId) return data.faviconAssetId;
  if (!data.faviconSvgBase64) return undefined;
  try {
    const svgBlob = new Blob([base64ToBuffer(data.faviconSvgBase64)], { type: 'image/svg+xml' });
    const pngBlob = await rasterizeSvg(svgBlob);
    const result = await ingest(pngBlob);
    return result.assetId;
  } catch (err) {
    console.warn('[bookmark] svg favicon rasterize failed:', err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pendingBookmarks = new Map<string, PendingBookmark>();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function canCreateBookmark(): boolean {
  return navigator.onLine;
}

/**
 * Begin unfurl flow: show HTML placeholder, send to worker, select object.
 * Returns pre-generated objectId.
 */
export function beginUnfurl(url: string, worldX: number, worldY: number): string {
  const objectId = ulid();
  const domain = extractDomain(url);

  console.warn('[bookmark] beginUnfurl:', url, objectId);
  pendingBookmarks.set(objectId, {
    url,
    domain,
    worldX,
    worldY,
    objectId,
  });

  // Center placeholder on paste point
  const placeholderX = worldX - BOOKMARK_WIDTH / 2;
  const placeholderY = worldY - 28; // half of placeholder height
  createPlaceholder(objectId, domain, placeholderX, placeholderY);

  // Send unfurl command to worker
  postToPrimary({ type: 'unfurl', objectId, url });

  return objectId;
}

/**
 * Worker callback: unfurl succeeded. Write bookmark to Y.Doc atomically.
 *
 * SVG favicons are rasterized + ingested before the transact so the Y.Doc
 * write stays a single atomic transaction containing only a raster assetId.
 */
export async function handleUnfurlResult(objectId: string, data: UnfurlResultData): Promise<void> {
  if (!hasActiveRoom()) return;

  const pending = pendingBookmarks.get(objectId);

  if (pending) {
    // Check if unfurl returned useful data
    const hasSubstance = !!(data.title || data.ogImageAssetId);
    if (!hasSubstance) {
      console.warn('[bookmark] empty unfurl result → text fallback:', objectId);
      pasteUrlAsText(pending.url, pending.worldX, pending.worldY, objectId);
      removePlaceholder(objectId);
      pendingBookmarks.delete(objectId);
      return;
    }

    const faviconAssetId = await resolveFaviconAssetId(data);

    // Async work may have torn down the room; bail before mutating Y.Doc.
    if (!hasActiveRoom() || !pendingBookmarks.has(objectId)) return;

    // Online happy path — single atomic transaction with ALL fields
    console.warn('[bookmark] unfurl success:', objectId, {
      title: !!data.title,
      ogImage: !!data.ogImageAssetId,
      favicon: !!faviconAssetId,
    });
    const height = computeBookmarkHeight(data);
    const origin: [number, number] = [pending.worldX - BOOKMARK_WIDTH / 2, pending.worldY - height / 2];
    const userId = getUserId();

    transact(() => {
      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'bookmark');
      yObj.set('url', pending.url);
      yObj.set('domain', pending.domain);
      yObj.set('origin', origin);
      yObj.set('height', height);
      if (data.title != null) yObj.set('title', data.title);
      if (data.description != null) yObj.set('description', data.description);
      if (data.ogImageAssetId) yObj.set('ogImageAssetId', data.ogImageAssetId);
      if (data.ogImageWidth != null) yObj.set('ogImageWidth', data.ogImageWidth);
      if (data.ogImageHeight != null) yObj.set('ogImageHeight', data.ogImageHeight);
      if (faviconAssetId) yObj.set('faviconAssetId', faviconAssetId);
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());
      yObj.set('z', generateZAtTop(getZOrder().maxZ()));
      getObjects().set(objectId, yObj);
    });

    removePlaceholder(objectId);
    pendingBookmarks.delete(objectId);

    // Select the newly created bookmark (object now exists in Y.Doc)
    if (!getCurrentTool()?.isActive()) {
      useDeviceUIStore.getState().setActiveTool('select');
      useSelectionStore.getState().setSelection([objectId]);
      invalidateOverlay();
    }
    return;
  }

  // Case C: page refresh recovery — no pending map entry
  try {
    const handle = getHandle(objectId);
    if (handle?.kind !== 'bookmark') return;

    const faviconAssetId = await resolveFaviconAssetId(data);
    if (!hasActiveRoom()) return;

    // Evict the stale layout BEFORE the transact: this upgrade mutates
    // title/og/favicon/height, but the layout cache is otherwise insert-only —
    // clearing the slot lets the transaction's observer fire rebuild it fresh.
    bookmarkCache.evict(objectId);

    // Upgrade existing bookmark with metadata
    transact(() => {
      const yObj = getObjects().get(objectId);
      if (yObj?.get('kind') !== 'bookmark') return;

      if (data.title != null) yObj.set('title', data.title);
      if (data.description != null) yObj.set('description', data.description);
      if (data.ogImageAssetId) yObj.set('ogImageAssetId', data.ogImageAssetId);
      if (data.ogImageWidth != null) yObj.set('ogImageWidth', data.ogImageWidth);
      if (data.ogImageHeight != null) yObj.set('ogImageHeight', data.ogImageHeight);
      if (faviconAssetId) yObj.set('faviconAssetId', faviconAssetId);

      const newH = computeBookmarkHeight(data);
      yObj.set('height', newH);
    });
  } catch {
    // No active room — discard
  }
}

/**
 * Worker callback: unfurl failed. Fall back to text object with URL.
 */
export function handleUnfurlFailed(objectId: string, _permanent: boolean): void {
  if (!hasActiveRoom()) return;

  const pending = pendingBookmarks.get(objectId);
  if (pending) {
    console.warn('[bookmark] unfurl failed → text fallback:', objectId);
    pasteUrlAsText(pending.url, pending.worldX, pending.worldY, objectId);
    removePlaceholder(objectId);
    pendingBookmarks.delete(objectId);
  }
}

/**
 * Room teardown: clear all placeholders and pending state.
 */
export function cleanupOnRoomTeardown(): void {
  removeAllPlaceholders();
  pendingBookmarks.clear();
}
