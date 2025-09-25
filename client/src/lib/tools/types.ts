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
 * StrokePreview is the preview data for drawing strokes
 * Used by DrawingTool and RenderLoop
 */
export interface StrokePreview {
  kind: 'stroke'; // Discriminant for union type
  points: ReadonlyArray<number>; // [x,y, x,y, ...] in world coordinates
  tool: 'pen' | 'highlighter';
  color: string;
  size: number; // World units
  opacity: number;
  bbox: [number, number, number, number] | null; // Used for dirty rect tracking
}

/**
 * EraserPreview is the preview data for eraser tool
 * Used by EraserTool and overlay rendering
 */
export interface EraserPreview {
  kind: 'eraser';
  /** Center in world coords; overlay does worldToCanvas() */
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
}

/**
 * TextPreview is the preview data for text tool
 * Used by TextTool and overlay rendering
 */
export interface TextPreview {
  kind: 'text';
  box: { x: number; y: number; w: number; h: number }; // World coords
  content?: string; // Optional preview content
  isPlacing?: boolean; // True when placing, false when editing
}

/**
 * StampPreview is the preview data for stamp tool
 * Used by StampTool and overlay rendering
 */
export interface StampPreview {
  kind: 'stamp';
  position: { x: number; y: number }; // World coords
  stampType: 'circle' | 'square' | 'triangle' | 'star' | 'heart'; // Basic shapes
  size: number; // World units (base 32px * scale)
  color: string; // Fill color
  opacity: number;
}

/**
 * PreviewData is the union type for all preview types
 * Discriminated by 'kind' field
 */
export type PreviewData = StrokePreview | EraserPreview | TextPreview | StampPreview;

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
