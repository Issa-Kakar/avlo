import { DurableObject } from 'cloudflare:workers';
import {
  AI_IMAGES_PER_DAY,
  AI_MSGS_PER_DAY,
  AI_MSGS_PER_MIN,
  AI_TOKEN_WEIGHT_IN,
  AI_TOKEN_WEIGHT_OUT,
  AI_TOKENS_PER_DAY,
  type AiActualUsage,
  type AiQuotaReason,
  type AiQuotaSnapshot,
  type AiQuotaVerdict,
  type AiReserveEstimate,
} from '@avlo/shared';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

/** Persisted bucket record — integer window ids (sync's `#gate` style), durable. */
interface Buckets {
  mWin: number;
  mMsgs: number;
  dWin: number;
  dMsgs: number;
  dTokens: number;
  dImages: number;
}

const ZERO: Buckets = { mWin: 0, mMsgs: 0, dWin: 0, dMsgs: 0, dTokens: 0, dImages: 0 };

/**
 * Per-USER durable AI budget — one instance per userId (`getByName(userId)`),
 * spanning every room's agent. The authoritative limiter: the edge `RL_AI`
 * binding is per-colo smoothing, this is exact accounting.
 *
 * Reserve/settle protocol (STATELESS reservations):
 *  - `reserve(est)` before each model turn — rolls the lazy windows, denies
 *    with a reason + retry-after, else charges the estimate and persists.
 *  - `settle({reserved, actual})` at most once, from the turn's `onFinish` —
 *    swaps the estimated charge for weighted actuals. The agent passes its own
 *    `reserved` back, so no reservation table, no alarms, no sweeps.
 *  - Any failure between the two (abort, disconnect, stream error, isolate
 *    death) simply never settles: the conservative estimate stands. Aborting
 *    a turn can never refund tokens.
 *
 * Windows roll lazily on read — minute = `(now/60s)|0`, day = UTC day index.
 * All integer math; the caller is trusted first-party (the agent DO), so
 * double-settle is not defended, only documented.
 */
export class AiQuota extends DurableObject<Env> {
  async reserve(est: AiReserveEstimate): Promise<AiQuotaVerdict> {
    const now = Date.now();
    const q = await this.#rolled(now);

    const deny = (reason: AiQuotaReason, retryAfterMs: number): AiQuotaVerdict => ({
      ok: false,
      reason,
      retryAfterMs,
      snapshot: snap(q),
    });
    if (q.mMsgs + est.msgs > AI_MSGS_PER_MIN) return deny('minute', MIN_MS - (now % MIN_MS));
    if (q.dMsgs + est.msgs > AI_MSGS_PER_DAY) return deny('day-msgs', msToDayEnd(now));
    if (q.dTokens + est.tokens > AI_TOKENS_PER_DAY) return deny('day-tokens', msToDayEnd(now));
    if (q.dImages + est.images > AI_IMAGES_PER_DAY) return deny('day-images', msToDayEnd(now));

    q.mMsgs += est.msgs;
    q.dMsgs += est.msgs;
    q.dTokens += est.tokens;
    q.dImages += est.images;
    await this.ctx.storage.put('q', q);
    return { ok: true, snapshot: snap(q) };
  }

  async settle(s: { reserved: AiReserveEstimate; actual: AiActualUsage }): Promise<AiQuotaSnapshot> {
    const q = await this.#rolled(Date.now());
    const weighted = s.actual.tokensIn * AI_TOKEN_WEIGHT_IN + s.actual.tokensOut * AI_TOKEN_WEIGHT_OUT;
    q.dTokens = Math.max(0, q.dTokens + (weighted - s.reserved.tokens));
    q.dImages = Math.max(0, q.dImages + (s.actual.images - s.reserved.images));
    await this.ctx.storage.put('q', q);
    return snap(q);
  }

  /** Load + roll the lazy windows (no write — reserve/settle persist). */
  async #rolled(now: number): Promise<Buckets> {
    const q = (await this.ctx.storage.get<Buckets>('q')) ?? { ...ZERO };
    const mWin = (now / MIN_MS) | 0;
    const dWin = Math.floor(now / DAY_MS);
    if (q.mWin !== mWin) {
      q.mWin = mWin;
      q.mMsgs = 0;
    }
    if (q.dWin !== dWin) {
      q.dWin = dWin;
      q.dMsgs = 0;
      q.dTokens = 0;
      q.dImages = 0;
    }
    return q;
  }
}

const msToDayEnd = (now: number): number => DAY_MS - (now % DAY_MS);

const snap = (q: Buckets): AiQuotaSnapshot => ({
  minuteMsgsUsed: q.mMsgs,
  dayMsgsUsed: q.dMsgs,
  dayTokensUsed: q.dTokens,
  dayImagesUsed: q.dImages,
  dayResetAt: (q.dWin + 1) * DAY_MS,
});
