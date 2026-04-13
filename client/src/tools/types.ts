// Phase 5: Drawing Tool Types

import type { BBoxTuple, FrameTuple } from '@/core/types/geometry';

/**
 * HandleId identifies resize handles at selection corners and sides
 * Corners: nw = northwest (top-left), ne = northeast (top-right), etc.
 * Sides: n = north (top), e = east (right), s = south (bottom), w = west (left)
 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

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
 * PerfectShapeAnchors defines anchor points for each shape type
 */
export type PerfectShapeAnchors =
  | { kind: 'line'; A: [number, number] } // line: fixed A
  | { kind: 'circle'; center: [number, number] } // circle: fixed center (hold detector)
  | { kind: 'box'; cx: number; cy: number; angle: number; hx0: number; hy0: number } // box: frozen AABB seed (hold detector)
  | { kind: 'rect'; A: [number, number] } // corner-anchored AABB
  | { kind: 'ellipseRect'; A: [number, number] } // corner-anchored ellipse
  | { kind: 'diamond'; A: [number, number] } // corner-anchored diamond (toolbar)
  | { kind: 'diamondHold'; cx: number; cy: number; hx0: number; hy0: number }; // center-anchored diamond (hold detector)

/**
 * PerfectShapePreview is the preview data for perfect shapes (line, circle, box)
 * Used by DrawingTool and overlay rendering
 * NEW: Perfect Shape preview is inputs (anchors + live cursor),
 * not final geometry. The renderer computes geometry.
 */
export interface PerfectShapePreview {
  kind: 'perfectShape';
  shape: 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'diamond' | 'diamondHold';
  fill?: boolean; // Optional fill flag for shapes

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
 * SelectionPreview is the preview data for selection tool
 * Used by SelectTool and overlay rendering
 */
export interface SelectionPreview {
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
}

/**
 * ConnectorPreview is the preview data for connector tool
 * Used by ConnectorTool and overlay rendering
 *
 * DESIGN: Anchor dots ONLY appear when snapping would occur.
 * If snapShapeId is set, the user WILL connect to this shape on release.
 */
export interface ConnectorPreview {
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

  // === Anchor visualization ===
  // ONLY set when actually snapped - dots appear when snapped

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
}

/**
 * PreviewData is the union type for all preview types
 * Discriminated by 'kind' field
 */
export type PreviewData = StrokePreview | EraserPreview | PerfectShapePreview | SelectionPreview | ConnectorPreview;

/**
 * PointerTool - Interface for tools that handle pointer gestures.
 * All methods required. Use no-ops where not applicable.
 *
 * All tools receive world coordinates from CanvasRuntime.
 * Tools that need screen coordinates (like PanTool for delta calculation)
 * convert internally using worldToCanvas().
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
