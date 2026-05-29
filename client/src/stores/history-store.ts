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
