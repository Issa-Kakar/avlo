/**
 * Bookmark Unfurl Coordinator v2 — single atomic transaction design.
 *
 * No Y.Doc write until unfurl completes (online) or first failure (offline).
 * Loading state is local-only via HTML placeholder.
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { FrameTuple } from '@/types/geometry';
import { extractDomain } from '@avlo/shared';
import { hasActiveRoom, getHandle, transact, getObjects } from '@/canvas/room-runtime';
import { pasteUrlAsText } from '@/lib/clipboard/clipboard-actions';
import { postToPrimary } from '@/lib/image/image-manager';
import { useDeviceUIStore, getUserId } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { getCurrentTool } from '@/canvas/tool-registry';
import { computeBookmarkHeight, BOOKMARK_WIDTH } from './bookmark-render';
import {
  createPlaceholder,
  removePlaceholder,
  removeAllPlaceholders,
} from './bookmark-placeholder';

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

  // Switch to select tool and pre-select the objectId
  if (!getCurrentTool()?.isActive()) {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection([objectId]);
    invalidateOverlay();
  }

  return objectId;
}

/**
 * Worker callback: unfurl succeeded. Write bookmark to Y.Doc atomically.
 */
export function handleUnfurlResult(objectId: string, data: UnfurlResultData): void {
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

    // Online happy path — single atomic transaction with ALL fields
    console.warn('[bookmark] unfurl success:', objectId, {
      title: !!data.title,
      ogImage: !!data.ogImageAssetId,
    });
    const height = computeBookmarkHeight(data);
    const frame: FrameTuple = [
      pending.worldX - BOOKMARK_WIDTH / 2,
      pending.worldY - height / 2,
      BOOKMARK_WIDTH,
      height,
    ];
    const userId = getUserId();

    transact(() => {
      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'bookmark');
      yObj.set('url', pending.url);
      yObj.set('domain', pending.domain);
      yObj.set('frame', frame);
      if (data.title != null) yObj.set('title', data.title);
      if (data.description != null) yObj.set('description', data.description);
      if (data.ogImageAssetId) yObj.set('ogImageAssetId', data.ogImageAssetId);
      if (data.ogImageWidth != null) yObj.set('ogImageWidth', data.ogImageWidth);
      if (data.ogImageHeight != null) yObj.set('ogImageHeight', data.ogImageHeight);
      if (data.faviconAssetId) yObj.set('faviconAssetId', data.faviconAssetId);
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());
      getObjects().set(objectId, yObj);
    });

    removePlaceholder(objectId);
    pendingBookmarks.delete(objectId);
    return;
  }

  // Case C: page refresh recovery — no pending map entry
  try {
    const handle = getHandle(objectId);
    if (!handle || handle.kind !== 'bookmark') return;

    // Upgrade existing bookmark with metadata
    transact(() => {
      const yObj = getObjects().get(objectId);
      if (!yObj || yObj.get('kind') !== 'bookmark') return;

      if (data.title != null) yObj.set('title', data.title);
      if (data.description != null) yObj.set('description', data.description);
      if (data.ogImageAssetId) yObj.set('ogImageAssetId', data.ogImageAssetId);
      if (data.ogImageWidth != null) yObj.set('ogImageWidth', data.ogImageWidth);
      if (data.ogImageHeight != null) yObj.set('ogImageHeight', data.ogImageHeight);
      if (data.faviconAssetId) yObj.set('faviconAssetId', data.faviconAssetId);

      const oldFrame = yObj.get('frame') as FrameTuple;
      const newH = computeBookmarkHeight(data);
      yObj.set('frame', [oldFrame[0], oldFrame[1], oldFrame[2], newH]);
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
