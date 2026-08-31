import type { AuthRpcSurface, RefineBindings } from '@avlo/worker-shared';

/**
 * Secrets/vars supplied via `.dev.vars` locally and `wrangler secret put` in
 * prod. `wrangler types` folds them into `Env` only once a `.dev.vars` exists,
 * so they're declared here explicitly — all optional BY DESIGN: the provider
 * registry degrades (Gemini → Workers AI binding; gateway → direct; images →
 * disabled) instead of failing at boot.
 */
export interface AiSecrets {
  /** Gemini via AI Studio — the primary chat model. Absent ⇒ Workers AI fallback. */
  GOOGLE_AI_STUDIO_API_KEY?: string;
  /** Both set ⇒ Gemini calls route through Cloudflare AI Gateway (google-ai-studio provider path). */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_NAME?: string;
  /** '1' ⇒ the generate_image tool is registered (FLUX → shared R2). */
  AI_IMAGES_ENABLED?: string;
}

/** The runtime env both the worker and the DOs see. */
export type AiWorkerEnv = Env & AiSecrets;

/**
 * Hono env for the AI worker. `AUTH` is an untyped `Service` across wrangler
 * configs — retype it ONCE to the RPC surface (§5.1; pass the global `Env`,
 * never `Cloudflare.Env`). The two same-script DOs (`AvloAiAgent`, `AI_QUOTA`)
 * are already precisely typed by `wrangler types` (same-config class imports).
 */
export type AiEnv = { Bindings: RefineBindings<AiWorkerEnv, { AUTH: AuthRpcSurface }> };
