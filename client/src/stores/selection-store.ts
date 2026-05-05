import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SnapTarget } from '@/core/connectors/types';
import { expandBBoxEnvelope, frameToBbox } from '@/core/geometry/bounds';
import { rawScaleFactors } from '@/core/geometry/scale-system';
import { getTextFrame } from '@/core/text/text-system';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { handlePosition, scaleOrigin } from '@/core/types/handles';
import type { ObjectKind } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getHandle, getObjectsById } from '@/runtime/room-runtime';
import { codeTool, textTool } from '@/runtime/tool-registry';
import {
  computeSelectionComposition,
  computeStyles,
  computeUniformInlineStyles,
  EMPTY_ID_SET,
  inlineStylesEqual,
  stylesEqual,
} from '@/tools/selection/selection-utils';
import { getController } from '@/tools/selection/transform';
import type { InlineStyles, KindCounts, SelectedStyles, SelectionKind, SelectionMode, TransformState } from '@/tools/selection/types';
import { EMPTY_INLINE_STYLES, EMPTY_KIND_COUNTS, EMPTY_STYLES } from '@/tools/selection/types';
import type { HandleId } from '@/tools/types';

export type { ConnectorEntry, ConnectorTopology } from '@/tools/selection/connector-topology';
export type { InlineStyles, KindCounts, SelectedStyles, SelectionKind, SelectionMode, TransformState } from '@/tools/selection/types';

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

  // Text editing - primitives only
  /** Object ID being edited, null if not editing */
  textEditingId: string | null;

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
  beginEndpointDrag: (
    connectorId: string,
    endpoint: 'start' | 'end',
    originBbox: BBoxTuple,
    pointsBuf: Point[],
    dragBbox: BBoxTuple,
  ) => void;
  updateEndpointDrag: (currentPosition: [number, number], currentSnap: SnapTarget | null, validCount: number) => void;

  // Text editing actions
  /** Begin text editing */
  beginTextEditing: (objectId: string) => void;
  /** End text editing */
  endTextEditing: () => void;

  // Code editing actions
  beginCodeEditing: (objectId: string) => void;
  endCodeEditing: () => void;

  // Inline text styles
  setInlineStyles: (next: InlineStyles) => void;

  // Context menu support
  refreshStyles: () => void;

  // Doc-observer reactions
  onObjectsDeleted: (deletedIds: ReadonlySet<string>) => void;
  onObjectsChanged: (touched: ReadonlySet<string>, bboxChangedIds: ReadonlySet<string>) => void;
}

export type SelectionStore = SelectionState & SelectionActions;

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
    textEditingId: null,
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
      }),

    // === Transform Actions ===

    beginTranslate: () => {
      const selBounds = computeSelectionBounds();
      if (!selBounds) return;
      getController().beginTranslate(get().selectedIdSet, selBounds);
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
      const { selectedIdSet } = get();
      getController().beginScale(selectedIdSet, handleId, origin, selBounds);
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

    beginEndpointDrag: (connectorId, endpoint, originBbox, pointsBuf, dragBbox) =>
      set({
        transform: {
          kind: 'endpointDrag',
          connectorId,
          endpoint,
          currentPosition: [0, 0],
          currentSnap: null,
          pointsBuf,
          validCount: 0,
          // Shared-by-ref with SelectTool's dragBbox (mutated in place each event).
          routedBbox: dragBbox,
          // Separate snapshot tuple — must not alias dragBbox or the dirty-rect chain breaks.
          prevBbox: [originBbox[0], originBbox[1], originBbox[2], originBbox[3]],
        },
      }),

    updateEndpointDrag: (currentPosition, currentSnap, validCount) =>
      set((state) => {
        if (state.transform.kind !== 'endpointDrag') return state;
        // routedBbox stays as the same shared dragBbox reference; prevBbox is
        // snapshotted by the caller (SelectTool) BEFORE the reroute mutates dragBbox.
        return {
          transform: {
            ...state.transform,
            currentPosition,
            currentSnap,
            validCount,
          },
        };
      }),

    // === Text Editing Actions ===

    beginTextEditing: (objectId) => {
      set({
        textEditingId: objectId,
        menuOpen: true,
      });
      get().refreshStyles();
    },

    endTextEditing: () => {
      const { selectedIds } = get();
      set({
        textEditingId: null,
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

      const next = computeStyles(ids, kind);
      if (!stylesEqual(current, next)) patch.selectedStyles = next;

      // Inline text styles — only when editor is NOT mounted
      if (textEditingId === null && (kind === 'text' || kind === 'shape' || kind === 'note') && ids.length > 0) {
        const inline = computeUniformInlineStyles(ids);
        if (!inlineStylesEqual(get().inlineStyles, inline)) patch.inlineStyles = inline;
      }

      if (Object.keys(patch).length > 0) set(patch);
    },

    // === Doc-observer Reactions ===

    onObjectsDeleted: (deletedIds) => {
      const { selectedIds, textEditingId, codeEditingId } = get();
      let overlayDirty = false;
      for (const sid of selectedIds) {
        if (deletedIds.has(sid)) {
          get().clearSelection();
          overlayDirty = true;
          break;
        }
      }
      // Tool teardown owns DOM unmount + state cleanup + world/overlay invalidation —
      // calling endTextEditing/endCodeEditing alone leaves the editor's DOM mounted
      // showing a stale view of the now-gone object until the user closes it manually.
      if (textEditingId !== null && deletedIds.has(textEditingId)) {
        textTool.commitAndClose();
      }
      if (codeEditingId !== null && deletedIds.has(codeEditingId)) {
        codeTool.commitAndClose();
      }
      if (overlayDirty) invalidateOverlay();
    },

    onObjectsChanged: (touched, bboxChangedIds) => {
      if (touched.size === 0) return;
      const { selectedIds, textEditingId, codeEditingId } = get();
      let refresh = false;
      let reposition = false;
      for (const id of selectedIds) {
        if (touched.has(id)) {
          refresh = true;
          if (bboxChangedIds.has(id)) reposition = true;
        }
      }
      if (textEditingId !== null && touched.has(textEditingId)) {
        refresh = true;
        if (bboxChangedIds.has(textEditingId)) reposition = true;
      }
      if (codeEditingId !== null && touched.has(codeEditingId)) {
        refresh = true;
        if (bboxChangedIds.has(codeEditingId)) reposition = true;
      }
      if (refresh) get().refreshStyles();
      if (reposition) {
        set((s) => ({ boundsVersion: s.boundsVersion + 1 }));
        invalidateOverlay();
      }
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

// === Inline Style Selectors ===

export const selectInlineBold = (state: SelectionStore) => state.inlineStyles.bold;
export const selectInlineItalic = (state: SelectionStore) => state.inlineStyles.italic;
export const selectInlineHighlightColor = (state: SelectionStore) => state.inlineStyles.highlightColor;
