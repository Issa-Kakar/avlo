import { AI_HOST_PROD } from '@avlo/api-client';
import {
  AI_AGENT_KEBAB,
  AI_CLOSE_FORBIDDEN,
  AI_CLOSE_UNAUTHENTICATED,
  AI_DATA_PART_CONTEXT,
  AI_MAX_PROMPT_CHARS,
  AI_MIN_SEND_INTERVAL_MS,
  AI_TOOL_CANVAS,
  AI_TOOL_CANVAS_READ,
  type AiAgentState,
  buildAgentName,
  CanvasReadInput,
  type RoomId,
} from '@avlo/shared';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import { useCallback } from 'react';
import { executeCanvasActions } from '@/core/ai/apply-actions';
import { buildCanvasContext, readCanvas } from '@/core/ai/context-serializer';
import { bindAiConversation, resetAiConversation } from '@/core/ai/short-ids';
import { markAiSend, setAiQuota, useAiPanelStore } from '@/stores/ai-panel-store';
import { getUserId } from '@/stores/auth-store';

/**
 * The AI panel's transport glue: `useAgent` (WS to the per-(user,room) agent
 * DO — Vite `/agents` proxy in dev, `wss://ai.avlo.io` in prod) + the
 * `useAgentChat` layer (persisted messages, resumable streams, client-side
 * tool execution).
 *
 * Canvas tools execute HERE — `onToolCall` routes `canvas` to the executor
 * (one transact = one undo step) and `canvas_read` to the serializer, then
 * `addToolOutput` feeds the summary back; the server auto-continues the turn.
 *
 * `send()` carries the user text plus a `data-canvasContext` part — persisted
 * WITH the message (survives resume, keeps history append-only for the
 * implicit prompt cache; the worker inlines it deterministically). Client
 * guards here are UX only — the worker re-validates everything.
 */
export function useAiChat(roomId: RoomId) {
  // Per-room conversation state — resets only when the room actually changes.
  bindAiConversation(roomId);

  const agent = useAgent<AiAgentState>({
    agent: AI_AGENT_KEBAB,
    name: buildAgentName(getUserId(), roomId),
    host: AI_HOST_PROD ?? window.location.host,
    onStateUpdate: (state) => setAiQuota(state?.quota ?? null),
    // 4401/4403 are terminal (sync's H27 convention) — never reconnect into them.
    shouldReconnectOnClose: (e) => e.code !== AI_CLOSE_UNAUTHENTICATED && e.code !== AI_CLOSE_FORBIDDEN,
  });

  const chat = useAgentChat({
    agent,
    credentials: 'include',
    resume: true,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      if (toolCall.toolName === AI_TOOL_CANVAS) {
        addToolOutput({ toolCallId: toolCall.toolCallId, output: executeCanvasActions(toolCall.input) });
        return;
      }
      if (toolCall.toolName === AI_TOOL_CANVAS_READ) {
        const parsed = CanvasReadInput.safeParse(toolCall.input);
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: parsed.success ? readCanvas(parsed.data) : { error: 'invalid canvas_read input' },
        });
        return;
      }
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { error: `unknown client tool ${toolCall.toolName}` } });
    },
  });

  const busy = chat.isStreaming || chat.status === 'submitted';

  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > AI_MAX_PROMPT_CHARS) return false;
      if (busy) return false;
      if (Date.now() - useAiPanelStore.getState().lastSendAt < AI_MIN_SEND_INTERVAL_MS) return false;
      markAiSend();
      const context = buildCanvasContext();
      chat.sendMessage({
        parts: [{ type: 'text', text: trimmed }, ...(context ? [{ type: `data-${AI_DATA_PART_CONTEXT}` as const, data: context }] : [])],
      });
      return true;
    },
    [busy, chat.sendMessage],
  );

  const clear = useCallback(() => {
    chat.clearHistory();
    resetAiConversation();
  }, [chat.clearHistory]);

  return { ...chat, busy, send, clear };
}
