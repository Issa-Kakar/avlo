import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { AiWorkerEnv } from './env';

/**
 * Provider registry — the ONE place model/provider selection lives. Everything
 * degrades by configuration, never by code change:
 *
 *   chat: Gemini (`gemini-3.5-flash`, the stable agentic workhorse) when
 *         GOOGLE_AI_STUDIO_API_KEY is set, optionally routed through Cloudflare
 *         AI Gateway (google-ai-studio provider path — BYOK/Vertex later are a
 *         URL+auth swap here, bodies stay Gemini-shaped). Otherwise the
 *         Workers AI binding (`glm-4.7-flash`, solid multi-turn tool calling,
 *         no key needed — bills neurons, incl. local dev).
 *
 * Future lanes (see docs/ai/providers.md): OpenRouter fallback via the gateway,
 * Vertex service-account BYOK, the Gemini Interactions API adapter (server-side
 * state; @ai-sdk/google already ships Interactions types), gemini-3.1-flash-image.
 */

export const CHAT_MODEL_GEMINI = 'gemini-3.5-flash';
export const CHAT_MODEL_WORKERS_AI = '@cf/zai-org/glm-4.7-flash';
export const IMAGE_MODEL_WORKERS_AI = '@cf/black-forest-labs/flux-1-schnell';

/** AI Gateway base for the google-ai-studio provider path, or null when unconfigured. */
function gatewayGoogleBaseUrl(env: AiWorkerEnv): string | null {
  if (!env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME) return null;
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/google-ai-studio/v1beta`;
}

export function chatModel(env: AiWorkerEnv): LanguageModel {
  if (env.GOOGLE_AI_STUDIO_API_KEY) {
    const baseURL = gatewayGoogleBaseUrl(env);
    const google = createGoogleGenerativeAI({
      apiKey: env.GOOGLE_AI_STUDIO_API_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
    return google(CHAT_MODEL_GEMINI);
  }
  return createWorkersAI({ binding: env.AI })(CHAT_MODEL_WORKERS_AI);
}

/**
 * Per-user cost attribution in AI Gateway logs (`cf-aig-metadata`, ≤5 flat
 * entries). Only meaningful on the gateway path — omitted otherwise so the
 * direct-provider request stays clean.
 */
export function providerHeaders(env: AiWorkerEnv, userId: string): Record<string, string> | undefined {
  if (!gatewayGoogleBaseUrl(env) || !env.GOOGLE_AI_STUDIO_API_KEY) return undefined;
  return { 'cf-aig-metadata': JSON.stringify({ user: userId }) };
}

/**
 * Thinking bills at output rate — the biggest output-cost lever. Canvas edits
 * are routine tool work: `low` keeps latency + cost down (the model "thinks"
 * through intent strings instead). Ignored by non-Gemini models.
 */
export function providerOptions() {
  // Inferred literal type — `ai` doesn't export its ProviderOptions alias.
  return { google: { thinkingConfig: { thinkingLevel: 'low' as const } } };
}
