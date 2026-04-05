/**
 * CursorAnimationJob — exponential smoothing + bitmap-cached cursor rendering.
 *
 * Reads the mutable peerCursors map directly from lib/presence.ts —
 * zero Zustand overhead per frame.
 *
 * Exponential smoothing: display += (target - display) * (1 - exp(-dt / TAU))
 * Frame-rate independent: same perceptual smoothing at 60fps, 144fps, or any rate.
 */

import type { AnimationJob } from './AnimationController';
import { getPeerCursors } from '@/lib/presence';
import {
  getCursorBitmap,
  CURSOR_BITMAP_OFFSET_X,
  CURSOR_BITMAP_OFFSET_Y,
  CURSOR_BITMAP_SCALE,
} from './cursor-bitmap';
import { useCameraStore, getViewTransform, getVisibleWorldBounds } from '@/stores/camera-store';

const TAU = 60; // ms — responsive at 20Hz send rate
const SETTLE_THRESHOLD_PX = 0.5; // canvas pixels
const VIEWPORT_MARGIN = 100; // world units — render cursors slightly outside viewport

export class CursorAnimationJob implements AnimationJob {
  readonly id = 'cursor-animation';

  frame(ctx: CanvasRenderingContext2D, _now: number, dt: number): boolean {
    const peers = getPeerCursors();
    if (peers.size === 0) return false;

    const { dpr } = useCameraStore.getState();
    const { worldToCanvas } = getViewTransform();
    const vp = getVisibleWorldBounds();
    const bitmapInvScale = 1 / CURSOR_BITMAP_SCALE;

    const clampedDt = Math.min(dt, 200);
    const alpha = clampedDt > 0 ? 1 - Math.exp(-clampedDt / TAU) : 0;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let anyActive = false;

    for (const peer of peers.values()) {
      if (!peer.hasCursor) continue;

      // Exponential smoothing
      if (!peer.isSettled && alpha > 0) {
        peer.display[0] += (peer.target[0] - peer.display[0]) * alpha;
        peer.display[1] += (peer.target[1] - peer.display[1]) * alpha;

        // Settle check in canvas space
        const [dcx, dcy] = worldToCanvas(peer.display[0], peer.display[1]);
        const [tcx, tcy] = worldToCanvas(peer.target[0], peer.target[1]);
        if (
          Math.abs(dcx - tcx) < SETTLE_THRESHOLD_PX &&
          Math.abs(dcy - tcy) < SETTLE_THRESHOLD_PX
        ) {
          peer.display[0] = peer.target[0];
          peer.display[1] = peer.target[1];
          peer.isSettled = true;
        }
      }

      // Viewport bounds check (with margin)
      if (
        peer.display[0] < vp.minX - VIEWPORT_MARGIN ||
        peer.display[0] > vp.maxX + VIEWPORT_MARGIN ||
        peer.display[1] < vp.minY - VIEWPORT_MARGIN ||
        peer.display[1] > vp.maxY + VIEWPORT_MARGIN
      ) {
        if (!peer.isSettled) anyActive = true;
        continue;
      }

      // World → canvas, offset by bitmap tip position
      const [cx, cy] = worldToCanvas(peer.display[0], peer.display[1]);

      const bmp = getCursorBitmap(peer.color, peer.name);
      ctx.drawImage(
        bmp,
        cx - CURSOR_BITMAP_OFFSET_X,
        cy - CURSOR_BITMAP_OFFSET_Y,
        bmp.width * bitmapInvScale,
        bmp.height * bitmapInvScale,
      );

      if (!peer.isSettled) anyActive = true;
    }

    ctx.restore();

    return anyActive;
  }

  destroy(): void {
    // No persistent resources to clean up
  }
}
