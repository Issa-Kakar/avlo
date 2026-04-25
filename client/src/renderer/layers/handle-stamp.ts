/**
 * Resize-handle bitmap stamp.
 *
 * One offscreen canvas painted once with the full handle look (fill + stroke +
 * drop shadow). Per frame, `drawResizeHandles` blits this stamp at each handle
 * position via `drawImage`, eliminating `shadowBlur` from the hot path.
 *
 * Re-rendered if DPR changes between calls.
 *
 * @module renderer/layers/handle-stamp
 */

import { useCameraStore } from '@/stores/camera-store';
import type { HandleId } from '@/tools/types';

// Visible handle metrics (must stay in sync with the legacy direct-draw values).
const HANDLE_RADIUS_PX = 6;
const HANDLE_FILL = 'rgb(250, 250, 250)';
const HANDLE_STROKE = 'rgba(0, 0, 0, 0.25)';
const HANDLE_STROKE_WIDTH_PX = 2.5;
const HANDLE_SHADOW_COLOR = 'rgba(0, 0, 0, 0.25)';
const HANDLE_SHADOW_BLUR_PX = 4;
const HANDLE_SHADOW_OFFSET_Y_PX = 1;

/** Stamp footprint in CSS pixels — radius + stroke + shadow blur + offset, with margin. */
export const STAMP_SIZE_PX = 32;

let stamp: HTMLCanvasElement | null = null;
let stampDpr = 0;

function buildStamp(dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = STAMP_SIZE_PX * dpr;
  canvas.height = STAMP_SIZE_PX * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const cx = STAMP_SIZE_PX / 2;
  const cy = STAMP_SIZE_PX / 2;

  // Pass 1: fill with shadow.
  ctx.shadowColor = HANDLE_SHADOW_COLOR;
  ctx.shadowBlur = HANDLE_SHADOW_BLUR_PX;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = HANDLE_SHADOW_OFFSET_Y_PX;
  ctx.fillStyle = HANDLE_FILL;
  ctx.beginPath();
  ctx.arc(cx, cy, HANDLE_RADIUS_PX, 0, Math.PI * 2);
  ctx.fill();

  // Pass 2: outline (no shadow).
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = HANDLE_STROKE;
  ctx.lineWidth = HANDLE_STROKE_WIDTH_PX;
  ctx.beginPath();
  ctx.arc(cx, cy, HANDLE_RADIUS_PX, 0, Math.PI * 2);
  ctx.stroke();

  return canvas;
}

function getHandleStamp(dpr: number): HTMLCanvasElement {
  if (!stamp || stampDpr !== dpr) {
    stamp = buildStamp(dpr);
    stampDpr = dpr;
  }
  return stamp;
}

/**
 * Stamp the handle bitmap at each handle position. Called inside the world
 * transform — handle positions are world coords, but the stamp size is held
 * constant in screen pixels by dividing by camera scale.
 */
export function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  handles: readonly { id: HandleId; x: number; y: number }[],
  scale: number,
): void {
  const dpr = useCameraStore.getState().dpr;
  const img = getHandleStamp(dpr);
  const sizeWorld = STAMP_SIZE_PX / scale;
  const half = sizeWorld / 2;
  for (const h of handles) {
    ctx.drawImage(img, h.x - half, h.y - half, sizeWorld, sizeWorld);
  }
}
