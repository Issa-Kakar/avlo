/**
 * presence-cursors.ts - Simple cursor pointer and name label rendering
 *
 * Simplified from ~356 lines to ~100 lines by removing:
 * - Cursor trails (CursorTrail, TrailProfile, catmullRom resampling)
 * - Trail lifecycle management
 * - Per-peer trail profiles
 * - Decay/fade logic
 *
 * Provides two APIs:
 * - Legacy: drawCursors(ctx, presence, view, gates) - for current OverlayRenderLoop
 * - New: drawCursorsFromInterpolator(ctx, cursors, view, gates) - for future integration
 */

import type { PresenceView, ViewTransform } from '@avlo/shared';
import type { InterpolatedCursor } from '../presence-interpolator';

/**
 * Draw cursor pointers and name labels for presence.
 * Legacy API using PresenceView from snapshot.
 *
 * @param ctx - Canvas rendering context
 * @param presence - PresenceView from snapshot
 * @param viewTransform - World-to-canvas coordinate transform
 * @param gates - Gate status
 */
export function drawCursors(
  ctx: CanvasRenderingContext2D,
  presence: PresenceView,
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean; firstSnapshot: boolean }
): void {
  // Check both gates for legacy compatibility
  if (!gates.awarenessReady || !gates.firstSnapshot) return;

  presence.users.forEach((user, _userId) => {
    const cursor = user.cursor;
    if (!cursor) return;

    const [cx, cy] = viewTransform.worldToCanvas(cursor.x, cursor.y);
    drawCursorPointer(ctx, cx, cy, user.color);
    drawNameLabel(ctx, cx, cy, user.name, user.color);
  });
}

/**
 * Draw cursor pointers and name labels using InterpolatedCursor array.
 * New API for use with PresenceInterpolator.
 *
 * @param ctx - Canvas rendering context
 * @param cursors - Already-interpolated cursor positions from PresenceInterpolator
 * @param viewTransform - World-to-canvas coordinate transform
 * @param gates - Gate status (only needs awarenessReady now)
 */
export function drawCursorsFromInterpolator(
  ctx: CanvasRenderingContext2D,
  cursors: InterpolatedCursor[],
  viewTransform: ViewTransform,
  gates: { awarenessReady: boolean }
): void {
  // Only check awarenessReady - firstSnapshot dependency removed
  if (!gates.awarenessReady) return;

  for (const cursor of cursors) {
    const [cx, cy] = viewTransform.worldToCanvas(cursor.x, cursor.y);
    drawCursorPointer(ctx, cx, cy, cursor.color);
    drawNameLabel(ctx, cx, cy, cursor.name, cursor.color);
  }
}

/**
 * Draw a cursor pointer glyph (arrow shape)
 */
function drawCursorPointer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string
): void {
  ctx.save();

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(x, y); // tip
  ctx.lineTo(x - 4, y + 10);
  ctx.lineTo(x + 1, y + 7);
  ctx.lineTo(x + 6, y + 12);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Draw a name label pill next to the cursor
 */
function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string
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
  ctx.beginPath();
  ctx.roundRect(labelX, labelY, width, height, height / 2);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.globalAlpha = 1;
  ctx.fillText(name, labelX + padding, labelY + 12);

  ctx.restore();
}

/**
 * Backward compatibility stub - trails are gone
 * @deprecated Trails have been removed. This is a no-op.
 */
export function clearCursorTrails(): void {
  // No-op - trails removed
}
