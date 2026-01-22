import { create } from 'zustand';
import type { HandleId } from '@/lib/tools/types';
import type { WorldBounds } from '@avlo/shared';

// === Types ===

/**
 * WorldRect is an alias for WorldBounds from the shared package.
 * @deprecated Prefer using WorldBounds directly from @avlo/shared
 */
export type WorldRect = WorldBounds;

// Selection composition types for context-aware transforms
export type SelectionKind = 'none' | 'strokesOnly' | 'shapesOnly' | 'mixed';
export type HandleKind = 'corner' | 'side';

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

export type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform;

export interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null;  // World coords
  current: [number, number] | null; // World coords
}

// === State Interface ===

export interface SelectionState {
  selectedIds: string[];
  mode: 'none' | 'single' | 'multi';
  transform: TransformState;
  marquee: MarqueeState;
}

// === Actions Interface ===

export interface SelectionActions {
  // Selection management
  setSelection: (ids: string[]) => void;
  clearSelection: () => void;

  // Transform lifecycle
  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (bboxBounds: WorldRect, transformBounds: WorldRect, origin: [number, number], handleId: HandleId, selectionKind: SelectionKind, initialDelta: [number, number]) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

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
  transform: { kind: 'none' },
  marquee: { active: false, anchor: null, current: null },

  // === Selection Actions ===

  setSelection: (ids) => set({
    selectedIds: ids,
    mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
  }),

  clearSelection: () => set({
    selectedIds: [],
    mode: 'none',
    transform: { kind: 'none' },
    marquee: { active: false, anchor: null, current: null },
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

  endTransform: () => set({ transform: { kind: 'none' } }),

  cancelTransform: () => set({ transform: { kind: 'none' } }),

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
