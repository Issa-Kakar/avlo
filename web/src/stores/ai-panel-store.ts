import type { AiQuotaSnapshot } from '@avlo/shared';
import { create } from 'zustand';
import { createJSONStorage, persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

/**
 * AI panel UI state (device-ui-store structural model). Persisted: `open`
 * only — the panel reopens where you left it. Everything conversational
 * (messages, streaming) lives in the Agents SDK hooks (server-persisted in
 * the agent DO's SQLite); this store carries just the chrome-facing slice:
 * the open flag, the latest quota snapshot (pushed via agent state), and the
 * client-side send-interval guard timestamp.
 */

export interface AiPanelState {
  open: boolean;
  /** Latest server-pushed quota snapshot (null until the first turn/connect). */
  quota: AiQuotaSnapshot | null;
  /** Epoch ms of the last send — drives AI_MIN_SEND_INTERVAL_MS (UX guard). */
  lastSendAt: number;
}

interface AiPanelActions {
  openAiPanel(): void;
  closeAiPanel(): void;
  toggleAiPanel(): void;
  setAiQuota(quota: AiQuotaSnapshot | null): void;
  markAiSend(): void;
}

type AiPanelStore = AiPanelState & AiPanelActions;

export const useAiPanelStore = create<AiPanelStore>()(
  subscribeWithSelector(
    persist(
      immer((set) => ({
        open: false,
        quota: null,
        lastSendAt: 0,

        openAiPanel: () =>
          set((s) => {
            s.open = true;
          }),
        closeAiPanel: () =>
          set((s) => {
            s.open = false;
          }),
        toggleAiPanel: () =>
          set((s) => {
            s.open = !s.open;
          }),
        setAiQuota: (quota) =>
          set((s) => {
            s.quota = quota;
          }),
        markAiSend: () =>
          set((s) => {
            s.lastSendAt = Date.now();
          }),
      })),
      {
        name: 'avlo.ai-panel.v1',
        version: 1,
        storage: createJSONStorage(() => localStorage),
        // quota/lastSendAt are intentionally excluded — session-scoped.
        partialize: (s) => ({ open: s.open }),
      },
    ),
  ),
);

// Stable action exports (referentially stable for JSX handlers).
export const { openAiPanel, closeAiPanel, toggleAiPanel, setAiQuota, markAiSend } = useAiPanelStore.getState();

export const selectAiPanelOpen = (s: AiPanelStore) => s.open;
export const selectAiQuota = (s: AiPanelStore) => s.quota;
