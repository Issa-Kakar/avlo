/**
 * Shared types for the selection subsystem.
 * Single home for SelectionKind, TransformState, SelectedStyles, etc.
 */

import type { CodeLanguage, FontFamily, TextAlign, TextAlignV } from '@/core/accessors';
import type { Slot } from '@/core/connectors/reroute-connector';
import type { SnapTarget } from '@/core/connectors/types';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { HandleId } from '@/core/types/handles';
import type { ObjectKind } from '@/core/types/objects';

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
  /** Multiple different stroke colors detected. Used by strokes and connectors. */
  colorMixed: boolean;
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
 *
 * Renderer-and-overlay-only fields. The buffer + bbox + RouteContext live on
 * `TransformController.endpointDrag` (one source of truth for active gesture
 * state). The renderer reads the synthetic `EndpointDragEntry` directly via
 * `getEndpointDragEntry()`; the overlay reads `currentPosition`/`currentSnap`
 * here for the dragged-dot + snap feedback.
 */
export interface EndpointDragTransform {
  kind: 'endpointDrag';
  connectorId: string;
  /** Which endpoint is being dragged. 0 = start, 1 = end. */
  slot: Slot;
  /** Cursor position when not snapped; equals `snap.position` when snapped. */
  currentPosition: [number, number];
  /** Current snap target (drives overlay snap feedback + commit anchor record). */
  currentSnap: SnapTarget | null;
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
