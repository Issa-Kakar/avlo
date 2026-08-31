import {
  AI_CLOSE_FORBIDDEN,
  AI_CLOSE_UNAUTHENTICATED,
  AI_DATA_PART_QUOTA,
  AI_EST_OUT_TOKENS,
  AI_TOKEN_WEIGHT_IN,
  AI_TOKEN_WEIGHT_OUT,
  type AiAgentState,
  type AiQuotaVerdict,
  type AiReserveEstimate,
  parseAgentName,
  type UserId,
} from '@avlo/shared';
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import type { Connection, ConnectionContext } from 'agents';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { PromptTooLongError, toModelMessages } from './context';
import type { AiWorkerEnv } from './env';
import { generateImage } from './image-gen';
import { SYSTEM_PROMPT } from './prompt';
import { chatModel, providerHeaders, providerOptions } from './providers';
import { makeTools } from './tools';

/**
 * Reject-close for the WS handshake path — DEFENSE IN DEPTH ONLY. The edge
 * gate (`gate.ts`) rejects unauthenticated/mismatched upgrades pre-DO, so this
 * fires only if a request somehow reaches the DO unstamped. `onConnect` runs
 * BEFORE partyserver returns the 101 and a close issued in that window races
 * the pair hand-off (the frame can be lost — observed under workerd), so the
 * close is deferred past the handshake. The residual race is acceptable here
 * precisely because this path is not the enforcement point.
 */
function closeAfterHandshake(connection: Connection, code: number, reason: string): void {
  setTimeout(() => connection.close(code, reason), 250);
}

/**
 * The per-(user, room) chat agent — instance name `<userId>:<roomId>`
 * (`buildAgentName`), addressed only through the edge gate (`gate.ts`).
 *
 * AIChatAgent supplies the transport spine: `this.messages` persisted in
 * DO-SQLite, resumable streams (chunks buffered + replayed on reconnect; the
 * DO keeps consuming the model stream after the browser drops — pending IO
 * pins a DO), and client-side tool execution (`canvas`/`canvas_read` have no
 * `execute`, so they surface in the panel's `onToolCall`).
 *
 * One turn = reserve quota → streamText → settle actuals. The LLM sees only
 * SYSTEM_PROMPT + tool schemas + converted history — never the request, env,
 * or headers. Identity comes exclusively from the DO name (edge-verified);
 * `onConnect` is the close-code authority (4401 unauthenticated / 4403 name
 * mismatch — sync's H27 convention; HTTP paths got real statuses at the edge).
 */
export class AvloAiAgent extends AIChatAgent<AiWorkerEnv, AiAgentState> {
  override initialState: AiAgentState = { quota: null };

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const stamped = ctx.request.headers.get('x-avlo-user-id');
    if (!stamped) {
      closeAfterHandshake(connection, AI_CLOSE_UNAUTHENTICATED, 'unauthenticated');
      return;
    }
    const parsed = parseAgentName(this.name);
    if (!parsed || parsed.userId !== stamped) {
      closeAfterHandshake(connection, AI_CLOSE_FORBIDDEN, 'forbidden');
      return;
    }
    await super.onConnect(connection, ctx);
  }

  override async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions): Promise<Response> {
    const parsed = parseAgentName(this.name);
    if (!parsed) return textResponse('This assistant instance is misaddressed. Reload the page.');
    const userId = parsed.userId;

    // Reserve BEFORE the model runs; the estimate stands unless settle replaces
    // it (abort/disconnect/stream error ⇒ no settle ⇒ conservative charge).
    const estimate = estimateReserve(this.messages);
    const quota = this.env.AI_QUOTA.getByName(userId);
    const verdict = await quota.reserve(estimate);
    this.setState({ ...this.state, quota: verdict.snapshot });
    if (!verdict.ok) return quotaDeniedResponse(verdict);

    const tools = makeTools({
      enabled: this.env.AI_IMAGES_ENABLED === '1',
      generate: async (input) => {
        // Images carry their own budget — reserved at execution time, not per turn.
        const imageVerdict = await quota.reserve({ msgs: 0, tokens: 0, images: 1 });
        this.setState({ ...this.state, quota: imageVerdict.snapshot });
        if (!imageVerdict.ok) return { error: 'image budget exhausted for today' };
        return generateImage(this.env, input);
      },
    });

    let modelMessages: Awaited<ReturnType<typeof toModelMessages>>;
    try {
      modelMessages = await toModelMessages(this.messages, tools);
    } catch (err) {
      if (err instanceof PromptTooLongError) return textResponse('That message is too long — please shorten it.');
      throw err;
    }

    const settle = async (usage: { inputTokens?: number; outputTokens?: number }) => {
      const snapshot = await quota.settle({
        reserved: estimate,
        actual: { tokensIn: usage.inputTokens ?? 0, tokensOut: usage.outputTokens ?? 0, images: 0 },
      });
      this.setState({ ...this.state, quota: snapshot });
    };

    const result = streamText({
      model: chatModel(this.env),
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      // Server-executed tools (generate_image) may need a follow-up step;
      // client tools end the stream (the panel executes + auto-continues).
      stopWhen: stepCountIs(5),
      // REQUIRED: without the signal a user "stop" ends the UI stream but the
      // model call keeps running — and billing.
      abortSignal: options?.abortSignal,
      headers: providerHeaders(this.env, userId),
      providerOptions: providerOptions(),
      onFinish: async (event) => {
        await settle(event.totalUsage);
        await onFinish(event as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
      },
    });

    return result.toUIMessageStreamResponse();
  }
}

/**
 * Weighted-unit reserve for one turn: full history in chars/4 as the input
 * estimate (context blocks included — they dominate) + the flat output
 * allowance. Coarse on purpose; settle() replaces it with provider actuals.
 */
function estimateReserve(messages: UIMessage[]): AiReserveEstimate {
  let chars = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type.startsWith('data-')) chars += JSON.stringify((part as { data?: unknown }).data ?? '').length;
    }
  }
  return {
    msgs: 1,
    tokens: Math.ceil(chars / 4) * AI_TOKEN_WEIGHT_IN + AI_EST_OUT_TOKENS * AI_TOKEN_WEIGHT_OUT,
    images: 0,
  };
}

/** Plain assistant-text stream (guard failures — no model call happened). */
function textResponse(text: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = 'guard';
      writer.write({ type: 'text-start', id });
      writer.write({ type: 'text-delta', id, delta: text });
      writer.write({ type: 'text-end', id });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Quota denial: a `data-quota` part (the panel renders retry-after from it)
 * plus a readable text fallback. The denial is itself persisted history — the
 * context transform strips data parts, so the model never sees it.
 */
function quotaDeniedResponse(verdict: AiQuotaVerdict & { ok: false }): Response {
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  const human =
    verdict.reason === 'minute'
      ? `You're sending messages too quickly — try again in ${seconds}s.`
      : `You've reached today's AI limit (${verdict.reason.replace('day-', '')}). It resets at midnight UTC.`;
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: `data-${AI_DATA_PART_QUOTA}`, data: verdict } as Parameters<typeof writer.write>[0]);
      const id = 'quota';
      writer.write({ type: 'text-start', id });
      writer.write({ type: 'text-delta', id, delta: human });
      writer.write({ type: 'text-end', id });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

// Re-exported so gate.ts/index.ts stay import-light and `wrangler types`
// resolves the DO classes from src/index.
export type { UserId };
