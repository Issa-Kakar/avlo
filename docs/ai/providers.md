# AI providers — facts + strategy (researched 2026-07, live-doc verified)

The registry (`workers/ai/src/providers.ts`) is the only place provider choice lives. Everything below is config, not code shape.

## Current lanes

| Role | Model | Price (per 1M in/out) | Status |
|---|---|---|---|
| Chat default | `gemini-3.5-flash` (AI Studio key) | $1.50 / $9.00 · cached reads $0.15 (90% off) | **wired** |
| Chat fallback | `@cf/zai-org/glm-4.7-flash` (Workers AI binding) | neurons; ~10k/day free | **wired** (no key needed; bills even in local dev) |
| Images | `@cf/black-forest-labs/flux-1-schnell` (~$0.0006/img) | — | wired behind `AI_IMAGES_ENABLED=1` (stub-grade) |
| Images later | `gemini-3.1-flash-image` ("Nano Banana 2", $0.067/1K img); `gemini-3-pro-image` $0.134 for text-heavy | — | registry entry TODO |
| Utility later | `gemini-3.1-flash-lite` ($0.25/$1.50) — classification/cheap calls | — | — |
| Heavy planning later | `gemini-3.1-pro-preview` ($2/$12) | — | — |
| Escape hatch | OpenRouter (`/openrouter/v1/chat/completions` via gateway; `models:[...]` fallback arrays; Gemini implicit caching passes through; no token markup, 5.5% credit fee) | — | — |

Typical whiteboard turn (~3k in / 500 out): **~$0.009–0.02; ~$0.005 warm-cache.** Quota placeholder numbers in `@avlo/shared/src/ai/limits.ts` were priced off this.

## Cloudflare AI Gateway

- Engaged when `AI_GATEWAY_ACCOUNT_ID` + `AI_GATEWAY_NAME` are set: Gemini calls route via the **google-ai-studio provider path** (`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/google-ai-studio/v1beta` — path passthrough, bodies unchanged). Create the gateway in dash → AI → AI Gateway.
- **Universal Endpoint is DEPRECATED.** Modern shapes: provider paths, the OpenAI-compat endpoint (`/compat/chat/completions`, model = `{provider}/{model}`), and **Dynamic Routing** (`dynamic/{route}` — conditional/percentage/rate-limit/**budget-limit** nodes keyed off metadata; the blessed fallback + spend-ceiling mechanism; configure in dash, no code).
- **BYOK**: store provider keys in the gateway (worker then sends only `cf-aig-authorization: Bearer <token>`; any Run token can spend every stored key in the account). `aws-bedrock` BYOK even does SigV4 signing; **Vertex BYOK mints OAuth from a stored service account** — this is the Workers-friendly Vertex path.
- `cf-aig-metadata` (≤5 flat entries) — we send `{user}` for per-user cost attribution in gateway logs.
- Caching is exact-match-full-body (useless for chat); gateway rate limiting is gateway-global — per-user budgets stay in OUR `AiQuota` DO.
- **Known caveats**: community reports of SSE glitches + under-tracked cost on streamed google-ai-studio responses through the gateway — test streaming through the gateway before relying on its cost numbers; the direct-provider path (gateway vars unset) is the fallback.

## Vertex AI (the $300 GCP credits)

- Gateway `google-vertex-ai` provider needs a **service account** (BYOK preferred; express-mode API keys are NOT supported by the gateway). Path: `/google-vertex-ai/v1/projects/{p}/locations/{region}/publishers/google/models/...` — use a CONCRETE region (`us-central1`), not `global`.
- Bodies stay Gemini-shaped ⇒ the switch is a URL + auth swap in `providers.ts`, not a rewrite.
- Note: the $300 credit covers any GCP service — including the **paid AI Studio "Generative Language API"** billed to a linked project; that may be the lower-friction burn path. Verify on the billing account.

## Gemini specifics that shaped the design

- **Interactions API is GA** (June 2026): `POST /v1beta/interactions`, steps-based schema, `previous_interaction_id` server-side state (55d paid), `background=true`, SSE. Google's recommended interface; `@ai-sdk/google` already ships Interactions types. **Future adapter**: server-side state kills thought-signature echoing and stops resending history.
- **Thought signatures are ENFORCED on Gemini 3.x** via generateContent: a functionCall without its echoed `thought_signature` next turn → 400. The AI SDK google provider handles the echo — one more reason all model I/O goes through it.
- **Implicit caching**: default-on; min stable prefix 4,096 tokens on 3.5-flash; hits shown in `usageMetadata.cachedContentTokenCount`. Our layout (byte-stable system+tools first, append-only history, deterministic context inlining) exists to farm this. Explicit `cachedContents` is NOT available on Interactions and loses to implicit for chat loops.
- **Thinking bills at output rate** — `thinkingLevel: 'low'` is the biggest output-cost lever (3.5-flash default is `medium`). Leave temperature at 1.0 on Gemini 3.
- **Code execution tool** (`{type:"code_execution"}`): 30s Python sandbox, fixed libs, no pip/network, matplotlib images returned inline, intermediate tokens billed as INPUT, combinable with function calling on Gemini 3+ — the future code-block lane (generate + run snippets) once the new code-block system lands.
- Function calling: parallel calls supported; return all calls then all responses (interleaving → 400); structured output + tools combinable on Gemini 3+ only.

## Workers AI notes

- Binding is remote-only (`remote: true`; local dev bills). `wrangler dev` needs `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` in env when not logged in.
- Strong tool-callers: `glm-4.7-flash` (CF's own agent-demo default), Kimi K2.x, `gpt-oss-120b` (known OpenAI-compat quirks — test per model).
- Pricing: $0.011/1k neurons, 10k/day free on every plan (shared dev+prod).
