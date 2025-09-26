import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import type { GateStatus } from '@/hooks/use-connection-gates';
import { drawCursors } from './presence-cursors';

// Re-export the actual implementation
export { drawStrokes, clearStrokeCache } from './strokes';

// Import new implementations
export { drawText } from './text';

// Layer function signatures - all are stubs in Phase 3.3

export function drawBackground(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Phase 3.3: Stub only
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Background');
  }
}

export function drawShapes(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Placeholder for future shape rendering
  // Stamps have been removed in favor of perfect shapes
}

// drawText is now imported from './text'

export function drawAuthoringOverlays(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Selection boxes, handles, text cursor
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Authoring Overlays');
  }
}

export function drawPresenceOverlays(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  view: ViewTransform,
  _viewport: ViewportInfo,
  gates: GateStatus,
): void {
  // Phase 7: Cursors and trails implementation
  // CRITICAL GATE CHECK: Only render when BOTH gates are open
  // - G_AWARENESS_READY: Ensures awareness channel is live (WS or RTC)
  // - G_FIRST_SNAPSHOT: Ensures we have valid doc data to render against
  // Without both, cursors are hidden immediately

  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Presence Overlays', {
      awarenessReady: gates.awarenessReady,
      firstSnapshot: gates.firstSnapshot,
      userCount: snapshot.presence.users.size,
    });
  }

  // Draw cursors with trails (Phase 7)
  drawCursors(ctx, snapshot.presence, view, {
    awarenessReady: gates.awarenessReady,
    firstSnapshot: gates.firstSnapshot,
  });
}

export function drawHUD(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Minimap, toasts, update prompts
  // Note: Never included in export
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] HUD');
  }
}
