/**
 * Image Actions — shared image creation logic.
 *
 * Used by CanvasRuntime (drop), clipboard-actions (paste), toolbar, and keyboard shortcut.
 */

import { ulid } from 'ulid';
import * as Y from 'yjs';
import { isSvg } from '@avlo/shared';
import { ingest, enqueue } from './image-manager';
import { getActiveRoomDoc } from '@/canvas/room-runtime';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { userProfileManager } from '@/lib/user-profile-manager';
import { getVisibleWorldBounds } from '@/stores/camera-store';

/** Rasterize an SVG blob to a PNG blob via offscreen canvas. */
async function rasterizeSvg(blob: Blob): Promise<Blob> {
  const text = await blob.text();

  // Parse dimensions from viewBox or width/height attributes
  let width = 800;
  let height = 600;
  const viewBoxMatch = text.match(/viewBox=["']([^"']+)["']/);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      width = parts[2];
      height = parts[3];
    }
  } else {
    const wMatch = text.match(/\bwidth=["'](\d+(?:\.\d+)?)/);
    const hMatch = text.match(/\bheight=["'](\d+(?:\.\d+)?)/);
    if (wMatch && hMatch) {
      width = parseFloat(wMatch[1]);
      height = parseFloat(hMatch[1]);
    }
  }

  // Clamp to reasonable maximum
  const maxDim = 4096;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG decode failed'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('canvas.toBlob failed'));
    }, 'image/png');
  });
}

/** Create an image object from a blob at a world position. */
export async function createImageFromBlob(
  blob: Blob,
  worldX: number,
  worldY: number,
  opts?: { selectAfter?: boolean },
): Promise<string> {
  // SVG → rasterize to PNG before ingesting
  let finalBlob = blob;
  if (blob.type === 'image/svg+xml') {
    finalBlob = await rasterizeSvg(blob);
  } else {
    // Byte-sniff for SVGs without correct MIME (e.g. from file drop)
    const peek = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
    if (isSvg(peek)) {
      finalBlob = await rasterizeSvg(blob);
    }
  }

  const result = await ingest(finalBlob);
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
  input.accept = 'image/*,.svg';
  input.multiple = true;
  input.style.display = 'none';

  input.addEventListener('change', () => {
    const files = input.files;
    if (!files || files.length === 0) {
      input.remove();
      return;
    }

    const vp = getVisibleWorldBounds();
    const cx = (vp.minX + vp.maxX) / 2;
    const cy = (vp.minY + vp.maxY) / 2;

    for (const file of Array.from(files)) {
      createImageFromBlob(file, cx, cy);
    }
    input.remove();
  });
  input.addEventListener('cancel', () => input.remove());

  document.body.appendChild(input);
  input.click();
}
