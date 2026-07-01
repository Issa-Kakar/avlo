import type * as Y from 'yjs';
import { create } from 'zustand';

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface HistoryActions {
  setHistoryState(canUndo: boolean, canRedo: boolean): void;
}

export const useHistoryStore = create<HistoryState & HistoryActions>((set, get) => ({
  canUndo: false,
  canRedo: false,
  setHistoryState(canUndo, canRedo) {
    const s = get();
    if (s.canUndo === canUndo && s.canRedo === canRedo) return;
    set({ canUndo, canRedo });
  },
}));

// Stable destructured action (defined once inside create(), never re-bound).
export const { setHistoryState } = useHistoryStore.getState();

// Scalar selectors — Object.is suffices.
export const selectCanUndo = (s: HistoryState) => s.canUndo;
export const selectCanRedo = (s: HistoryState) => s.canRedo;

/**
 * Subscribe to a Y.UndoManager's stack-mutation events and push canUndo/canRedo
 * into this store. Returned fn unbinds and resets the store to (false, false)
 * so the UI never lingers in an enabled state pointing at a destroyed UM.
 *
 * Initial state is provably (false, false): fresh UMs have empty stacks, and the
 * unbind reset on the previous UM (if any) already cleared the store.
 */
export function bindUndoManagerToHistoryStore(um: Y.UndoManager): () => void {
  const update = () => setHistoryState(um.canUndo(), um.canRedo());
  um.on('stack-item-added', update);
  um.on('stack-item-popped', update);
  um.on('stack-cleared', update);
  return () => {
    um.off('stack-item-added', update);
    um.off('stack-item-popped', update);
    um.off('stack-cleared', update);
    setHistoryState(false, false);
  };
}
