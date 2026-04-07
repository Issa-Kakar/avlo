/**
 * Cursor Tracking - Module-level last cursor world position
 *
 * Updated by CanvasRuntime.handlePointerMove(), read by paste actions
 * for cursor-position placement.
 *
 * Modifier key state lives in InputManager (not here).
 *
 * @module runtime/cursor-tracking
 */

let lastCursorWorld: [number, number] | null = null;

export function setLastCursorWorld(pos: [number, number]): void {
  lastCursorWorld = pos;
}

export function getLastCursorWorld(): [number, number] | null {
  return lastCursorWorld;
}
