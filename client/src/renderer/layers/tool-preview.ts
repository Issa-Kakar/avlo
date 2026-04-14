/**
 * Tool preview dispatch — extracted from OverlayRenderLoop.
 * Routes the active tool preview to its specialized drawer.
 *
 * @module renderer/layers/tool-preview
 */

import { drawStrokePreview } from './stroke-preview';
import { drawDimmedStrokes } from './eraser-dim';
import { drawPerfectShapePreview } from './perfect-shape-preview';
import { drawSelectionOverlay } from './selection-overlay';
import { drawConnectorPreview } from './connector-preview';
import { getActivePreview } from '@/runtime/tool-registry';
import { useCameraStore } from '@/stores/camera-store';
import { getCurrentSnapshot } from '@/runtime/room-runtime';

/**
 * Draw the current tool preview. Context should be in world transform.
 * Reads preview from tool registry, scale/snapshot imperatively.
 */
export function drawToolPreview(ctx: CanvasRenderingContext2D): void {
  const preview = getActivePreview();
  if (!preview) return;

  switch (preview.kind) {
    case 'stroke':
      drawStrokePreview(ctx, preview);
      break;
    case 'eraser':
      if (preview.hitIds.length > 0) drawDimmedStrokes(ctx, preview.hitIds, getCurrentSnapshot(), preview.dimOpacity);
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
}
