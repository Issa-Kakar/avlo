import type { UserId } from '@avlo/shared';
import { cloudflareRateLimiter } from '@hono-rate-limiter/cloudflare';
import type { Context, Env as HonoEnv, MiddlewareHandler } from 'hono';

/**
 * Tier-1 rate limiter (§10/H26) — keys on the authed `userId`, never IP. A thin wrapper
 * over `@hono-rate-limiter/cloudflare` that bakes in the one invariant we care about
 * (`keyGenerator: c => c.get('userId')`); the caller supplies its own CF rate-limit
 * binding accessor and pins its concrete Hono env so the middleware composes cleanly.
 *
 * `requireAuth` must run first so `c.get('userId')` is populated. The CF binding is
 * per-colo / eventually-consistent and may not enforce in local dev — accepted; this is
 * abuse-smoothing, not a correctness boundary.
 */
export const userRateLimiter = <E extends HonoEnv & { Variables: { userId: UserId } }>(
  binding: (c: Context<E>) => RateLimit,
): MiddlewareHandler<E> => cloudflareRateLimiter<E>({ rateLimitBinding: binding, keyGenerator: (c) => c.get('userId') });

/**
 * Pre-auth IP rate limiter — keys on `cf-connecting-ip` (stamped by Cloudflare's edge on
 * every prod request; absent only in local dev, where all requests share the `'dev'`
 * bucket and the binding may not enforce anyway). For routes that run BEFORE identity
 * exists (OAuth /login /callback /logout); authed routes use `userRateLimiter`.
 */
export const ipRateLimiter = <E extends HonoEnv>(binding: (c: Context<E>) => RateLimit): MiddlewareHandler<E> =>
  cloudflareRateLimiter<E>({ rateLimitBinding: binding, keyGenerator: (c) => c.req.header('cf-connecting-ip') ?? 'dev' });
