/**
 * Presence cursors — pointer + name label for remote peers.
 * Reads presence and view transform imperatively. Handles own DPR transform.
 *
 * @module renderer/layers/presence-cursors
 */

import { useCameraStore, getViewTransform } from '@/stores/camera-store';
import { getCurrentPresence } from '@/canvas/room-runtime';

export function drawCursors(ctx: CanvasRenderingContext2D): void {
  const presence = getCurrentPresence();
  if (presence.users.size === 0) return;

  const { dpr } = useCameraStore.getState();
  const { worldToCanvas } = getViewTransform();

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  presence.users.forEach((user) => {
    if (!user.cursor) return;
    const [cx, cy] = worldToCanvas(user.cursor.x, user.cursor.y);
    drawCursorPointer(ctx, cx, cy, user.color);
    drawNameLabel(ctx, cx, cy, user.name, user.color);
  });

  ctx.restore();
}

// Exported for future cursor interpolation animation job to reuse

export function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 4, y + 10);
  ctx.lineTo(x + 1, y + 7);
  ctx.lineTo(x + 6, y + 12);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

export function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
): void {
  ctx.save();

  const labelX = x + 8;
  const labelY = y + 14;

  ctx.font = '11px system-ui, -apple-system, sans-serif';
  const metrics = ctx.measureText(name);
  const padding = 4;
  const width = metrics.width + padding * 2;
  const height = 16;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  const rr = (ctx as any).roundRect;
  if (typeof rr === 'function') {
    rr.call(ctx, labelX, labelY, width, height, height / 2);
  } else {
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, width, height, height / 2);
  }
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}
