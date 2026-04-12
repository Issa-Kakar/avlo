import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { HandleId } from '@/tools/types';
import type { ObjectKind } from '@/core/types/objects';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { SnapTarget } from '@/core/connectors/types';
import { getObjectsById, getHandle } from '@/runtime/room-runtime';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import {
  computeSelectionComposition,
  computeStyles,
  computeUniformInlineStyles,
  stylesEqual,
  inlineStylesEqual,
  EMPTY_ID_SET,
} from '@/tools/selection/selection-utils';
import { getController } from '@/tools/selection/transform';
import { scaleOrigin, handlePosition } from '@/core/types/handles';
import { rawScaleFactors } from '@/core/geometry/scale-system';
import { getTextFrame } from '@/core/text/text-system';
import { expandBBoxEnvelope, frameToBbox } from '@/core/geometry/bounds';
import type {
  SelectionKind,
  SelectionMode,
  KindCounts,
  SelectedStyles,
  InlineStyles,
  TransformState,
  MarqueeState,
} from '@/tools/selection/types';
import { EMPTY_STYLES, EMPTY_KIND_COUNTS, EMPTY_INLINE_STYLES } from '@/tools/selection/types';

export type {
  SelectionKind,
  SelectionMode,
  KindCounts,
  SelectedStyles,
  InlineStyles,
  TransformState,
  MarqueeState,
  ConnectorTopology,
  ConnectorTopologyEntry,
  EndpointSpec,
} from '@/tools/selection/types';

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
  beginTranslate: () => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (handleId: HandleId, downWorld: Point) => void;
  updateScale: (worldX: number, worldY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

  // Endpoint drag lifecycle
  beginEndpointDrag: (connectorId: string, endpoint: 'start' | 'end', originBbox: BBoxTuple) => void;
  updateEndpointDrag: (
    currentPosition: [number, number],
    currentSnap: SnapTarget | null,
    routedPoints: [number, number][] | null,
    routedBbox: BBoxTuple | null,
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

// Re-export for backward compat — topology builder lives in connector-topology.ts
export { computeConnectorTopology } from '@/tools/selection/connector-topology';

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
      }),

    // === Transform Actions ===

    beginTranslate: () => {
      getController().beginTranslate(get().selectedIdSet);
      set({ transform: { kind: 'translate' } });
    },

    updateTranslate: (dx, dy) => {
      getController().updateTranslate(dx, dy);
    },

    beginScale: (handleId, downWorld) => {
      const selBounds = computeSelectionBounds();
      if (!selBounds) return;
      const origin = scaleOrigin(handleId, selBounds);
      const handlePos = handlePosition(handleId, selBounds);
      const initialDelta: Point = [handlePos[0] - origin[0], handlePos[1] - origin[1]];
      const clickOffset: Point = [downWorld[0] - handlePos[0], downWorld[1] - handlePos[1]];
      const { selectedIdSet, kindCounts } = get();
      getController().beginScale(selectedIdSet, kindCounts, handleId, origin, selBounds);
      set({ transform: { kind: 'scale', initialDelta, clickOffset } });
    },

    updateScale: (worldX, worldY) => {
      const t = get().transform;
      if (t.kind !== 'scale') return;
      const sCtx = getController().getScaleCtx();
      if (!sCtx) return;
      const [sx, sy] = rawScaleFactors(worldX - t.clickOffset[0], worldY - t.clickOffset[1], sCtx.origin, t.initialDelta, sCtx.handleId);
      getController().updateScale(sx, sy);
    },

    endTransform: () => {
      const ctrl = getController();
      if (ctrl.hasChange()) ctrl.commit();
      else ctrl.clear();
      set({ transform: { kind: 'none' } });
    },

    cancelTransform: () => {
      getController().cancel();
      set({ transform: { kind: 'none' } });
    },

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
      const { selectedIds, selectionKind, textEditingId, codeEditingId, selectedStyles: current } = get();
      let ids = selectedIds as string[];
      let kind = selectionKind as SelectionKind;
      if (selectedIds.length === 0) {
        if (textEditingId !== null) {
          ids = [textEditingId];
          const handle = getHandle(textEditingId);
          kind = handle?.kind === 'note' ? 'note' : 'text';
        } else if (codeEditingId !== null) {
          ids = [codeEditingId];
          kind = 'code';
        }
      }

      const patch: Partial<SelectionState> = {};

      const next = computeStyles(ids, kind, getObjectsById());
      if (!stylesEqual(current, next)) patch.selectedStyles = next;

      // Inline text styles — only when editor is NOT mounted
      if (textEditingId === null && (kind === 'text' || kind === 'shape' || kind === 'note') && ids.length > 0) {
        const inline = computeUniformInlineStyles(ids, getObjectsById());
        if (!inlineStylesEqual(get().inlineStyles, inline)) patch.inlineStyles = inline;
      }

      if (Object.keys(patch).length > 0) set(patch);
    },
  })),
);

// === Free Functions ===

/**
 * Compute padded selection bounds from selected IDs.
 * Zero-arg: reads selectedIds (+ textEditingId/codeEditingId fallback) from this store.
 * Text uses derived frame (italic overhangs differ from bbox); others use handle.bbox.
 */
export function computeSelectionBounds(): BBoxTuple | null {
  const { selectedIds, textEditingId, codeEditingId } = useSelectionStore.getState();
  const ids = selectedIds.length > 0 ? selectedIds : textEditingId ? [textEditingId] : codeEditingId ? [codeEditingId] : [];
  if (ids.length === 0) return null;

  const objectsById = getObjectsById();
  let result: BBoxTuple | null = null;

  for (const id of ids) {
    const handle = objectsById.get(id);
    if (!handle) continue;
    if (handle.kind === 'text') {
      const frame = getTextFrame(id);
      if (frame) result = expandBBoxEnvelope(result, frameToBbox(frame));
      continue;
    }
    result = expandBBoxEnvelope(result, handle.bbox);
  }

  return result;
}

/**
 * Filter current selection to only objects of the given kind.
 * No-op if no objects of that kind are selected.
 */
export function filterSelectionByKind(kind: ObjectKind): void {
  const { selectedIds } = useSelectionStore.getState();
  const filtered = selectedIds.filter((id) => getHandle(id)?.kind === kind);
  if (filtered.length > 0) {
    useSelectionStore.getState().setSelection(filtered);
    invalidateOverlay();
  }
}

// === Handle Helpers ===

/**
 * Compute handle positions for the four corners of a selection bounds.
 */
export function computeHandles(bbox: BBoxTuple): { id: HandleId; x: number; y: number }[] {
  return [
    { id: 'nw', x: bbox[0], y: bbox[1] },
    { id: 'ne', x: bbox[2], y: bbox[1] },
    { id: 'se', x: bbox[2], y: bbox[3] },
    { id: 'sw', x: bbox[0], y: bbox[3] },
  ];
}

// === Text Editing Selectors ===

export const selectTextEditingId = (state: SelectionStore) => state.textEditingId;
export const selectIsTextEditing = (state: SelectionStore) => state.textEditingId !== null;
export const selectTextEditingIsNew = (state: SelectionStore) => state.textEditingIsNew;

// === Inline Style Selectors ===

export const selectInlineBold = (state: SelectionStore) => state.inlineStyles.bold;
export const selectInlineItalic = (state: SelectionStore) => state.inlineStyles.italic;
export const selectInlineHighlightColor = (state: SelectionStore) => state.inlineStyles.highlightColor;
