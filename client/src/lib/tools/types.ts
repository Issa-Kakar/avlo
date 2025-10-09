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
  points: number[];             // flat centerline [x,y, x,y, ...] for commit/simplify
  pointsPF: [number, number][]; // PF-native live buffer [[x,y], [x,y], ...] for preview only

  // Tool settings frozen at gesture start
  config: DrawingToolConfig;
  startTime: number;
}

/**
 * StrokePreview is the preview data for drawing strokes
 * Used by DrawingTool and RenderLoop
 * IMPORTANT: Points are PF-native tuples to avoid per-frame conversions in overlay
 */
export interface StrokePreview {
  kind: 'stroke'; // Discriminant for union type
  points: [number, number][]; // PF-native tuples: [[x,y], [x,y], ...] in world coordinates
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
 * PerfectShapeAnchors defines anchor points for each shape type
 */
export type PerfectShapeAnchors =
  | { kind: 'line';        A: [number, number] }                                             // line: fixed A
  | { kind: 'circle';      center: [number, number] }                                        // circle: fixed center (hold detector)
  | { kind: 'box';         cx: number; cy: number; angle: number; hx0: number; hy0: number } // box: frozen OBB seed (hold detector)
  | { kind: 'rect';        A: [number, number] }                                             // corner-anchored AABB
  | { kind: 'ellipseRect'; A: [number, number] }                                             // corner-anchored ellipse
  | { kind: 'arrow';       A: [number, number] };                                            // arrow: fixed start point

/**
 * PerfectShapePreview is the preview data for perfect shapes (line, circle, box)
 * Used by DrawingTool and overlay rendering
 * NEW: Perfect Shape preview is inputs (anchors + live cursor),
 * not final geometry. The renderer computes geometry.
 */
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';

  // Tool styling frozen at pointer-down
  color: string;
  size: number;
  opacity: number;

  // Inputs in WORLD space:
  // - anchors: frozen the moment we snap (shape-specific)
  // - cursor: live pointer in world units
  anchors: PerfectShapeAnchors;
  cursor: [number, number];

  // Overlay previews never carry a bbox (base canvas ignores them)
  bbox: null;
}

/**
 * StrokeFinalPreview is the final frame preview with pre-computed outline
 * Used for the held frame to match base canvas exactly
 */
export interface StrokeFinalPreview {
  kind: 'strokeFinal';
  outline: [number, number][]; // Pre-computed PF outline
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  bbox: [number, number, number, number] | null;
}
/**
 * PreviewData is the union type for all preview types
 * Discriminated by 'kind' field
 */
export type PreviewData = StrokePreview | StrokeFinalPreview | EraserPreview | TextPreview | PerfectShapePreview;
