/**
 * Cursor Manager - Centralized cursor control
 *
 * Manages canvas cursor state with priority system:
 * 1. Manual override (e.g., 'grabbing' during pan)
 * 2. Tool-based cursor (computed from activeTool)
 *
 * @module canvas/cursor-manager
 */

import { getCanvasElement } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';

/** Manual cursor override (e.g., 'grabbing' during pan) */
let override: string | null = null;

/**
 * Set a cursor override that takes priority over tool-based cursor.
 * Pass null to clear override.
 */
export function setCursorOverride(cursor: string | null): void {
  override = cursor;
  applyCursor();
}

/**
 * Get the current cursor override (for debugging/inspection).
 */
export function getCursorOverride(): string | null {
  return override;
}

/**
 * Compute the appropriate cursor based on active tool.
 */
function computeBaseCursor(): string {
  const { activeTool } = useDeviceUIStore.getState();
  switch (activeTool) {
    case 'eraser':
      return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan':
      return 'grab';
    case 'select':
      return 'default';
    case 'text':
      return 'text';
    default:
      return 'crosshair';
  }
}

/**
 * Apply the current cursor to the canvas element.
 * Priority: override > tool-based cursor
 */
export function applyCursor(): void {
  const canvas = getCanvasElement();
  if (!canvas) return;
  canvas.style.cursor = override ?? computeBaseCursor();
}
