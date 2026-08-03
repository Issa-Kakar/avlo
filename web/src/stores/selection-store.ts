import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Slot } from '@/core/connectors/reroute-connector';
import type { SnapTarget } from '@/core/connectors/types';
import { expandBBoxEnvelope, frameToBbox } from '@/core/geometry/bounds';
import { rawScaleFactorsInto } from '@/core/geometry/scale-system';
import {
  acquireLocalLock,
  acquireLocalLocks,
  getLockedFlags,
  getLockOwners,
  isLockedId,
  LOCK_SRC_CODE_EDITOR,
  LOCK_SRC_TEXT_EDITOR,
  LOCK_SRC_TRANSFORM,
  onRemoteLocksApplied,
  releaseLocalLocks,
} from '@/core/locks/lock-table';
import { getTextFrame } from '@/core/text/text-system';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import { handlePosition, scaleOrigin } from '@/core/types/handles';
import type { ObjectKind } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { getHandle, getObjectsById } from '@/runtime/room-runtime';
import { codeTool, textTool } from '@/runtime/tool-registry';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import {
  computeSelectionComposition,
  computeStyles,
  computeUniformInlineStyles,
  EMPTY_ID_SET,
  inlineStylesEqual,
  stylesEqual,
} from '@/tools/selection/selection-utils';
import * as tf from '@/tools/selection/transform';
import type { InlineStyles, KindCounts, SelectedStyles, SelectionKind, SelectionMode, TransformState } from '@/tools/selection/types';
import { EMPTY_INLINE_STYLES, EMPTY_KIND_COUNTS, EMPTY_STYLES } from '@/tools/selection/types';
import type { HandleId } from '@/tools/types';

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
  /** True when every selected object carries the durable `locked` flag (all-or-nothing
   *  by invariant) — collapses the context menu to the lock button, hides handles,
   *  blocks transforms + mutating keyboard shortcuts. */
  selectionLocked: boolean;
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

  // Endpoint drag lifecycle — store carries renderer/UI fields only;
  // the controller owns RouteContext + buffers + synthetic ConnectorEntry.
  // End/cancel route through `endTransform` / `cancelTransform` like other gestures.
  beginEndpointDrag: (connectorId: string, slot: Slot) => void;
  updateEndpointDrag: (currentPosition: [number, number], currentSnap: SnapTarget | null) => void;

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
  onObjectsKindChanged: (kindChangedIds: ReadonlySet<string>) => void;
  onObjectsLockChanged: (lockChangedIds: ReadonlySet<string>) => void;
}

export type SelectionStore = SelectionState & SelectionActions;

// Remote lock landed on a selected id mid-gesture — pruning then would desync the renderer
// (selectedSet skip vs the controller's injectIds re-push → double-draw), and keyboard
// Guard 7 + the hidden context menu already block every selection mutation during a
// gesture, so the prune defers to endTransform/cancelTransform. Commit guards heal writes.
let _lockPrunePending = false;

// Durable-lock sibling of _lockPrunePending — a `locked` keychange landed on a selected id
// mid-gesture; reconcile defers to endTransform/cancelTransform for the same reasons.
let _persistLockPending = false;

// Per-pointermove scale-factor scratch (rawScaleFactorsInto output).
const _rsf: Point = [0, 0];

/**
 * Re-derive the selection against the durable-lock column. All-locked or none-locked →
 * recompose in place (selectionLocked flips; the menu collapses/expands, handles
 * hide/show). Partial — a remote peer locked part of a multi-selection — → prune the
 * locked ids so mixed lock states never persist. Write-free (safe inside observer fires).
 */
function reconcileLockedSelection(): void {
  const s = useSelectionStore.getState();
  const ids = s.selectedIds;
  if (ids.length === 0) return;
  const lf = getLockedFlags();
  let live = 0;
  let locked = 0;
  for (const id of ids) {
    const h = getHandle(id);
    if (!h) continue;
    live++;
    if (lf[h.slot] === 1) locked++;
  }
  const next =
    locked === 0 || locked === live
      ? ids
      : ids.filter((id) => {
          const h = getHandle(id);
          return !h || lf[h.slot] !== 1;
        });
  s.setSelection(next); // setSelection([]) routes to clearSelection
  invalidateOverlay();
}

/** Ephemeral-lock arm of the transform-gesture lock: acquire the full inject set
 *  (selection ∪ attached connectors, post-filter) right after the engine begin. */
function acquireTransformLocks(): void {
  const inject = tf.getTransformInjectIds();
  if (inject !== null) acquireLocalLocks(LOCK_SRC_TRANSFORM, inject);
}

function releaseTransformLocks(): void {
  releaseLocalLocks(LOCK_SRC_TRANSFORM);
  if (_lockPrunePending) {
    _lockPrunePending = false;
    pruneRemoteLockedSelection();
  }
  if (_persistLockPending) {
    _persistLockPending = false;
    reconcileLockedSelection();
  }
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
    selectionLocked: false,
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
        selectionLocked: comp.locked,
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
        selectionLocked: false,
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
      tf.beginTranslate(get().selectedIdSet, selBounds);
      acquireTransformLocks();
      set({ transform: { kind: 'translate' } });
    },

    updateTranslate: (dx, dy) => {
      tf.updateTranslate(dx, dy);
    },

    beginScale: (handleId, downWorld) => {
      const selBounds = computeSelectionBounds();
      if (!selBounds) return;
      const origin = scaleOrigin(handleId, selBounds);
      const handlePos = handlePosition(handleId, selBounds);
      const initialDelta: Point = [handlePos[0] - origin[0], handlePos[1] - origin[1]];
      const clickOffset: Point = [downWorld[0] - handlePos[0], downWorld[1] - handlePos[1]];
      const { selectedIdSet } = get();
      tf.beginScale(selectedIdSet, handleId, origin, selBounds);
      acquireTransformLocks();
      set({ transform: { kind: 'scale', initialDelta, clickOffset } });
    },

    updateScale: (worldX, worldY) => {
      const t = get().transform;
      if (t.kind !== 'scale') return;
      const sCtx = tf.getTransformScaleCtx();
      if (!sCtx) return;
      rawScaleFactorsInto(_rsf, worldX - t.clickOffset[0], worldY - t.clickOffset[1], sCtx.origin, t.initialDelta, sCtx.handleId);
      tf.updateScale(_rsf[0], _rsf[1]);
    },

    endTransform: () => {
      const t = get().transform;
      if (t.kind === 'endpointDrag') {
        // The engine owns the route buffer + bbox snapshots; the snap target lives
        // on the store discriminant (drives commit's anchor-vs-free choice).
        tf.commitEndpointDrag(t.currentSnap);
      } else if (tf.transformHasChange()) {
        tf.commitTransform();
      } else {
        tf.clearTransform();
      }
      set({ transform: { kind: 'none' } });
      releaseTransformLocks();
    },

    cancelTransform: () => {
      tf.cancelTransform();
      set({ transform: { kind: 'none' } });
      releaseTransformLocks();
    },

    // === Endpoint Drag Actions ===

    beginEndpointDrag: (connectorId, slot) => {
      // SelectTool already ran tf.beginEndpointDrag (and bailed on false),
      // so the engine's injectIds holds the dragged connector.
      acquireTransformLocks();
      set({
        transform: {
          kind: 'endpointDrag',
          connectorId,
          slot,
          currentPosition: [0, 0],
          currentSnap: null,
        },
      });
    },

    updateEndpointDrag: (currentPosition, currentSnap) =>
      set((state) =>
        state.transform.kind === 'endpointDrag' ? { transform: { ...state.transform, currentPosition, currentSnap } } : state,
      ),

    // === Text Editing Actions ===

    beginTextEditing: (objectId) => {
      acquireLocalLock(LOCK_SRC_TEXT_EDITOR, objectId);
      set({
        textEditingId: objectId,
        menuOpen: true,
      });
      get().refreshStyles();
    },

    endTextEditing: () => {
      releaseLocalLocks(LOCK_SRC_TEXT_EDITOR);
      const { selectedIds } = get();
      set({
        textEditingId: null,
        menuOpen: selectedIds.length > 0,
      });
      get().refreshStyles();
    },

    // === Code Editing Actions ===

    beginCodeEditing: (objectId) => {
      acquireLocalLock(LOCK_SRC_CODE_EDITOR, objectId);
      set({ codeEditingId: objectId, menuOpen: true });
      get().refreshStyles();
    },

    endCodeEditing: () => {
      releaseLocalLocks(LOCK_SRC_CODE_EDITOR);
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
        // Connector label editor: its anchor is the DERIVED route midpoint, so a
        // reroute (endpoint edit, attached-shape move, undo/redo) repositions it
        // here — after the deep observer rebuilt the route cache. The extension
        // observer (syncProps) fires before that, so it can't see the fresh route.
        if (getHandle(textEditingId)?.kind === 'connector') textTool.onViewChange();
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

    // In-place kind conversion (text ↔ note ↔ shape) — `handle.kind` already
    // mirrors the new kind; recompute everything `setSelection` derives from it.
    // Runs synchronously inside the deep observer fire — MUST NOT open a
    // transact() (a re-entrant fire would clobber the manager's reused scratch
    // sets). Every call below is write-free.
    onObjectsKindChanged: (kindChangedIds) => {
      const { selectedIdSet, textEditingId } = get();
      let inSelection = false;
      for (const id of kindChangedIds) {
        if (selectedIdSet.has(id)) {
          inSelection = true;
          break;
        }
      }
      if (inSelection) {
        // Cancel BEFORE setSelection — setSelection resets the discriminant
        // without tf.cancelTransform(), stranding frozen old-kind entries
        // that a later pointerup would commit as old-kind fields. (The
        // engine's eviction hook already DEAD-flags the converted entry, so
        // both paths are safe in either order.)
        if (get().transform.kind !== 'none') get().cancelTransform();
        get().setSelection(get().selectedIds);
      } else if (textEditingId !== null && kindChangedIds.has(textEditingId)) {
        // Standalone edit (text/note tool entry — no selection): promote to the
        // canonical selected+editing state. The menu bar's standalone fallback
        // resolves the kind via getHandleKind at render time and has no
        // re-render signal for an in-place kind flip; selectionKind does.
        get().setSelection([textEditingId]);
      }
      if (textEditingId !== null && kindChangedIds.has(textEditingId)) {
        textTool.onEditingKindChanged();
      }
    },

    // Durable-lock keychange landed on the doc — if it intersects the selection,
    // recompose (menu collapse/expand) or prune (partial remote lock). Same
    // write-free + defer-during-gesture rules as the ephemeral prune above.
    onObjectsLockChanged: (lockChangedIds) => {
      // Remote peer locked the object I'm editing → force-close (mirrors the ephemeral
      // force-close). Deferred to a microtask: commitAndClose opens a transact, which is
      // forbidden inside the observer fire; the re-check guards teardown races. Local
      // toggles close pre-transact in toggleSelectedLocked and never reach this branch.
      const { textEditingId, codeEditingId } = get();
      if (textEditingId !== null && lockChangedIds.has(textEditingId) && isLockedId(textEditingId)) {
        queueMicrotask(() => {
          if (get().textEditingId === textEditingId) textTool.commitAndClose();
        });
      }
      if (codeEditingId !== null && lockChangedIds.has(codeEditingId) && isLockedId(codeEditingId)) {
        queueMicrotask(() => {
          if (get().codeEditingId === codeEditingId) codeTool.commitAndClose();
        });
      }
      const { selectedIdSet } = get();
      let hit = false;
      for (const id of lockChangedIds) {
        if (selectedIdSet.has(id)) {
          hit = true;
          break;
        }
      }
      if (!hit) return;
      if (get().transform.kind !== 'none') {
        _persistLockPending = true;
        return;
      }
      reconcileLockedSelection();
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

// === Text Editing Selectors ===

export const selectTextEditingId = (state: SelectionStore) => state.textEditingId;
export const selectIsTextEditing = (state: SelectionStore) => state.textEditingId !== null;

// === Inline Style Selectors ===

export const selectInlineBold = (state: SelectionStore) => state.inlineStyles.bold;
export const selectInlineItalic = (state: SelectionStore) => state.inlineStyles.italic;
export const selectInlineHighlightColor = (state: SelectionStore) => state.inlineStyles.highlightColor;

// === Cross-store: device-ui-store -> selection-store ===
// One-way reaction (selection-store knows about device-ui-store; not the reverse).
// Leaving 'select' clears any pending selection so other tools start clean.
useDeviceUIStore.subscribe(
  (s) => s.tool.active,
  (_next, prev) => {
    if (prev === 'select') useSelectionStore.getState().clearSelection();
  },
);

// === Cross-module: ephemeral lock reactions ===
// Maintains the centerpiece invariant — outside an active gesture, `selectedIds` never
// contains a remote-locked id — so selection-actions / z-actions / convert-kind / delete /
// cut / keyboard paths need zero per-callsite guards. Pickers keep locked ids from ever
// entering a selection; this prunes locks that land on an existing one.

function pruneRemoteLockedSelection(): void {
  const s = useSelectionStore.getState();
  if (s.selectedIds.length === 0) return;
  const lo = getLockOwners();
  const kept = s.selectedIds.filter((id) => {
    const h = getHandle(id);
    return !h || lo[h.slot] <= 1;
  });
  if (kept.length !== s.selectedIds.length) {
    s.setSelection(kept); // setSelection([]) routes to clearSelection
    invalidateOverlay();
  }
}

onRemoteLocksApplied((ids) => {
  const s = useSelectionStore.getState();
  let selectionHit = false;
  let textHit = false;
  let codeHit = false;
  for (const id of ids) {
    if (s.selectedIdSet.has(id)) selectionHit = true;
    if (id === s.textEditingId) textHit = true;
    else if (id === s.codeEditingId) codeHit = true;
  }
  // Force-close mirrors the remote-delete bridge in onObjectsDeleted — the peer owns the
  // object now; tool teardown handles DOM unmount + invalidation (the rare race loss).
  if (textHit) textTool.commitAndClose();
  if (codeHit) codeTool.commitAndClose();
  if (selectionHit) {
    if (s.transform.kind !== 'none')
      _lockPrunePending = true; // deferred — see the flag's comment
    else pruneRemoteLockedSelection();
  }
});
