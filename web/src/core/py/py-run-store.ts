/**
 * Ephemeral per-block run state — live phase + streaming stdout for the UI
 * (play-button toggle, status text, DOM overlay live output). NEVER written
 * to Y: peers see only the final one-commit output. Plain Zustand, no
 * persist (presence-store pattern); reset on reload.
 */

import { create } from 'zustand';
import type { PyRunPhase } from './py-protocol';

export interface PyRunEntry {
  runId: number;
  phase: PyRunPhase;
  /** Live stdout/stderr accumulation — editing-overlay display only. */
  liveOutput: string;
  startedAt: number;
  /** Download progress while phase === 'downloading'. */
  received?: number;
  total?: number;
}

interface PyRunState {
  runs: Map<string, PyRunEntry>; // blockId → entry
}

interface PyRunActions {
  upsertRun(blockId: string, entry: PyRunEntry): void;
  patchRun(blockId: string, patch: Partial<PyRunEntry>): void;
  appendOutput(blockId: string, chunk: string): void;
  clearRun(blockId: string): void;
}

export const usePyRunStore = create<PyRunState & PyRunActions>((set) => ({
  runs: new Map(),
  upsertRun: (blockId, entry) =>
    set((s) => {
      const runs = new Map(s.runs);
      runs.set(blockId, entry);
      return { runs };
    }),
  patchRun: (blockId, patch) =>
    set((s) => {
      const prev = s.runs.get(blockId);
      if (!prev) return s;
      const runs = new Map(s.runs);
      runs.set(blockId, { ...prev, ...patch });
      return { runs };
    }),
  appendOutput: (blockId, chunk) =>
    set((s) => {
      const prev = s.runs.get(blockId);
      if (!prev) return s;
      const runs = new Map(s.runs);
      runs.set(blockId, { ...prev, liveOutput: prev.liveOutput + chunk });
      return { runs };
    }),
  clearRun: (blockId) =>
    set((s) => {
      if (!s.runs.has(blockId)) return s;
      const runs = new Map(s.runs);
      runs.delete(blockId);
      return { runs };
    }),
}));

/** Imperative reads for canvas paint / hit paths (no React). */
export function getRunEntry(blockId: string): PyRunEntry | undefined {
  return usePyRunStore.getState().runs.get(blockId);
}

export const { upsertRun, patchRun, appendOutput, clearRun } = usePyRunStore.getState();
