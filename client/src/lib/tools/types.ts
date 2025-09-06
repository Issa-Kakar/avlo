// Phase 5: Drawing Tool Types

// Import type from Zustand store for adapter
import type { ToolbarState } from '@/stores/device-ui-store';

export interface DrawingToolConfig {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

export interface DrawingState {
  isDrawing: boolean;
  pointerId: number | null;
  points: number[]; // [x,y, x,y, ...] in world coordinates

  // Tool settings frozen at gesture start
  config: DrawingToolConfig;
  startTime: number;
}

/**
 * PreviewData is the single source of truth for preview structure
 * Used by both DrawingTool and RenderLoop
 */
export interface PreviewData {
  points: ReadonlyArray<number>; // [x,y, x,y, ...] in world coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // World units
  opacity: number;
  bbox: [number, number, number, number] | null; // Used for dirty rect tracking
}

// Simplified device UI for Phase 5 (no Zustand yet)
export interface DeviceUIState {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

/**
 * Guarded adapter function to convert from Zustand ToolbarState to DrawingTool's DeviceUIState.
 * This ensures DrawingTool only receives valid tools it can handle while allowing
 * the UI to have additional tools that aren't yet implemented.
 *
 * Phase 6-7 Integration: Bridges the gap between full toolbar state and drawing capabilities
 */
export function toolbarToDeviceUI(toolbar: ToolbarState): DeviceUIState {
  // Guard tool selection - default unknown tools to 'pen'
  // DrawingTool only supports pen and highlighter in Phase 5-6
  let tool: 'pen' | 'highlighter' = 'pen';
  if (toolbar.tool === 'pen' || toolbar.tool === 'highlighter') {
    tool = toolbar.tool;
  }

  // Clamp size to reasonable range (1-64 pixels)
  // This prevents extreme values that could cause rendering issues
  const size = Math.max(1, Math.min(64, toolbar.size || 4));

  // Validate color format (default to black if invalid)
  // Expects #RRGGBB format
  const color = /^#[0-9A-Fa-f]{6}$/.test(toolbar.color) ? toolbar.color : '#000000';

  // Clamp opacity to valid range [0, 1]
  // Note: Highlighter opacity is enforced at render time (0.25) regardless of this value
  const opacity = Math.max(0, Math.min(1, toolbar.opacity || 1));

  return { tool, color, size, opacity };
}
