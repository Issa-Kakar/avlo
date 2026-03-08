/**
 * Cursor Tracking - Module-level last cursor position
 *
 * Same setter/getter pattern as invalidation-helpers.ts.
 * Updated by CanvasRuntime.handlePointerMove(), read by paste actions.
 *
 * @module canvas/cursor-tracking
 */

let lastCursorWorld: [number, number] | null = null;

export function setLastCursorWorld(pos: [number, number]): void {
  lastCursorWorld = pos;
}

export function getLastCursorWorld(): [number, number] | null {
  return lastCursorWorld;
}

// --- Pointer modifier state (captured at pointerdown) ---

let lastPointerShift = false;
let lastPointerCtrlOrMeta = false;

export function storePointerModifiers(e: PointerEvent): void {
  lastPointerShift = e.shiftKey;
  lastPointerCtrlOrMeta = e.ctrlKey || e.metaKey;
}

export function isShiftPointer(): boolean {
  return lastPointerShift;
}

export function isCtrlOrMetaPointer(): boolean {
  return lastPointerCtrlOrMeta;
}
