/**
 * Bookmark Unfurl Coordinator v2 — single atomic transaction design.
 *
 * No Y.Doc write until unfurl completes (online) or first failure (offline).
 * Loading state is local-only via HTML placeholder.
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { FrameTuple } from '@avlo/shared';
import { extractDomain } from '@avlo/shared';
import { hasActiveRoom, getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { postToPrimary } from '@/lib/image/image-manager';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { getCurrentTool } from '@/canvas/tool-registry';
import { userProfileManager } from '@/lib/user-profile-manager';
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
  committed: boolean;
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

/**
 * Begin unfurl flow: show HTML placeholder, send to worker, select object.
 * Returns pre-generated objectId.
 */
export function beginUnfurl(url: string, worldX: number, worldY: number): string {
  const objectId = ulid();
  const domain = extractDomain(url);

  pendingBookmarks.set(objectId, {
    url,
    domain,
    worldX,
    worldY,
    committed: false,
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

  if (pending && !pending.committed) {
    // Case A: online happy path — single atomic transaction with ALL fields
    const height = computeBookmarkHeight(data);
    const frame: FrameTuple = [
      pending.worldX - BOOKMARK_WIDTH / 2,
      pending.worldY - height / 2,
      BOOKMARK_WIDTH,
      height,
    ];
    const userId = userProfileManager.getIdentity().userId;

    getActiveRoomDoc().mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
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
      objects.set(objectId, yObj);
    });

    removePlaceholder(objectId);
    pendingBookmarks.delete(objectId);
    return;
  }

  if (pending && pending.committed) {
    // Case B: offline→online recovery — upgrade existing minimal bookmark
    getActiveRoomDoc().mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
      const yObj = objects.get(objectId);
      if (!yObj || yObj.get('kind') !== 'bookmark') return;

      if (data.title != null) yObj.set('title', data.title);
      if (data.description != null) yObj.set('description', data.description);
      if (data.ogImageAssetId) yObj.set('ogImageAssetId', data.ogImageAssetId);
      if (data.ogImageWidth != null) yObj.set('ogImageWidth', data.ogImageWidth);
      if (data.ogImageHeight != null) yObj.set('ogImageHeight', data.ogImageHeight);
      if (data.faviconAssetId) yObj.set('faviconAssetId', data.faviconAssetId);

      // Recompute frame height
      const oldFrame = yObj.get('frame') as FrameTuple;
      const newH = computeBookmarkHeight(data);
      yObj.set('frame', [oldFrame[0], oldFrame[1], oldFrame[2], newH]);
    });

    pendingBookmarks.delete(objectId);
    return;
  }

  // Case C: page refresh recovery — no pending map entry
  try {
    const snapshot = getCurrentSnapshot();
    if (!snapshot) return;
    const handle = snapshot.objectsById.get(objectId);
    if (!handle || handle.kind !== 'bookmark') return;

    // Upgrade existing minimal bookmark
    getActiveRoomDoc().mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
      const yObj = objects.get(objectId);
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
    // No active room or snapshot — discard
  }
}

/**
 * Worker callback: unfurl failed.
 * On first transient failure: commit minimal bookmark + remove placeholder.
 * On permanent failure: commit if needed + clean up.
 */
export function handleUnfurlFailed(objectId: string, permanent: boolean): void {
  if (!hasActiveRoom()) return;

  const pending = pendingBookmarks.get(objectId);

  if (pending && !pending.committed) {
    // Commit minimal bookmark (url + domain + minimal frame)
    const minH = computeBookmarkHeight({});
    const frame: FrameTuple = [
      pending.worldX - BOOKMARK_WIDTH / 2,
      pending.worldY - minH / 2,
      BOOKMARK_WIDTH,
      minH,
    ];
    const userId = userProfileManager.getIdentity().userId;

    getActiveRoomDoc().mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'bookmark');
      yObj.set('url', pending.url);
      yObj.set('domain', pending.domain);
      yObj.set('frame', frame);
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());
      objects.set(objectId, yObj);
    });

    removePlaceholder(objectId);
    pending.committed = true;
  }

  if (permanent) {
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
