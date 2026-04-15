import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';

/**
 * HandleId identifies resize handles at selection corners and sides.
 * Corners: nw/ne/se/sw. Sides: n/e/s/w.
 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/**
 * Shape types the DrawingTool previews and commits.
 *
 * - `'rect' | 'ellipse' | 'diamond' | 'roundedRect'` are stored as shape objects
 *   on the Y.Doc (frame-based).
 * - `'line'` is tool-layer only: previewed as a clean 2-point segment via direct
 *   `ctx.stroke` and committed as a 2-point stroke — the data model has no line kind.
 */
export type ShapeType = 'rect' | 'ellipse' | 'diamond' | 'roundedRect' | 'line';

/** Freehand pen/highlighter preview. */
export type StrokePreview = {
  kind: 'stroke';
  tool: 'pen' | 'highlighter';
  points: Point[];
  color: string;
  size: number;
  opacity: number;
};

/** Eraser dim preview. */
export type EraserPreview = {
  kind: 'eraser';
  /** Center in world coords; overlay does worldToCanvas() */
  circle: { cx: number; cy: number; r_px: number };
  hitIds: string[];
  dimOpacity: number;
};

/**
 * Shape preview — discriminated on `shapeType`. The tool owns all geometry:
 *   - For framed shapes, the final `frame` is computed by DrawingTool (corner-drag
 *     via `cornerFrame`, hold-snap via `scaleBBoxAround` of the stroke bbox).
 *     The renderer just paints it via `buildShapePathFromFrame`.
 *   - For line, the tool passes endpoints `a` (fixed first stroke point) and
 *     `b` (live cursor); the renderer draws `ctx.moveTo/lineTo/stroke`.
 */
export type ShapePreview =
  | {
      kind: 'shape';
      shapeType: 'line';
      a: Point;
      b: Point;
      color: string;
      width: number;
      opacity: number;
    }
  | {
      kind: 'shape';
      shapeType: 'rect' | 'ellipse' | 'diamond' | 'roundedRect';
      frame: FrameTuple;
      color: string;
      width: number;
      opacity: number;
      fill: boolean;
    };

/** Selection overlay preview. */
export type SelectionPreview = {
  kind: 'selection';
  /** Selection bounds in world coords (with transform applied for preview) */
  selectionBounds: BBoxTuple | null;
  /** Marquee rect in world coords (anchor to current point) */
  marqueeRect: BBoxTuple | null;
  /** Handle positions for resize (world coords) */
  handles: { id: HandleId; x: number; y: number }[] | null;
  /** Whether currently transforming (to hide handles during drag) */
  isTransforming: boolean;
  /** IDs of selected objects (for rendering selection highlight) */
  selectedIds: string[];
  /** Always null for overlay previews */
  bbox: null;
};

/**
 * ConnectorPreview is the preview data for connector tool.
 * Anchor dots ONLY appear when snapping would occur.
 */
export type ConnectorPreview = {
  kind: 'connector';

  // === Main connector path (world coords) ===
  /** Full routed path including endpoints and waypoints */
  points: [number, number][];

  // === Styling ===
  color: string;
  width: number;
  opacity: number;
  startCap: 'arrow' | 'none';
  endCap: 'arrow' | 'none';

  // === Anchor visualization — only set when actually snapped ===

  /** Shape we're snapped to (null = not snapped, dots won't show) */
  snapShapeId: string | null;
  /** Frame of snapped shape [x, y, w, h] for dot placement */
  snapShapeFrame: FrameTuple | null;
  /** Shape type for proper dot placement ('rect' | 'ellipse' | 'diamond') */
  snapShapeType: string | null;
  /** Which midpoint is active (snapped to t=0.5) */
  activeMidpointSide: 'N' | 'E' | 'S' | 'W' | null;
  /** Which edge we're snapped to (N/E/S/W, null = not snapped) */
  snapSide: 'N' | 'E' | 'S' | 'W' | null;
  /** Pre-offset snap position on shape edge - actual dot location (null = not snapped) */
  snapPosition: [number, number] | null;

  // === Endpoint states ===
  /** True if 'from' endpoint is attached to a shape */
  fromIsAttached: boolean;
  /** Position of 'from' endpoint in world coords */
  fromPosition: [number, number] | null;
  /** True if 'to' endpoint is attached to a shape */
  toIsAttached: boolean;
  /** Position of 'to' endpoint in world coords */
  toPosition: [number, number] | null;

  // === Straight connector fields ===
  /** Connector routing type */
  connectorType: 'elbow' | 'straight';
  /** Interior anchor position for dashed start guide (straight only) */
  startDashTo: [number, number] | null;
  /** Interior anchor position for dashed end guide (straight only) */
  endDashTo: [number, number] | null;
  /** True when snapped to shape center (straight only) */
  isCenterSnap: boolean;

  /** Always null for overlay previews */
  bbox: null;
};

/** Discriminated union of all preview variants. */
export type PreviewData = StrokePreview | EraserPreview | ShapePreview | SelectionPreview | ConnectorPreview;

/**
 * PointerTool — interface for tools that handle pointer gestures.
 * All tools receive world coordinates from CanvasRuntime.
 */
export interface PointerTool {
  /** Returns true if the tool can begin a new gesture */
  canBegin(): boolean;

  /** Begin a gesture at the given world coordinates */
  begin(pointerId: number, worldX: number, worldY: number): void;

  /** Update during gesture with current world coordinates (also handles hover when idle) */
  move(worldX: number, worldY: number): void;

  /** End the gesture, optionally with final world coordinates */
  end(worldX?: number, worldY?: number): void;

  /** Cancel the gesture without committing */
  cancel(): void;

  /** Returns true if a gesture is currently in progress */
  isActive(): boolean;

  /** Returns the pointer ID for the active gesture, or null if idle */
  getPointerId(): number | null;

  /** Returns preview data for overlay rendering, or null if no preview */
  getPreview(): PreviewData | null;

  /** Called when pointer leaves the canvas - clear any hover state */
  onPointerLeave(): void;

  /** Called when view transform changes (pan/zoom) - update any position-dependent state */
  onViewChange(): void;

  /** Cleanup when tool is destroyed */
  destroy(): void;
}
