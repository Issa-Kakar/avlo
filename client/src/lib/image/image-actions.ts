/**
 * Image Actions — shared image creation logic.
 *
 * Used by CanvasRuntime (drop), clipboard-actions (paste), toolbar, and keyboard shortcut.
 */

import { ulid } from 'ulid';
import * as Y from 'yjs';
import { isSvg } from '@avlo/shared';
import { ingest, enqueue } from './image-manager';
import { transact, getObjects } from '@/canvas/room-runtime';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { userProfileManager } from '@/lib/user-profile-manager';
import { getVisibleWorldBounds } from '@/stores/camera-store';

const MAX_SVG_INPUT = 10 * 1024 * 1024; // 10 MB
const SVG_TIMEOUT = 10_000; // 10 s

/**
 * Rasterize an SVG blob to a high-res PNG via <img> + canvas.
 *
 * Modifies the SVG markup to set target pixel dimensions (2048–4096px range)
 * so the browser's SVG renderer rasterizes the vector art at high resolution
 * instead of at tiny intrinsic size (e.g. 24×24 icon → 2048×2048 PNG).
 */
async function rasterizeSvg(blob: Blob): Promise<Blob> {
  if (blob.size > MAX_SVG_INPUT) throw new Error('SVG exceeds 10 MB');

  const text = await blob.text();

  // Parse intrinsic dimensions (viewBox > width/height > SVG spec default 300×150)
  let w = 300,
    h = 150;
  const vbMatch = text.match(/viewBox=["']([^"']+)["']/);
  if (vbMatch) {
    const parts = vbMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
      w = parts[2];
      h = parts[3];
    }
  } else {
    const wm = text.match(/\bwidth=["'](\d+(?:\.\d+)?)/);
    const hm = text.match(/\bheight=["'](\d+(?:\.\d+)?)/);
    if (wm && hm) {
      w = parseFloat(wm[1]);
      h = parseFloat(hm[1]);
    }
  }

  // Scale longest side into [2048, 4096] range
  const longest = Math.max(w, h);
  let scale = 1;
  if (longest < 2048) scale = 2048 / longest;
  else if (longest > 4096) scale = 4096 / longest;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  // Modify SVG: strip width/height, ensure viewBox, inject target dims.
  // This makes <img> rasterize the vector art at target resolution, not tiny intrinsic size.
  const modified = text.replace(/<svg([^>]*)>/, (_match, attrs: string) => {
    let clean = attrs
      .replace(/\bwidth\s*=\s*["'][^"']*["']/g, '')
      .replace(/\bheight\s*=\s*["'][^"']*["']/g, '');
    if (!/viewBox/.test(clean)) {
      clean += ` viewBox="0 0 ${w} ${h}"`;
    }
    return `<svg${clean} width="${tw}" height="${th}">`;
  });

  // Load modified SVG into <img> — browser's SVG sandbox renders at target resolution
  const url = URL.createObjectURL(new Blob([modified], { type: 'image/svg+xml' }));
  const img = new Image();
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('SVG decode failed'));
        img.src = url;
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SVG rasterization timed out')), SVG_TIMEOUT),
      ),
    ]);

    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    canvas.getContext('2d')!.drawImage(img, 0, 0, tw, th);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (!b) return reject(new Error('canvas.toBlob failed'));
        if (b.size > 10 * 1024 * 1024) return reject(new Error('Output PNG exceeds 10 MB'));
        resolve(b);
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
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

  transact(() => {
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
    getObjects().set(objectId, yObj);
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
