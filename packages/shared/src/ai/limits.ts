/**
 * AI quota + guard constants — the ONE table both sides read: the `AiQuota` DO
 * enforces (server, authoritative), the client pre-guards + renders remaining
 * quota (UX only, never a security boundary).
 *
 * ⚠ EVERY NUMBER HERE IS A MUTABLE SCAFFOLD VALUE — NOT A SHIP VALUE, NOT AN
 * INVARIANT. This file was authored at the very first integration step, before
 * any real usage data or cost model existed; values are deliberately loose so
 * development isn't fighting the limiter (e.g. 200 msgs/day would absolutely
 * not ship). Refine them once concrete integrations are wired in and real
 * per-turn costs are measured (see docs/ai/providers.md for the cost table
 * they were roughed against). The SHAPES are the contract — per-minute burst,
 * per-day message/token/image buckets, weighted token accounting, the
 * reserve/settle protocol — the values are not.
 */

/** Messages per rolling minute window — burst brake. */
export const AI_MSGS_PER_MIN = 6;

/** Messages per UTC day. */
export const AI_MSGS_PER_DAY = 200;

/**
 * Weighted model tokens per UTC day. Output tokens cost ~4-6x input on every
 * provider we route to, so budget accounting weights them: charged units =
 * `in × AI_TOKEN_WEIGHT_IN + out × AI_TOKEN_WEIGHT_OUT`.
 */
export const AI_TOKENS_PER_DAY = 500_000;
export const AI_TOKEN_WEIGHT_IN = 1;
export const AI_TOKEN_WEIGHT_OUT = 4;

/** Generated images per UTC day. */
export const AI_IMAGES_PER_DAY = 20;

/**
 * Weighted-token reserve estimate for one turn's OUTPUT, charged up-front by
 * `reserve()` before the model runs and replaced by actuals at `settle()`.
 * Deliberately conservative: an aborted/disconnected turn keeps its estimate
 * (no settle ⇒ no refund), so aborting can't launder tokens.
 */
export const AI_EST_OUT_TOKENS = 2_000;

/** Max user prompt length in chars — client guard AND server re-check. */
export const AI_MAX_PROMPT_CHARS = 4_000;

/** Max serialized `CanvasContext` bytes — client cap AND server re-check. */
export const AI_MAX_CONTEXT_BYTES = 32_768;

/** Client-side minimum interval between sends (UX debounce). */
export const AI_MIN_SEND_INTERVAL_MS = 2_000;

/** Viewport objects serialized at blurry detail before overflow clusters. */
export const AI_CONTEXT_VIEWPORT_CAP = 150;
