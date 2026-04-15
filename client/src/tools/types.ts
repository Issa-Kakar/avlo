import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { SnapTarget } from '@/core/connectors/types';

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
 * ConnectorPreview — the bare minimum the renderer can't derive.
 *
 * Style (color/width/opacity/caps/type) is pulled live from `device-ui-store`
 * at draw time. Snap target shape/frame/type and dashed-guide endpoints are
 * derived in the renderer from `hoverSnap` / `fromSnap` via anchor-atoms.
 */
export type ConnectorPreview = {
  kind: 'connector';
  /** Full routed path (the one thing the renderer can't derive). */
  points: [number, number][];
  /** Start-side attachment — drives start dashed guide. No anchor dot is drawn on this side. */
  fromSnap: SnapTarget | null;
  /** Current hover/target snap — drives target highlight, midpoint dots, and end dashed guide. */
  hoverSnap: SnapTarget | null;
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
