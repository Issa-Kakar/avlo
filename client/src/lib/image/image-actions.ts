/**
 * Image Actions — shared image creation logic.
 *
 * Used by CanvasRuntime (drop), clipboard-actions (paste), toolbar, and keyboard shortcut.
 */

import { ulid } from 'ulid';
import * as Y from 'yjs';
import { ingest } from './image-manager';
import { enqueue } from './upload-queue';
import { getActiveRoomDoc } from '@/canvas/room-runtime';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { userProfileManager } from '@/lib/user-profile-manager';
import { getVisibleWorldBounds } from '@/stores/camera-store';

/** Create an image object from a blob at a world position. */
export async function createImageFromBlob(
  blob: Blob,
  worldX: number,
  worldY: number,
  opts?: { selectAfter?: boolean },
): Promise<string> {
  const result = await ingest(blob);
  const width = 400;
  const height = width * (result.naturalHeight / result.naturalWidth);
  const x = worldX - width / 2;
  const y = worldY - height / 2;

  const objectId = ulid();
  const userId = userProfileManager.getIdentity().userId;

  getActiveRoomDoc().mutate((ydoc) => {
    const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
    const yObj = new Y.Map<unknown>();
    yObj.set('id', objectId);
    yObj.set('kind', 'image');
    yObj.set('assetId', result.assetId);
    yObj.set('frame', [x, y, width, height]);
    yObj.set('naturalWidth', result.naturalWidth);
    yObj.set('naturalHeight', result.naturalHeight);
    yObj.set('mimeType', result.mimeType);
    yObj.set('ownerId', userId);
    yObj.set('createdAt', Date.now());
    objects.set(objectId, yObj);
  });

  if (opts?.selectAfter !== false) {
    useDeviceUIStore.getState().setActiveTool('select');
    useSelectionStore.getState().setSelection([objectId]);
    invalidateOverlay();
  }

  enqueue(result.assetId);
  return objectId;
}

/** Open a file picker, create image objects at viewport center. */
export function openImageFilePicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';

  input.addEventListener('change', () => {
    const files = input.files;
    if (!files || files.length === 0) return;

    const vp = getVisibleWorldBounds();
    const cx = (vp.minX + vp.maxX) / 2;
    const cy = (vp.minY + vp.maxY) / 2;

    for (const file of Array.from(files)) {
      createImageFromBlob(file, cx, cy);
    }
  });

  document.body.appendChild(input);
  input.click();
  // Clean up after browser processes the picker
  input.addEventListener('change', () => input.remove());
  input.addEventListener('cancel', () => input.remove());
}
