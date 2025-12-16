/**
 * PresenceInterpolator - Render-time cursor interpolation
 *
 * Responsibilities:
 * - Maintain per-peer smoothing state
 * - Compute interpolated cursor positions at render time
 * - Report animation status for render loop invalidation
 *
 * Design decisions:
 * - Interpolation happens at RENDER TIME, not data ingestion
 * - Uses seq-based gap detection to snap vs lerp
 * - Short interpolation window (~66ms) for responsiveness
 * - Designed to fit future AnimationController job-based model
 */

import type { PeerCursor } from '@/lib/awareness-manager';

// Interpolation window - ~1-2 frames at 60 FPS
const INTERP_WINDOW_MS = 66;

/**
 * Internal smoothing state per peer
 */
interface CursorSmoother {
  prev: { x: number; y: number } | null;
  current: { x: number; y: number } | null;
  animStart: number;
  animEnd: number;
  lastSeq: number;
}

/**
 * Output cursor with interpolated position
 */
export interface InterpolatedCursor {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/**
 * PresenceInterpolator - Computes cursor interpolation at render time.
 *
 * Future AnimationController Integration:
 * This class is designed to fit into a job-based animation system:
 * - `isAnimating()` reports if animation is in progress (job has target)
 * - `needsOverlayInvalidation()` returns true when cursors need redraw
 * - Animation "completes" when all cursors reach their targets
 *
 * The interpolator doesn't drive the render loop - it responds to it.
 * The render loop calls `getInterpolatedCursors()` on each frame,
 * and the interpolator reports if more frames are needed.
 */
export class PresenceInterpolator {
  private smoothers = new Map<number, CursorSmoother>();
  private _needsOverlay = false;

  /**
   * Called when peer data changes (from AwarenessManager subscription)
   * Updates internal smoothing state based on new cursor positions
   */
  onPeersChanged(peers: ReadonlyMap<number, PeerCursor>, now: number): void {
    // Remove stale smoothers for peers that left
    for (const clientId of this.smoothers.keys()) {
      if (!peers.has(clientId)) {
        this.smoothers.delete(clientId);
        this._needsOverlay = true;
      }
    }

    // Update smoothers for each peer
    for (const [clientId, peer] of peers) {
      // No cursor - remove smoother
      if (!peer.cursor) {
        if (this.smoothers.has(clientId)) {
          this.smoothers.delete(clientId);
          this._needsOverlay = true;
        }
        continue;
      }

      let s = this.smoothers.get(clientId);
      if (!s) {
        s = { prev: null, current: null, animStart: 0, animEnd: 0, lastSeq: -1 };
        this.smoothers.set(clientId, s);
      }

      // Skip if same seq (no new data)
      if (peer.seq <= s.lastSeq) continue;

      // Gap detection: if seq jumped, snap instead of lerp
      const gap = s.lastSeq >= 0 && peer.seq > s.lastSeq + 1;

      if (!s.current || gap) {
        // Snap: no interpolation (first sample or gap)
        s.prev = null;
        s.current = { x: peer.cursor.x, y: peer.cursor.y };
        s.animStart = 0;
        s.animEnd = 0;
      } else {
        // Lerp: interpolate from current to new position
        s.prev = s.current;
        s.current = { x: peer.cursor.x, y: peer.cursor.y };
        s.animStart = now;
        s.animEnd = now + INTERP_WINDOW_MS;
      }

      s.lastSeq = peer.seq;
      this._needsOverlay = true;
    }
  }

  /**
   * Called at render time to get interpolated cursor positions
   * Returns cursors with positions smoothed based on animation state
   */
  getInterpolatedCursors(peers: ReadonlyMap<number, PeerCursor>, now: number): InterpolatedCursor[] {
    const result: InterpolatedCursor[] = [];

    for (const [clientId, peer] of peers) {
      if (!peer.cursor) continue;

      const s = this.smoothers.get(clientId);
      if (!s || !s.current) {
        // No smoother yet, use raw position
        result.push({
          clientId,
          userId: peer.userId,
          name: peer.name,
          color: peer.color,
          x: peer.cursor.x,
          y: peer.cursor.y,
        });
        continue;
      }

      let x = s.current.x;
      let y = s.current.y;

      // Apply interpolation if in animation window
      if (s.prev && s.animEnd > 0 && now < s.animEnd) {
        const duration = s.animEnd - s.animStart;
        const elapsed = now - s.animStart;
        const t = Math.min(1, Math.max(0, elapsed / duration));
        x = s.prev.x + (s.current.x - s.prev.x) * t;
        y = s.prev.y + (s.current.y - s.prev.y) * t;
      }

      result.push({
        clientId,
        userId: peer.userId,
        name: peer.name,
        color: peer.color,
        x,
        y,
      });
    }

    return result;
  }

  /**
   * Returns true if any cursor is mid-interpolation
   * Used by render loop to know if more frames are needed
   */
  isAnimating(now: number): boolean {
    for (const s of this.smoothers.values()) {
      if (s.animEnd > now) return true;
    }
    return false;
  }

  /**
   * Returns true if overlay needs redraw due to cursor changes
   * Clears the flag after reading (one-shot)
   */
  needsOverlayInvalidation(): boolean {
    const needs = this._needsOverlay;
    this._needsOverlay = false;
    return needs;
  }

  /**
   * Clear all smoothing state (e.g., on room change)
   */
  clear(): void {
    this.smoothers.clear();
    this._needsOverlay = false;
  }
}
