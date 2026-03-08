import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds, FrameTuple } from '@avlo/shared';
import type { SnapTarget } from '@/lib/connectors/types';
import { getCurrentSnapshot, getConnectorsForShape } from '@/canvas/room-runtime';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import {
  getFrame,
  getPoints,
  getStart,
  getEnd,
  getStartAnchor,
  getEndAnchor,
  bboxTupleToWorldBounds,
} from '@avlo/shared';
import { getTextFrame, type TextLayout } from '@/lib/text/text-system';
import { getCodeFrame } from '@/lib/code/code-system';
import {
  computeSelectionComposition,
  computeStyles,
  computeUniformInlineStyles,
  stylesEqual,
  inlineStylesEqual,
  EMPTY_STYLES,
  EMPTY_KIND_COUNTS,
  EMPTY_ID_SET,
  EMPTY_INLINE_STYLES,
  type KindCounts,
  type SelectedStyles,
  type InlineStyles,
} from '@/lib/utils/selection-utils';

// Re-export for backward compat (SelectTool, ContextMenuController, etc.)
export { computeSelectionBounds } from '@/lib/utils/selection-utils';
export type { KindCounts, SelectedStyles, InlineStyles } from '@/lib/utils/selection-utils';

// === Types ===

/**
 * WorldRect is an alias for WorldBounds from the shared package.
 * @deprecated Prefer using WorldBounds directly from @avlo/shared
 */
export type WorldRect = WorldBounds;

// Selection composition types for context-aware transforms
export type SelectionKind =
  | 'none'
  | 'strokesOnly'
  | 'shapesOnly'
  | 'textOnly'
  | 'codeOnly'
  | 'connectorsOnly'
  | 'mixed';

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
  prevBboxes: Map<string, WorldBounds>;
}

// === Text Reflow State ===

export interface TextReflowState {
  layouts: Map<string, TextLayout>;
  origins: Map<string, [number, number]>;
}

// === Transform Types ===

export interface TranslateTransform {
  kind: 'translate';
  dx: number;
  dy: number;
  originBounds: WorldRect; // Bounds before transform started
}

export interface ScaleTransform {
  kind: 'scale';
  origin: [number, number]; // Fixed point during scale
  scaleX: number;
  scaleY: number;
  originBounds: WorldRect; // Geometry-based bounds (for position math - no stroke padding)
  bboxBounds: WorldRect; // Padded bounds (for dirty rect invalidation)
  handleId: HandleId; // Track which handle for uniform vs directional scaling
  selectionKind: SelectionKind; // Selection composition for context-aware behavior
  handleKind: HandleKind; // Corner vs side handle
  initialDelta: [number, number]; // Distance from origin to initial click (for scale=1.0 at start)
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
  anchor: [number, number] | null; // World coords
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
  /** True when context menu is logically open (React mounts content, controller positions) */
  menuOpen: boolean;
  /** Live style snapshot of selected objects */
  selectedStyles: SelectedStyles;
  /** Uniform inline styles (bold/italic/highlight) for text selections */
  inlineStyles: InlineStyles;
  /** Bumped on bbox changes to selected objects (for repositioning) */
  boundsVersion: number;
  transform: TransformState;
  marquee: MarqueeState;
  /** Connector topology during translate/scale transforms */
  connectorTopology: ConnectorTopology | null;
  /** Text reflow state during E/W side handle scale transforms */
  textReflow: TextReflowState | null;

  // Text editing - primitives only
  /** Object ID being edited, null if not editing */
  textEditingId: string | null;
  /** True if this text object was just created (for empty deletion on blur) */
  textEditingIsNew: boolean;

  // Code editing
  /** Code object ID being edited, null if not editing */
  codeEditingId: string | null;
}

// === Actions Interface ===

export interface SelectionActions {
  // Selection management
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;

  // Transform lifecycle
  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (
    bboxBounds: WorldRect,
    transformBounds: WorldRect,
    origin: [number, number],
    handleId: HandleId,
    initialDelta: [number, number],
  ) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

  // Endpoint drag lifecycle
  beginEndpointDrag: (
    connectorId: string,
    endpoint: 'start' | 'end',
    originBbox: WorldBounds,
  ) => void;
  updateEndpointDrag: (
    currentPosition: [number, number],
    currentSnap: SnapTarget | null,
    routedPoints: [number, number][] | null,
    routedBbox: WorldBounds | null,
  ) => void;

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

  // Code editing actions
  beginCodeEditing: (objectId: string) => void;
  endCodeEditing: () => void;

  // Inline text styles
  setInlineStyles: (next: InlineStyles) => void;

  // Context menu support
  refreshStyles: () => void;
}

export type SelectionStore = SelectionState & SelectionActions;

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
  selectedIds: string[],
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
      ? !startAnchor || selectedSet.has(startAnchor.id)
      : !!startAnchor && selectedSet.has(startAnchor.id);
    const endMoves = isSelected
      ? !endAnchor || selectedSet.has(endAnchor.id)
      : !!endAnchor && selectedSet.has(endAnchor.id);

    if (!startMoves && !endMoves) return;

    const points = getPoints(connHandle.y);
    const originalPoints: [number, number][] =
      points.length > 0
        ? (points as [number, number][])
        : [
            (getStart(connHandle.y) ?? [0, 0]) as [number, number],
            (getEnd(connHandle.y) ?? [0, 0]) as [number, number],
          ];
    const originalBbox = bboxTupleToWorldBounds(connHandle.bbox);

    // Determine strategy
    if (transformKind === 'translate' && startMoves && endMoves) {
      entries.push({
        connectorId: connId,
        strategy: 'translate',
        originalPoints,
        originalBbox,
        startSpec: null,
        endSpec: null,
      });
      translateIdSet.add(connId);
    } else {
      const startSpec: EndpointSpec =
        startAnchor && selectedSet.has(startAnchor.id)
          ? startAnchor.id
          : !startAnchor && isSelected
            ? true
            : null;
      const endSpec: EndpointSpec =
        endAnchor && selectedSet.has(endAnchor.id)
          ? endAnchor.id
          : !endAnchor && isSelected
            ? true
            : null;

      entries.push({
        connectorId: connId,
        strategy: 'reroute',
        originalPoints,
        originalBbox,
        startSpec,
        endSpec,
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
    if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text' && handle.kind !== 'code'))
      continue;
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
    if (!handle || (handle.kind !== 'shape' && handle.kind !== 'text' && handle.kind !== 'code'))
      continue;
    const frame =
      handle.kind === 'text'
        ? getTextFrame(handle.id)
        : handle.kind === 'code'
          ? getCodeFrame(handle.id)
          : getFrame(handle.y);
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

export const useSelectionStore = create<SelectionStore>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    selectedIds: [],
    mode: 'none',
    selectionKind: 'none',
    selectedIdSet: EMPTY_ID_SET,
    kindCounts: EMPTY_KIND_COUNTS,
    menuOpen: false,
    selectedStyles: EMPTY_STYLES,
    inlineStyles: EMPTY_INLINE_STYLES,
    boundsVersion: 0,
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
    connectorTopology: null,
    textReflow: null,
    textEditingId: null,
    textEditingIsNew: false,
    codeEditingId: null,

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
        transform: { kind: 'none' },
        marquee: { active: false, anchor: null, current: null },
        connectorTopology: null,
        textReflow: null,
        boundsVersion: get().boundsVersion + 1,
      });
      get().refreshStyles();
    },

    clearSelection: () =>
      set({
        selectedIds: [],
        mode: 'none',
        selectionKind: 'none',
        selectedIdSet: EMPTY_ID_SET,
        kindCounts: EMPTY_KIND_COUNTS,
        menuOpen: false,
        selectedStyles: EMPTY_STYLES,
        inlineStyles: EMPTY_INLINE_STYLES,
        boundsVersion: 0,
        transform: { kind: 'none' },
        marquee: { active: false, anchor: null, current: null },
        connectorTopology: null,
        textReflow: null,
      }),

    // === Transform Actions ===

    beginTranslate: (originBounds) => {
      const { selectedIds } = get();
      const topology = computeConnectorTopology('translate', selectedIds);
      set({
        transform: { kind: 'translate', dx: 0, dy: 0, originBounds },
        connectorTopology: topology,
      });
    },

    updateTranslate: (dx, dy) =>
      set((state) => {
        if (state.transform.kind !== 'translate') return state;
        return { transform: { ...state.transform, dx, dy } };
      }),

    beginScale: (bboxBounds, transformBounds, origin, handleId, initialDelta) => {
      const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
      const handleKind: HandleKind = isCorner ? 'corner' : 'side';
      const { selectedIds, selectionKind, kindCounts } = get();
      const topology = computeConnectorTopology('scale', selectedIds);

      const isEW = handleId === 'e' || handleId === 'w';
      const textReflow: TextReflowState | null =
        isEW && kindCounts.text > 0 ? { layouts: new Map(), origins: new Map() } : null;

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
        textReflow,
      });
    },

    updateScale: (scaleX, scaleY) =>
      set((state) => {
        if (state.transform.kind !== 'scale') return state;
        return { transform: { ...state.transform, scaleX, scaleY } };
      }),

    endTransform: () =>
      set({
        transform: { kind: 'none' },
        connectorTopology: null,
        textReflow: null,
      }),

    cancelTransform: () =>
      set({
        transform: { kind: 'none' },
        connectorTopology: null,
        textReflow: null,
      }),

    // === Endpoint Drag Actions ===

    beginEndpointDrag: (connectorId, endpoint, originBbox) =>
      set({
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
      }),

    updateEndpointDrag: (currentPosition, currentSnap, routedPoints, routedBbox) =>
      set((state) => {
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

    beginMarquee: (anchor) =>
      set({
        marquee: { active: true, anchor, current: anchor },
      }),

    updateMarquee: (current) =>
      set((state) => {
        if (!state.marquee.active || !state.marquee.anchor) return state;
        return { marquee: { ...state.marquee, current } };
      }),

    endMarquee: () =>
      set((state) => ({
        marquee: { ...state.marquee, active: false },
      })),

    cancelMarquee: () =>
      set({
        marquee: { active: false, anchor: null, current: null },
      }),

    // === Text Editing Actions ===

    beginTextEditing: (objectId, isNew) => {
      set({
        textEditingId: objectId,
        textEditingIsNew: isNew,
        menuOpen: true,
      });
      get().refreshStyles();
    },

    endTextEditing: () => {
      const { selectedIds } = get();
      set({
        textEditingId: null,
        textEditingIsNew: false,
        menuOpen: selectedIds.length > 0,
      });
      get().refreshStyles();
    },

    // === Code Editing Actions ===

    beginCodeEditing: (objectId) => {
      set({ codeEditingId: objectId, menuOpen: true });
      get().refreshStyles();
    },

    endCodeEditing: () => {
      const { selectedIds } = get();
      set({ codeEditingId: null, menuOpen: selectedIds.length > 0 });
    },

    setInlineStyles: (next) => {
      if (inlineStylesEqual(get().inlineStyles, next)) return;
      set({ inlineStyles: next });
    },

    // === Context Menu Actions ===

    refreshStyles: () => {
      const { selectedIds, selectionKind, textEditingId, selectedStyles: current } = get();
      const snapshot = getCurrentSnapshot();
      const ids =
        textEditingId !== null && selectedIds.length === 0 ? [textEditingId] : selectedIds;
      const kind =
        textEditingId !== null && selectedIds.length === 0
          ? ('textOnly' as SelectionKind)
          : selectionKind;

      const patch: Partial<SelectionState> = {};

      const next = computeStyles(ids, kind, snapshot.objectsById);
      if (!stylesEqual(current, next)) patch.selectedStyles = next;

      // Inline text styles — only when editor is NOT mounted
      if (
        textEditingId === null &&
        (kind === 'textOnly' || kind === 'shapesOnly') &&
        ids.length > 0
      ) {
        const inline = computeUniformInlineStyles(ids, snapshot.objectsById);
        if (!inlineStylesEqual(get().inlineStyles, inline)) patch.inlineStyles = inline;
      }

      if (Object.keys(patch).length > 0) set(patch);
    },
  })),
);

// === Free Functions ===

/**
 * Filter current selection to only objects of the given kind.
 * No-op if no objects of that kind are selected.
 */
export function filterSelectionByKind(
  kind: 'strokes' | 'shapes' | 'text' | 'connectors' | 'code',
): void {
  const { selectedIds } = useSelectionStore.getState();
  const snapshot = getCurrentSnapshot();
  const targetKind =
    kind === 'strokes'
      ? 'stroke'
      : kind === 'shapes'
        ? 'shape'
        : kind === 'connectors'
          ? 'connector'
          : kind === 'code'
            ? 'code'
            : 'text';
  const filtered = selectedIds.filter((id) => snapshot.objectsById.get(id)?.kind === targetKind);
  if (filtered.length > 0) {
    useSelectionStore.getState().setSelection(filtered);
    invalidateOverlay();
  }
}

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
    case 'nw':
      return [bounds.maxX, bounds.maxY];
    case 'ne':
      return [bounds.minX, bounds.maxY];
    case 'se':
      return [bounds.minX, bounds.minY];
    case 'sw':
      return [bounds.maxX, bounds.minY];
    // Sides - opposite edge midpoint
    case 'n':
      return [midX, bounds.maxY];
    case 's':
      return [midX, bounds.minY];
    case 'e':
      return [bounds.minX, midY];
    case 'w':
      return [bounds.maxX, midY];
  }
}

/**
 * Get the appropriate cursor CSS value for a resize handle.
 */
export function getHandleCursor(handleId: HandleId): string {
  switch (handleId) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
  }
}

// === Text Editing Selectors ===

export const selectTextEditingId = (state: SelectionStore) => state.textEditingId;
export const selectIsTextEditing = (state: SelectionStore) => state.textEditingId !== null;
export const selectTextEditingIsNew = (state: SelectionStore) => state.textEditingIsNew;

// === Inline Style Selectors ===

export const selectInlineBold = (state: SelectionStore) => state.inlineStyles.bold;
export const selectInlineItalic = (state: SelectionStore) => state.inlineStyles.italic;
export const selectInlineHighlightColor = (state: SelectionStore) =>
  state.inlineStyles.highlightColor;
