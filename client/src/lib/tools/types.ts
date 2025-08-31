// Phase 5: Drawing Tool Types

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
