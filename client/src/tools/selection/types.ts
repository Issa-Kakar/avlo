/**
 * Shared types for the selection subsystem.
 * Single home for SelectionKind, TransformState, ConnectorTopology, SelectedStyles, etc.
 */

import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectKind } from '@/core/types/objects';
import type { HandleId } from '@/core/types/handles';
import type { TextAlign, TextAlignV, FontFamily, CodeLanguage } from '@/core/accessors';
import type { SnapTarget } from '@/core/connectors/types';

// ============================================================================
// Selection Composition
// ============================================================================

/**
 * Selection kind: the ObjectKind of a homogeneous selection, or 'none' / 'mixed'.
 * Replaces the previous `'strokesOnly' | 'shapesOnly' | ...` encoding.
 */
export type SelectionKind = ObjectKind | 'none' | 'mixed';

/** Interaction paradigm: determines UI affordances. */
export type SelectionMode = 'none' | 'standard' | 'connector';

/**
 * Per-kind selection counts, keyed by `ObjectKind`.
 * Matches the selectionKind taxonomy exactly — no plural aliases.
 */
export type KindCounts = Record<ObjectKind, number> & { total: number };

export const EMPTY_KIND_COUNTS: KindCounts = {
  stroke: 0,
  shape: 0,
  text: 0,
  connector: 0,
  code: 0,
  image: 0,
  note: 0,
  bookmark: 0,
  total: 0,
};

// ============================================================================
// Selected Styles
// ============================================================================

export interface SelectedStyles {
  /** First object's stroke/border color. Used by all kinds. */
  color: string;
  /** Multiple different stroke colors detected. Used by strokes, shapes, connectors. */
  colorMixed: boolean;
  /** Second stroke color for split indicator. Only set when colorMixed. */
  colorSecond: string | null;
  /** Uniform stroke width, null if mixed. Used by strokes, shapes, connectors. */
  width: number | null;
  /** First shape's fill color, null = no fill. Used by shapesOnly. Kept even when mixed. */
  fillColor: string | null;
  /** Multiple different fill colors detected. Used by shapesOnly. */
  fillColorMixed: boolean;
  /** Second fill color for split indicator. Only set when fillColorMixed. */
  fillColorSecond: string | null;
  /** Uniform shape type, 'text' for textOnly, null if mixed. Used by shapesOnly, textOnly. */
  shapeType: string | null;
  /** First text object's fontSize (rounded). Used by textOnly. */
  fontSize: number | null;
  /** Uniform text alignment, null if mixed. Used by textOnly, notesOnly. */
  textAlign: TextAlign | null;
  /** Uniform vertical alignment, null if mixed. Used by notesOnly. */
  textAlignV: TextAlignV | null;
  /** First text object's font family. Used by textOnly, shapesOnly. */
  fontFamily: FontFamily | null;
  /** Text color for text objects or shape labels. Used by textOnly, shapesOnly. */
  labelColor: string | null;
  /** Code block language. Used by codeOnly. */
  codeLanguage: CodeLanguage | null;
  /** Code block header visibility. Used by codeOnly. */
  codeHeaderVisible: boolean | null;
  /** Code block output visibility. Used by codeOnly. */
  codeOutputVisible: boolean | null;
}

export const EMPTY_STYLES: SelectedStyles = {
  color: '#262626',
  colorMixed: false,
  colorSecond: null,
  width: null,
  fillColor: null,
  fillColorMixed: false,
  fillColorSecond: null,
  shapeType: null,
  fontSize: null,
  textAlign: null,
  textAlignV: null,
  fontFamily: null,
  labelColor: null,
  codeLanguage: null,
  codeHeaderVisible: null,
  codeOutputVisible: null,
};

export interface InlineStyles {
  bold: boolean;
  italic: boolean;
  highlightColor: string | null;
}

export const EMPTY_INLINE_STYLES: InlineStyles = {
  bold: false,
  italic: false,
  highlightColor: null,
};

// ============================================================================
// Transform State Discriminant
// ============================================================================

export interface TranslateTransform {
  kind: 'translate';
}

export interface ScaleTransform {
  kind: 'scale';
  /** handle-to-origin vector; feeds rawScaleFactors each move */
  initialDelta: Point;
  /** cursor-to-handle offset at gesture start; stays constant so the grabbed pixel tracks the cursor */
  clickOffset: Point;
}

/**
 * Endpoint drag transform: dragging a single connector endpoint.
 * Fundamentally different from translate/scale - operates on ONE connector, ONE endpoint.
 */
export interface EndpointDragTransform {
  kind: 'endpointDrag';
  connectorId: string;
  endpoint: 'start' | 'end';

  /** Current world position (snapped or free cursor) */
  currentPosition: [number, number];
  /** Current snap target (for commit and overlay rendering) */
  currentSnap: SnapTarget | null;

  /** Rerouted path (updated on each move via rerouteConnector) */
  routedPoints: [number, number][] | null;
  /** Bbox of routedPoints (for dirty rect) */
  routedBbox: BBoxTuple | null;

  /** Previous frame's bbox for dirty rect invalidation (seeded from original bbox) */
  prevBbox: BBoxTuple;
}

export type TransformState = { kind: 'none' } | TranslateTransform | ScaleTransform | EndpointDragTransform;

// ============================================================================
// Scale Context (consumed by both transform.ts dispatch and scale-system atoms)
// ============================================================================

/**
 * Per-gesture scale context: cursor factors + handle/origin/bounds.
 * Lives here (selection layer) so pure-geometry atoms in `core/geometry/scale-system.ts`
 * can take it as a parameter without re-bundling its fields.
 */
export interface ScaleCtx {
  sx: number;
  sy: number;
  origin: Point;
  selBounds: BBoxTuple;
  handleId: HandleId;
}

// ============================================================================
// Marquee State
// ============================================================================

export interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null; // World coords
  current: [number, number] | null; // World coords
}

// ============================================================================
// Connector Topology
// ============================================================================

/**
 * Per-endpoint override spec:
 *   null   = canonical (no override — endpoint stays at Y.Map stored value)
 *   string = frame override (value is the shapeId whose frame to transform)
 *   true   = free position override (apply transform to original position)
 */
export type EndpointSpec = string | true | null;

export interface ConnectorTopologyEntry {
  connectorId: string;
  strategy: 'translate' | 'reroute';
  originalPoints: [number, number][];
  originalBbox: BBoxTuple;
  translatedPoints: [number, number][]; // pre-allocated, mutated per-frame (translate only)
  startSpec: EndpointSpec; // only meaningful for 'reroute'
  endSpec: EndpointSpec; // only meaningful for 'reroute'
}

/**
 * Connector topology computed once at transform begin.
 * Store-owned: entries/sets/maps are immutable after construction.
 * Mutable caches (reroutes, prevBboxes) are .set() per frame with no new allocations.
 */
export interface ConnectorTopology {
  /** All topology entries (translate + reroute) */
  entries: ConnectorTopologyEntry[];
  /** O(1) lookup: is this connector translateOnly? */
  translateIdSet: Set<string>;
  /** Original frames of selected shapes (for frame overrides) */
  originalFrames: Map<string, FrameTuple>;

  /** connectorId → rerouted points (mutable per-frame cache) */
  reroutes: Map<string, [number, number][] | null>;
  /** connectorId → previous frame bbox (mutable per-frame cache) */
  prevBboxes: Map<string, BBoxTuple>;
}
