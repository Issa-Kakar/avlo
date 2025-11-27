import { create } from 'zustand';

// === Types ===

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

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
  originBounds: WorldRect;
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
  beginScale: (originBounds: WorldRect, origin: [number, number]) => void;
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

  beginScale: (originBounds, origin) => set({
    transform: { kind: 'scale', origin, scaleX: 1, scaleY: 1, originBounds },
  }),

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
