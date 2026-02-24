import { create } from 'zustand';
import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds, FrameTuple, ObjectHandle } from '@avlo/shared';
import type { SnapTarget } from '@/lib/connectors/types';
import { getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import {
  getFrame, getPoints, getStart, getEnd,
  getStartAnchor, getEndAnchor, bboxTupleToWorldBounds,
  getColor, getWidth, getFillColor, getFontSize, getAlign,
  type TextAlign,
} from '@avlo/shared';
import { getTextFrame } from '@/lib/text/text-system';
import { expandEnvelope, frameTupleToWorldBounds } from '@/lib/geometry/bounds';

// === Types ===

/**
 * WorldRect is an alias for WorldBounds from the shared package.
 * @deprecated Prefer using WorldBounds directly from @avlo/shared
 */
export type WorldRect = WorldBounds;

// Selection composition types for context-aware transforms
export type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'textOnly' | 'connectorsOnly' | 'mixed';

export interface KindCounts {
  strokes: number; shapes: number; text: number; connectors: number; total: number;
}
export interface IdsByKind {
  strokes: string[]; shapes: string[]; text: string[]; connectors: string[];
}
export interface SelectedStyles {
  color: string;
  colorMixed: boolean;
  colorSecond: string | null;
  width: number | null;
  fillColor: string | null;
  fontSize: number | null;
  textAlign: TextAlign | null;
}

// Empty constants (shared references to avoid allocation)
const EMPTY_STYLES: SelectedStyles = {
  color: '#262626', colorMixed: false, colorSecond: null,
  width: null, fillColor: null, fontSize: null, textAlign: null,
};
const EMPTY_KIND_COUNTS: KindCounts = { strokes: 0, shapes: 0, text: 0, connectors: 0, total: 0 };
const EMPTY_IDS_BY_KIND: IdsByKind = { strokes: [], shapes: [], text: [], connectors: [] };
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

export type HandleKind = 'corner' | 'side';

// Interaction mode: determines what UI affordances are shown
export type SelectionMode = 'none' | 'standard' | 'connector';

// === Connector Topology ===

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
  originalBbox: WorldBounds;
  startSpec: EndpointSpec;  // only meaningful for 'reroute'
  endSpec: EndpointSpec;    // only meaningful for 'reroute'
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
  prevBboxes: Map<string, WorldBounds>;
}

// === Transform Types ===

export interface TranslateTransform {
  kind: 'translate';
  dx: number;
  dy: number;
  originBounds: WorldRect;  // Bounds before transform started
}

export interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];  // Fixed point during scale
  scaleX: number;
  scaleY: number;
  originBounds: WorldRect;   // Geometry-based bounds (for position math - no stroke padding)
  bboxBounds: WorldRect;     // Padded bounds (for dirty rect invalidation)
  handleId: HandleId;  // Track which handle for uniform vs directional scaling
  selectionKind: SelectionKind;  // Selection composition for context-aware behavior
  handleKind: HandleKind;        // Corner vs side handle
  initialDelta: [number, number];  // Distance from origin to initial click (for scale=1.0 at start)
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
  routedBbox: WorldBounds | null;

  /** Previous frame's bbox for dirty rect invalidation (seeded from original bbox) */
  prevBbox: WorldBounds;
}

export type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform
  | EndpointDragTransform;

export interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null;  // World coords
  current: [number, number] | null; // World coords
}

// === State Interface ===

export interface SelectionState {
  selectedIds: string[];
  /** Interaction paradigm: determines UI affordances (handles vs endpoint dots) */
  mode: SelectionMode;
  /** Cached selection composition (recomputed on setSelection) */
  selectionKind: SelectionKind;
  /** O(1) lookup for observer bridge intersection checks */
  selectedIdSet: ReadonlySet<string>;
  /** Per-kind counts for mixed filter dropdown */
  kindCounts: KindCounts;
  /** Per-kind ID lists for filterByKind action */
  idsByKind: IdsByKind;
  /** Single boolean: true when context menu should be visible */
  menuActive: boolean;
  /** Live style snapshot of selected objects */
  selectedStyles: SelectedStyles;
  /** Bumped on bbox changes to selected objects (for repositioning) */
  boundsVersion: number;
  transform: TransformState;
  marquee: MarqueeState;
  /** Connector topology during translate/scale transforms */
  connectorTopology: ConnectorTopology | null;

  // Text editing - primitives only
  /** Object ID being edited, null if not editing */
  textEditingId: string | null;
  /** True if this text object was just created (for empty deletion on blur) */
  textEditingIsNew: boolean;
}

// === Actions Interface ===

export interface SelectionActions {
  // Selection management
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;

  // Transform lifecycle
  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (bboxBounds: WorldRect, transformBounds: WorldRect, origin: [number, number], handleId: HandleId, initialDelta: [number, number]) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

  // Endpoint drag lifecycle
  beginEndpointDrag: (connectorId: string, endpoint: 'start' | 'end', originBbox: WorldBounds) => void;
  updateEndpointDrag: (currentPosition: [number, number], currentSnap: SnapTarget | null, routedPoints: [number, number][] | null, routedBbox: WorldBounds | null) => void;

  // Marquee lifecycle
  beginMarquee: (anchor: [number, number]) => void;
  updateMarquee: (current: [number, number]) => void;
  endMarquee: () => void;
  cancelMarquee: () => void;

  // Text editing actions
  /** Begin text editing (objectId, isNew flag for empty deletion) */
  beginTextEditing: (objectId: string, isNew: boolean) => void;
  /** End text editing */
  endTextEditing: () => void;

  // Context menu support
  refreshStyles: () => void;
  onObjectMutation: (touchedIds: Set<string>, deletedIds: Set<string>, bboxChangedIds: Set<string>) => void;
  filterByKind: (kind: keyof IdsByKind) => void;
}

export type SelectionStore = SelectionState & SelectionActions;

// === Selection Composition ===

/**
 * Single-pass composition from selected IDs.
 * Buckets IDs by kind, builds selectedIdSet, derives selectionKind and mode.
 */
function computeSelectionComposition(ids: string[]) {
  const snapshot = getCurrentSnapshot();
  const strokes: string[] = [];
  const shapes: string[] = [];
  const text: string[] = [];
  const connectors: string[] = [];
  const selectedIdSet = new Set<string>();

  for (const id of ids) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    selectedIdSet.add(id);
    switch (handle.kind) {
      case 'stroke': strokes.push(id); break;
      case 'shape': shapes.push(id); break;
      case 'text': text.push(id); break;
      case 'connector': connectors.push(id); break;
    }
  }

  const kindCounts: KindCounts = {
    strokes: strokes.length, shapes: shapes.length,
    text: text.length, connectors: connectors.length,
    total: selectedIdSet.size,
  };
  const idsByKind: IdsByKind = { strokes, shapes, text, connectors };

  const nonZero = (kindCounts.strokes > 0 ? 1 : 0)
    + (kindCounts.shapes > 0 ? 1 : 0)
    + (kindCounts.text > 0 ? 1 : 0)
    + (kindCounts.connectors > 0 ? 1 : 0);

  let selectionKind: SelectionKind;
  if (nonZero === 0) selectionKind = 'none';
  else if (nonZero > 1) selectionKind = 'mixed';
  else if (kindCounts.strokes > 0) selectionKind = 'strokesOnly';
  else if (kindCounts.shapes > 0) selectionKind = 'shapesOnly';
  else if (kindCounts.text > 0) selectionKind = 'textOnly';
  else selectionKind = 'connectorsOnly';

  const mode: SelectionMode =
    selectedIdSet.size === 1 && selectionKind === 'connectorsOnly'
      ? 'connector'
      : selectedIdSet.size > 0 ? 'standard' : 'none';

  return { selectionKind, kindCounts, idsByKind, selectedIdSet, mode };
}

// === Style Computation ===

/**
 * Compute unified style snapshot for a homogeneous selection.
 * Mixed selections → EMPTY_STYLES immediately (zero parsing).
 * Single-pass with early break once all fields are resolved.
 */
function computeStyles(
  ids: string[],
  kind: SelectionKind,
  objectsById: ReadonlyMap<string, ObjectHandle>,
): SelectedStyles {
  if (kind === 'none' || kind === 'mixed' || ids.length === 0) return EMPTY_STYLES;

  const trackWidth = kind !== 'textOnly';
  const trackFill = kind === 'shapesOnly';
  const trackText = kind === 'textOnly';

  let firstColor: string | null = null;
  let colorMixed = false;
  let colorSecond: string | null = null;
  let firstWidth: number | null = null;
  let widthMixed = false;
  let firstFill: string | null = null;
  let fillMixed = false;
  let firstFontSize: number | null = null;
  let fontSizeMixed = false;
  let firstAlign: TextAlign | null = null;
  let alignMixed = false;
  let first = true;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;

    if (first) {
      firstColor = getColor(handle.y);
      if (trackWidth) firstWidth = getWidth(handle.y);
      if (trackFill) firstFill = getFillColor(handle.y) ?? null;
      if (trackText) { firstFontSize = Math.round(getFontSize(handle.y)); firstAlign = getAlign(handle.y); }
      first = false;
      continue;
    }

    if (!colorMixed && getColor(handle.y) !== firstColor) {
      colorMixed = true;
      colorSecond = getColor(handle.y);
    }
    if (trackWidth && !widthMixed && getWidth(handle.y) !== firstWidth) widthMixed = true;
    if (trackFill && !fillMixed && (getFillColor(handle.y) ?? null) !== firstFill) fillMixed = true;
    if (trackText && !fontSizeMixed && Math.round(getFontSize(handle.y)) !== firstFontSize) fontSizeMixed = true;
    if (trackText && !alignMixed && getAlign(handle.y) !== firstAlign) alignMixed = true;

    if (colorMixed
      && (!trackWidth || widthMixed)
      && (!trackFill || fillMixed)
      && (!trackText || (fontSizeMixed && alignMixed))) break;
  }

  return {
    color: firstColor ?? '#262626',
    colorMixed,
    colorSecond: colorMixed ? colorSecond : null,
    width: trackWidth ? (widthMixed ? null : firstWidth) : null,
    fillColor: trackFill ? (fillMixed ? null : firstFill) : null,
    fontSize: trackText ? (fontSizeMixed ? null : firstFontSize) : null,
    textAlign: trackText ? (alignMixed ? null : firstAlign) : null,
  };
}

function stylesEqual(a: SelectedStyles, b: SelectedStyles): boolean {
  return a.color === b.color && a.colorMixed === b.colorMixed
    && a.colorSecond === b.colorSecond && a.width === b.width
    && a.fillColor === b.fillColor && a.fontSize === b.fontSize
    && a.textAlign === b.textAlign;
}

// === Selection Bounds ===

/**
 * Compute padded selection bounds from selected IDs.
 * Text uses derived frame (WYSIWYG-accurate), others use bbox.
 */
export function computeSelectionBounds(selectedIds: string[]): WorldBounds | null {
  if (selectedIds.length === 0) return null;

  const snapshot = getCurrentSnapshot();
  let result: WorldBounds | null = null;

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle) continue;
    if (handle.kind === 'text') {
      const frame = getTextFrame(id);
      if (frame) result = expandEnvelope(result, frameTupleToWorldBounds(frame));
      continue;
    }
    result = expandEnvelope(result, bboxTupleToWorldBounds(handle.bbox));
  }

  return result;
}

// === Menu Active Helper ===

function deriveMenuActive(
  selectedCount: number,
  textEditingId: string | null,
  transformKind: string,
  marqueeActive: boolean,
): boolean {
  return (selectedCount > 0 || textEditingId !== null)
    && transformKind === 'none'
    && !marqueeActive;
}

// === Connector Topology Builder ===

/**
 * Compute connector topology at transform begin.
 * Pure function: determines which connectors need rerouting vs translate,
 * computes per-endpoint specs, and returns ConnectorTopology.
 *
 * Strategy:
 *   Translate: both endpoints move → translate; else → reroute
 *   Scale: always → reroute
 *
 * EndpointSpec per endpoint:
 *   Anchored + shape selected → shapeId (string)
 *   Free + connector selected → true
 *   Otherwise → null (canonical)
 */
function computeConnectorTopology(
  transformKind: 'translate' | 'scale',
  selectedIds: string[]
): ConnectorTopology | null {
  const snapshot = getCurrentSnapshot();
  const selectedSet = new Set(selectedIds);

  const entries: ConnectorTopologyEntry[] = [];
  const translateIdSet = new Set<string>();
  const originalFrames = new Map<string, FrameTuple>();

  const visited = new Set<string>();

  const processConnector = (connId: string, isSelected: boolean) => {
    if (visited.has(connId)) return;
    visited.add(connId);

    const connHandle = snapshot.objectsById.get(connId);
    if (!connHandle || connHandle.kind !== 'connector') return;

    const startAnchor = getStartAnchor(connHandle.y);
    const endAnchor = getEndAnchor(connHandle.y);

    // Determine if each endpoint moves
    const startMoves = isSelected
      ? (!startAnchor || selectedSet.has(startAnchor.id))
      : (!!startAnchor && selectedSet.has(startAnchor.id));
    const endMoves = isSelected
      ? (!endAnchor || selectedSet.has(endAnchor.id))
      : (!!endAnchor && selectedSet.has(endAnchor.id));

    if (!startMoves && !endMoves) return;

    const points = getPoints(connHandle.y);
    const originalPoints: [number, number][] = points.length > 0
      ? points as [number, number][]
      : [((getStart(connHandle.y) ?? [0, 0]) as [number, number]), ((getEnd(connHandle.y) ?? [0, 0]) as [number, number])];
    const originalBbox = bboxTupleToWorldBounds(connHandle.bbox);

    // Determine strategy
    if (transformKind === 'translate' && startMoves && endMoves) {
      entries.push({
        connectorId: connId, strategy: 'translate',
        originalPoints, originalBbox, startSpec: null, endSpec: null,
      });
      translateIdSet.add(connId);
    } else {
      const startSpec: EndpointSpec =
        (startAnchor && selectedSet.has(startAnchor.id)) ? startAnchor.id :
        (!startAnchor && isSelected) ? true : null;
      const endSpec: EndpointSpec =
        (endAnchor && selectedSet.has(endAnchor.id)) ? endAnchor.id :
        (!endAnchor && isSelected) ? true : null;

      entries.push({
        connectorId: connId, strategy: 'reroute',
        originalPoints, originalBbox, startSpec, endSpec,
      });
    }
  };

  // Pass 1: Selected connectors
  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (handle?.kind === 'connector') {
      processConnector(id, true);
    }
  }

  // Pass 2: Non-selected connectors anchored to selected shapes
  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text')) continue;
    const connectors = getConnectorsForShape(id);
    if (!connectors) continue;
    for (const connId of connectors) {
      processConnector(connId, selectedSet.has(connId));
    }
  }

  if (entries.length === 0) return null;

  // Collect original frames for all selected shapes (for frame overrides)
  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text')) continue;
    const frame = handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y);
    if (frame) originalFrames.set(id, frame);
  }

  // Pre-allocate mutable caches
  const reroutes = new Map<string, [number, number][] | null>();
  const prevBboxes = new Map<string, WorldBounds>();
  for (const entry of entries) {
    if (entry.strategy === 'reroute') {
      reroutes.set(entry.connectorId, null);
      prevBboxes.set(entry.connectorId, entry.originalBbox);
    }
  }

  return {
    entries,
    translateIdSet,
    originalFrames,
    reroutes,
    prevBboxes,
  };
}

// === Store Implementation ===

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  // Initial state
  selectedIds: [],
  mode: 'none',
  selectionKind: 'none',
  selectedIdSet: EMPTY_ID_SET,
  kindCounts: EMPTY_KIND_COUNTS,
  idsByKind: EMPTY_IDS_BY_KIND,
  menuActive: false,
  selectedStyles: EMPTY_STYLES,
  boundsVersion: 0,
  transform: { kind: 'none' },
  marquee: { active: false, anchor: null, current: null },
  connectorTopology: null,
  textEditingId: null,
  textEditingIsNew: false,

  // === Selection Actions ===

  setSelection: (ids) => {
    if (ids.length === 0) {
      get().clearSelection();
      return;
    }
    const comp = computeSelectionComposition(ids);
    set({
      selectedIds: ids,
      mode: comp.mode,
      selectionKind: comp.selectionKind,
      selectedIdSet: comp.selectedIdSet,
      kindCounts: comp.kindCounts,
      idsByKind: comp.idsByKind,
      transform: { kind: 'none' },
      marquee: { active: false, anchor: null, current: null },
      connectorTopology: null,
      menuActive: true,
      boundsVersion: get().boundsVersion + 1,
    });
    get().refreshStyles();
  },

  clearSelection: () => set({
    selectedIds: [],
    mode: 'none',
    selectionKind: 'none',
    selectedIdSet: EMPTY_ID_SET,
    kindCounts: EMPTY_KIND_COUNTS,
    idsByKind: EMPTY_IDS_BY_KIND,
    menuActive: false,
    selectedStyles: EMPTY_STYLES,
    boundsVersion: 0,
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
    connectorTopology: null,
  }),

  // === Transform Actions ===

  beginTranslate: (originBounds) => {
    const { selectedIds } = get();
    const topology = computeConnectorTopology('translate', selectedIds);
    set({
      transform: { kind: 'translate', dx: 0, dy: 0, originBounds },
      connectorTopology: topology,
      menuActive: false,
    });
  },

  updateTranslate: (dx, dy) => set((state) => {
    if (state.transform.kind !== 'translate') return state;
    return { transform: { ...state.transform, dx, dy } };
  }),

  beginScale: (bboxBounds, transformBounds, origin, handleId, initialDelta) => {
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
    const handleKind: HandleKind = isCorner ? 'corner' : 'side';
    const { selectedIds, selectionKind } = get();
    const topology = computeConnectorTopology('scale', selectedIds);

    set({
      transform: {
        kind: 'scale',
        origin,
        scaleX: 1,
        scaleY: 1,
        originBounds: transformBounds,
        bboxBounds,
        handleId,
        selectionKind,
        handleKind,
        initialDelta,
      },
      connectorTopology: topology,
      menuActive: false,
    });
  },

  updateScale: (scaleX, scaleY) => set((state) => {
    if (state.transform.kind !== 'scale') return state;
    return { transform: { ...state.transform, scaleX, scaleY } };
  }),

  endTransform: () => {
    const { selectedIds, textEditingId, marquee } = get();
    set({
      transform: { kind: 'none' },
      connectorTopology: null,
      menuActive: deriveMenuActive(selectedIds.length, textEditingId, 'none', marquee.active),
    });
  },

  cancelTransform: () => {
    const { selectedIds, textEditingId, marquee } = get();
    set({
      transform: { kind: 'none' },
      connectorTopology: null,
      menuActive: deriveMenuActive(selectedIds.length, textEditingId, 'none', marquee.active),
    });
  },

  // === Endpoint Drag Actions ===

  beginEndpointDrag: (connectorId, endpoint, originBbox) => set({
    transform: {
      kind: 'endpointDrag',
      connectorId,
      endpoint,
      currentPosition: [0, 0],
      currentSnap: null,
      routedPoints: null,
      routedBbox: null,
      prevBbox: originBbox,
    },
    menuActive: false,
  }),

  updateEndpointDrag: (currentPosition, currentSnap, routedPoints, routedBbox) => set((state) => {
    if (state.transform.kind !== 'endpointDrag') return state;
    return {
      transform: {
        ...state.transform,
        currentPosition,
        currentSnap,
        routedPoints,
        routedBbox,
        prevBbox: routedBbox ?? state.transform.prevBbox,
      },
    };
  }),

  // === Marquee Actions ===

  beginMarquee: (anchor) => set({
    marquee: { active: true, anchor, current: anchor },
    menuActive: false,
  }),

  updateMarquee: (current) => set((state) => {
    if (!state.marquee.active || !state.marquee.anchor) return state;
    return { marquee: { ...state.marquee, current } };
  }),

  endMarquee: () => {
    const { selectedIds, textEditingId, transform } = get();
    set((state) => ({
      marquee: { ...state.marquee, active: false },
      menuActive: deriveMenuActive(selectedIds.length, textEditingId, transform.kind, false),
    }));
  },

  cancelMarquee: () => {
    const { selectedIds, textEditingId, transform } = get();
    set({
      marquee: { active: false, anchor: null, current: null },
      menuActive: deriveMenuActive(selectedIds.length, textEditingId, transform.kind, false),
    });
  },

  // === Text Editing Actions ===

  beginTextEditing: (objectId, isNew) => {
    const { selectedIds, transform, marquee } = get();
    set({
      textEditingId: objectId,
      textEditingIsNew: isNew,
      menuActive: deriveMenuActive(selectedIds.length, objectId, transform.kind, marquee.active),
    });
  },

  endTextEditing: () => {
    const { selectedIds, transform, marquee } = get();
    set({
      textEditingId: null,
      textEditingIsNew: false,
      menuActive: deriveMenuActive(selectedIds.length, null, transform.kind, marquee.active),
    });
  },

  // === Context Menu Actions ===

  refreshStyles: () => {
    const { selectedIds, selectionKind, textEditingId, selectedStyles: current } = get();
    const snapshot = getCurrentSnapshot();
    let newStyles: SelectedStyles;
    if (textEditingId !== null && selectedIds.length === 0) {
      newStyles = computeStyles([textEditingId], 'textOnly', snapshot.objectsById);
    } else {
      newStyles = computeStyles(selectedIds, selectionKind, snapshot.objectsById);
    }
    if (!stylesEqual(current, newStyles)) {
      set({ selectedStyles: newStyles });
    }
  },

  onObjectMutation: (touchedIds, deletedIds, bboxChangedIds) => {
    const state = get();
    if (state.selectedIdSet.size === 0) return;

    for (const id of deletedIds) {
      if (state.selectedIdSet.has(id)) {
        state.clearSelection();
        return;
      }
    }

    let refresh = false;
    let bumpBounds = false;
    for (const id of touchedIds) {
      if (state.selectedIdSet.has(id)) { refresh = true; break; }
    }
    for (const id of bboxChangedIds) {
      if (state.selectedIdSet.has(id)) { bumpBounds = true; break; }
    }

    if (refresh) state.refreshStyles();
    if (bumpBounds) set((s) => ({ boundsVersion: s.boundsVersion + 1 }));
  },

  filterByKind: (kind) => {
    const ids = get().idsByKind[kind];
    if (ids.length > 0) get().setSelection(ids);
  },
}));

// === Handle Helpers ===

/**
 * Check if a handle is a corner handle (vs side handle).
 */
export function isCornerHandle(handleId: HandleId): boolean {
  return handleId === 'nw' || handleId === 'ne' || handleId === 'se' || handleId === 'sw';
}

/**
 * Compute handle positions for the four corners of a selection bounds.
 */
export function computeHandles(bounds: WorldBounds): { id: HandleId; x: number; y: number }[] {
  return [
    { id: 'nw', x: bounds.minX, y: bounds.minY },
    { id: 'ne', x: bounds.maxX, y: bounds.minY },
    { id: 'se', x: bounds.maxX, y: bounds.maxY },
    { id: 'sw', x: bounds.minX, y: bounds.maxY },
  ];
}

/**
 * Get the scale origin (fixed point) for a handle.
 * Scale origin is the opposite edge/corner from the dragged handle.
 */
export function getScaleOrigin(handleId: HandleId, bounds: WorldBounds): [number, number] {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  switch (handleId) {
    // Corners - opposite corner
    case 'nw': return [bounds.maxX, bounds.maxY];
    case 'ne': return [bounds.minX, bounds.maxY];
    case 'se': return [bounds.minX, bounds.minY];
    case 'sw': return [bounds.maxX, bounds.minY];
    // Sides - opposite edge midpoint
    case 'n': return [midX, bounds.maxY];
    case 's': return [midX, bounds.minY];
    case 'e': return [bounds.minX, midY];
    case 'w': return [bounds.maxX, midY];
  }
}

/**
 * Get the appropriate cursor CSS value for a resize handle.
 */
export function getHandleCursor(handleId: HandleId): string {
  switch (handleId) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
  }
}

// === Text Editing Selectors ===

export const selectTextEditingId = (state: SelectionStore) => state.textEditingId;
export const selectIsTextEditing = (state: SelectionStore) => state.textEditingId !== null;
export const selectTextEditingIsNew = (state: SelectionStore) => state.textEditingIsNew;
