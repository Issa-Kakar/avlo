import type { Snapshot, ViewTransform } from '@avlo/shared';
import type { ViewportInfo } from '../types';

// Layer function signatures - all are stubs in Phase 3.3

export function drawBackground(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Phase 3.3: Stub only
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Background');
  }
}

export function drawStrokes(
  _ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Phase 4: Will implement actual stroke rendering
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Strokes', snapshot.strokes.length);
  }
}

export function drawShapes(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future phase: Stamps and shapes
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Shapes');
  }
}

export function drawText(
  _ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Phase 11: Text rendering
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Text', snapshot.texts.length);
  }
}

export function drawAuthoringOverlays(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Selection boxes, handles, text cursor
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Authoring Overlays');
  }
}

export function drawPresenceOverlays(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Phase 8: Cursors and trails
  // CRITICAL GATE CHECK: Only render when BOTH gates are open
  // - G_AWARENESS_READY: Ensures awareness channel is live (WS or RTC)
  // - G_FIRST_SNAPSHOT: Ensures we have valid doc data to render against
  // Without both, show "Presence degraded" indicator but NO cursors

  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] Presence Overlays');
  }

  // TODO Phase 8: Implement gate checks
  // const gateManager = /* get gate manager instance */;
  // if (!gateManager.isOpen('G_AWARENESS_READY') || !gateManager.isOpen('G_FIRST_SNAPSHOT')) {
  //   return; // Skip rendering cursors
  // }
}

export function drawHUD(
  _ctx: CanvasRenderingContext2D,
  _snapshot: Snapshot,
  _view: ViewTransform,
  _viewport: ViewportInfo,
): void {
  // Future: Minimap, toasts, update prompts
  // Note: Never included in export
  if (process.env.NODE_ENV === 'development' && process.env.DEBUG_RENDER_LAYERS) {
    // eslint-disable-next-line no-console
    console.log('[Layer] HUD');
  }
}
