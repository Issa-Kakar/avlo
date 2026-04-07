/**
 * Tool preview dispatch — extracted from OverlayRenderLoop.
 * Handles preview routing, caching, and the hold-one-frame mechanism.
 *
 * @module renderer/layers/tool-preview
 */

import type { PreviewData } from '@/tools/types';
import { drawStrokePreview } from './stroke-preview';
import { drawDimmedStrokes } from './eraser-dim';
import { drawPerfectShapePreview } from './perfect-shape-preview';
import { drawSelectionOverlay } from './selection-overlay';
import { drawConnectorPreview } from './connector-preview';
import { getActivePreview } from '@/runtime/tool-registry';
import { useCameraStore } from '@/stores/camera-store';
import { getCurrentSnapshot } from '@/runtime/room-runtime';
import { invalidateOverlay } from '../OverlayRenderLoop';

// Preview hold state — prevents single-frame flash on commit
let cached: PreviewData | null = null;
let holdOneFrame = false;

export function holdPreviewForOneFrame(): void {
  if (getActivePreview()?.kind === 'eraser') return;
  holdOneFrame = true;
  invalidateOverlay();
}

export function clearPreviewCache(): void {
  cached = null;
  holdOneFrame = false;
}

/**
 * Draw the current tool preview. Context should be in world transform.
 * Reads preview from tool registry, scale/snapshot imperatively.
 */
export function drawToolPreview(ctx: CanvasRenderingContext2D): void {
  const live = getActivePreview();
  if (live && live.kind !== 'eraser') cached = live;

  const preview = live || (holdOneFrame ? cached : null);
  if (!preview) return;

  switch (preview.kind) {
    case 'stroke':
      drawStrokePreview(ctx, preview);
      break;
    case 'eraser':
      if (preview.hitIds.length > 0)
        drawDimmedStrokes(ctx, preview.hitIds, getCurrentSnapshot(), preview.dimOpacity);
      break;
    case 'perfectShape':
      drawPerfectShapePreview(ctx, preview);
      break;
    case 'selection':
      drawSelectionOverlay(ctx, preview, useCameraStore.getState().scale, getCurrentSnapshot());
      break;
    case 'connector':
      drawConnectorPreview(ctx, preview, useCameraStore.getState().scale);
      break;
  }

  // Clear hold after drawing the held frame
  if (!live && holdOneFrame) {
    holdOneFrame = false;
    cached = null;
  }
}
