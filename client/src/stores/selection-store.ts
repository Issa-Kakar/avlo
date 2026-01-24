import { create } from 'zustand';
import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds, FrameTuple } from '@avlo/shared';
import type { SnapTarget } from '@/lib/connectors/types';

// === Types ===

/**
 * WorldRect is an alias for WorldBounds from the shared package.
 * @deprecated Prefer using WorldBounds directly from @avlo/shared
 */
export type WorldRect = WorldBounds;

// Selection composition types for context-aware transforms
export type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'connectorsOnly' | 'mixed';
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
  transform: TransformState;
  marquee: MarqueeState;
  /** Connector topology during translate/scale transforms */
  connectorTopology: ConnectorTopology | null;
}

// === Actions Interface ===

export interface SelectionActions {
  // Selection management
  setSelection: (ids: string[], selectionKind: SelectionKind) => void;
  clearSelection: () => void;

  // Transform lifecycle
  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (bboxBounds: WorldRect, transformBounds: WorldRect, origin: [number, number], handleId: HandleId, selectionKind: SelectionKind, initialDelta: [number, number]) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  setConnectorTopology: (topology: ConnectorTopology | null) => void;
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
}

export type SelectionStore = SelectionState & SelectionActions;

// === Store Implementation ===

export const useSelectionStore = create<SelectionStore>((set) => ({
  // Initial state
  selectedIds: [],
  mode: 'none',
  selectionKind: 'none',
  transform: { kind: 'none' },
  marquee: { active: false, anchor: null, current: null },
  connectorTopology: null,

  // === Selection Actions ===

  setSelection: (ids, selectionKind) => {
    const mode: SelectionMode =
      ids.length === 1 && selectionKind === 'connectorsOnly'
        ? 'connector'
        : ids.length > 0 ? 'standard' : 'none';

    set({
      selectedIds: ids,
      mode,
      selectionKind,
      transform: { kind: 'none' },
      marquee: { active: false, anchor: null, current: null },
      connectorTopology: null,
    });
  },

  clearSelection: () => set({
    selectedIds: [],
    mode: 'none',
    selectionKind: 'none',
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
    connectorTopology: null,
  }),

  // === Transform Actions ===

  beginTranslate: (originBounds) => set({
    transform: { kind: 'translate', dx: 0, dy: 0, originBounds },
  }),

  updateTranslate: (dx, dy) => set((state) => {
    if (state.transform.kind !== 'translate') return state;
    return { transform: { ...state.transform, dx, dy } };
  }),

  beginScale: (bboxBounds, transformBounds, origin, handleId, selectionKind, initialDelta) => {
    // Compute handleKind from handleId (deterministic)
    const isCorner = ['nw', 'ne', 'se', 'sw'].includes(handleId);
    const handleKind: HandleKind = isCorner ? 'corner' : 'side';

    set({
      transform: {
        kind: 'scale',
        origin,
        scaleX: 1,
        scaleY: 1,
        originBounds: transformBounds,  // Geometry-based for position math
        bboxBounds,                      // Padded for dirty rects
        handleId,
        selectionKind,
        handleKind,
        initialDelta,
      },
    });
  },

  updateScale: (scaleX, scaleY) => set((state) => {
    if (state.transform.kind !== 'scale') return state;
    return { transform: { ...state.transform, scaleX, scaleY } };
  }),

  setConnectorTopology: (connectorTopology) => set({ connectorTopology }),

  endTransform: () => set({ transform: { kind: 'none' }, connectorTopology: null }),

  cancelTransform: () => set({ transform: { kind: 'none' }, connectorTopology: null }),

  // === Endpoint Drag Actions ===

  beginEndpointDrag: (connectorId, endpoint, originBbox) => set({
    transform: {
      kind: 'endpointDrag',
      connectorId,
      endpoint,
      currentPosition: [0, 0], // Will be set on first move
      currentSnap: null,
      routedPoints: null,
      routedBbox: null,
      prevBbox: originBbox,
    },
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
        // prevBbox updated to current for next frame's dirty rect
        prevBbox: routedBbox ?? state.transform.prevBbox,
      },
    };
  }),

  // === Marquee Actions ===

  beginMarquee: (anchor) => set({
    marquee: { active: true, anchor, current: anchor },
  }),

  updateMarquee: (current) => set((state) => {
    if (!state.marquee.active || !state.marquee.anchor) return state;
    return { marquee: { ...state.marquee, current } };
  }),

  endMarquee: () => set((state) => ({
    marquee: { ...state.marquee, active: false },
  })),

  cancelMarquee: () => set({
    marquee: { active: false, anchor: null, current: null },
  }),
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
