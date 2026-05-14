/**
 * Presence Pointer — pure dispatch for the document-level local-cursor path.
 *
 * Analogous to keyboard-manager.ts: exported dispatch functions + a little
 * module-private state, no listeners or subscriptions of its own — InputManager
 * owns the `document` listeners, CanvasRuntime owns the camera trigger — so
 * there is nothing to tear down.
 *
 * Why document-level: the canvas is conceptually a full-viewport surface
 * underneath all DOM chrome (toolbar, menus, editor overlays). The world
 * position under the pointer is well-defined whatever element is on top, so the
 * local presence cursor must keep broadcasting even when the pointer is over
 * DOM chrome — which base-canvas pointer events cannot see.
 *
 * @module runtime/presence/presence-pointer
 */

import { screenToWorldInto } from '@/stores/camera-store';
import { clearCursor, updateCursor } from './presence';

/** Zero-alloc scratch for screen→world conversion. */
const _worldScratch: [number, number] = [0, 0];

/** Last screen position — replayed through the camera on view changes. */
let lastClientX = 0;
let lastClientY = 0;
let hasClientPos = false;

/**
 * `document` `pointermove` — broadcast the world position under the pointer
 * whatever DOM element is on top. Zero-alloc. All pointer types pass through;
 * the mobile chokepoint stays `isMobile()` in `presence.ts`'s `flush()`.
 */
export function handlePresencePointerMove(e: PointerEvent): void {
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  hasClientPos = true;
  if (screenToWorldInto(e.clientX, e.clientY, _worldScratch)) {
    updateCursor(_worldScratch[0], _worldScratch[1]);
  }
}

/**
 * `document` `pointerout` — clear only on genuine window exit. `pointerout`
 * bubbles, so one document listener catches every exit; `relatedTarget === null`
 * means the pointer left the document. Moving onto the toolbar/menus gives a
 * non-null `relatedTarget` → cursor stays live (the fix).
 */
export function handlePresencePointerOut(e: PointerEvent): void {
  if (e.relatedTarget === null) {
    hasClientPos = false;
    clearCursor();
  }
}

/** Window blur (alt-tab) — clear the broadcast cursor. */
export function handlePresenceBlur(): void {
  hasClientPos = false;
  clearCursor();
}

/**
 * Camera moved (wheel-zoom, keyboard-pan, edge-scroll) — the pointer is
 * stationary in screen space but its world position changed. Replay the last
 * screen position through the new camera. `hasClientPos` gates this so a camera
 * move after a clear cannot un-clear the cursor while the pointer is away.
 */
export function syncPresenceCursorOnCameraMove(): void {
  if (!hasClientPos) return;
  if (screenToWorldInto(lastClientX, lastClientY, _worldScratch)) {
    updateCursor(_worldScratch[0], _worldScratch[1]);
  }
}
