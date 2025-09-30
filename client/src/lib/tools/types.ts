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
 * PerfectShapePreview is the preview data for perfect shapes (line, circle, box)
 * Used by DrawingTool and overlay rendering
 * NEW: Perfect Shape preview is inputs (anchors + live cursor),
 * not final geometry. The renderer computes geometry.
 */
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box';

  // Tool styling frozen at pointer-down
  color: string;
  size: number;
  opacity: number;

  // Inputs in WORLD space:
  // - anchors: frozen the moment we snap (shape-specific)
  // - cursor: live pointer in world units
  anchors:
    | { kind: 'line';   A: [number, number] }                // line: fixed A
    | { kind: 'circle'; center: [number, number] }           // circle: fixed center
    | { kind: 'box';    cx: number; cy: number; angle: number; hx0: number; hy0: number }; // box: frozen OBB seed
  cursor: [number, number];

  // Overlay previews never carry a bbox (base canvas ignores them)
  bbox: null;
}

/**
 * PreviewData is the union type for all preview types
 * Discriminated by 'kind' field
 */
export type PreviewData = StrokePreview | EraserPreview | TextPreview | PerfectShapePreview;
