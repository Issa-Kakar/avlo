/**
 * Tool Registry - Self-Constructing Tool Singletons
 *
 * This module creates and manages tool singletons at module load time.
 * Tools are never constructed/destroyed on tool switch - they persist
 * for the lifetime of the application.
 *
 * Key principles:
 * - Tools self-construct at import time (no CanvasRuntime ownership)
 * - All tools implement PointerTool interface
 * - Pan IS a tool in the registry (for both dedicated mode and MMB)
 * - getCurrentTool() reads from device-ui-store
 *
 * @module canvas/tool-registry
 */

import { DrawingTool } from '@/tools/DrawingTool';
import { EraserTool } from '@/tools/EraserTool';
import { TextTool } from '@/tools/TextTool';
import { PanTool } from '@/tools/PanTool';
import { SelectTool } from '@/tools/selection/SelectTool';
import { ConnectorTool } from '@/tools/ConnectorTool';
import { CodeTool } from '@/tools/CodeTool';
import { useDeviceUIStore, type Tool as ToolId } from '@/stores/device-ui-store';
import type { PointerTool, PreviewData } from '@/tools/types';

// ===========================================
// SINGLETONS - Constructed at module load
// ===========================================

const drawingTool = new DrawingTool();
const eraserTool = new EraserTool();
const textTool = new TextTool();
const panTool = new PanTool();
const selectTool = new SelectTool();
const connectorTool = new ConnectorTool();
const codeTool = new CodeTool();

// ===========================================
// TOOL LOOKUP
// ===========================================

/**
 * Map from tool ID to tool instance.
 * 'pen', 'highlighter', 'shape' all map to DrawingTool (handles mode internally).
 * 'image' and 'code' have no tool implementation yet (return undefined).
 */
const toolMap = new Map<ToolId, PointerTool>([
  ['pen', drawingTool],
  ['highlighter', drawingTool],
  ['shape', drawingTool],
  ['eraser', eraserTool],
  ['text', textTool],
  ['note', textTool],
  ['pan', panTool],
  ['select', selectTool],
  ['connector', connectorTool],
  ['code', codeTool],
  // 'image' intentionally omitted - no tool implementation
]);

// ===========================================
// HELPERS
// ===========================================

/**
 * Get tool by ID.
 * Returns undefined for 'image' (no implementation).
 */
export function getToolById(toolId: ToolId): PointerTool | undefined {
  return toolMap.get(toolId);
}

/**
 * Get current tool from activeTool state.
 * Returns undefined if current tool has no implementation.
 */
export function getCurrentTool(): PointerTool | undefined {
  return toolMap.get(useDeviceUIStore.getState().activeTool);
}

/**
 * Get preview from current tool.
 * Used by OverlayRenderLoop for self-managed preview.
 */
export function getActivePreview(): PreviewData | null {
  return getCurrentTool()?.getPreview() ?? null;
}

/**
 * Check if MMB pan can start.
 * - Pan must not already be active
 * - No other tool can be in an active gesture
 *
 * This allows MMB pan to interrupt idle tools but not active gestures.
 */
export function canStartMMBPan(): boolean {
  if (panTool.isActive()) return false;
  const tool = getCurrentTool();
  // If current tool is panTool, we already checked above
  // Otherwise, check if another tool is busy
  return !(tool && tool !== panTool && tool.isActive());
}

// ===========================================
// DIRECT EXPORTS
// ===========================================

/** Export panTool for direct MMB access, textTool for direct access */
export { panTool, textTool, codeTool };

/** Export all tools for testing/debugging */
export const allTools = {
  drawingTool,
  eraserTool,
  textTool,
  panTool,
  selectTool,
  connectorTool,
  codeTool,
};
