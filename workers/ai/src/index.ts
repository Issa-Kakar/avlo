import { AI_AGENTS_PREFIX } from '@avlo/shared';
import { devRequestLogger, isAllowedOrigin, isDevHost } from '@avlo/worker-shared';
import { routeAgentRequest } from 'agents';
import { Hono } from 'hono';
import type { AiEnv } from './env';
import { makeGateHooks } from './gate';

export { AvloAiAgent } from './agent';
export { AiQuota } from './quota';

/**
 * avlo-ai — the AI host (`ai.avlo.io`). WSS + chat HTTP on `/agents/*` via
 * the Agents SDK; every other path 404s (pure worker, like sync).
 *
 * No `app-type.ts` mock / drift guard / `hc` client — the browser talks
 * Agents-SDK WS (`agents/react`), not typed HTTP-RPC. Exempt like sync; add
 * the mock the day a client-facing HTTP route lands.
 *
 * CORS: the WS upgrade needs none; the agent chat HTTP endpoints are
 * cross-origin from the SPA in prod, so non-WS responses get reflected
 * credentialed headers appended here (a mutable rewrap — DO-stub responses
 * are immutable, and the 101 must pass through untouched). Preflight is
 * answered inline; `hono/cors` is deliberately NOT used on this route: it
 * mutates `c.res` headers after `next()`, which throws on the immutable
 * upgrade response.
 */
const app = new Hono<AiEnv>();
app.use('*', devRequestLogger());

app.all(`/${AI_AGENTS_PREFIX}/*`, async (c) => {
  const reflected = isAllowedOrigin(c.req.header('origin'), isDevHost(c.req.header('host')));

  if (c.req.method === 'OPTIONS') {
    if (!reflected) return c.body(null, 403);
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': reflected,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  }

  const res = await routeAgentRequest(c.req.raw, c.env, makeGateHooks(c));
  if (!res) return c.notFound();
  if (res.webSocket) return res;

  const out = new Response(res.body, res);
  if (reflected) {
    out.headers.set('Access-Control-Allow-Origin', reflected);
    out.headers.set('Access-Control-Allow-Credentials', 'true');
    out.headers.append('Vary', 'Origin');
  }
  return out;
});

export default app;
export type AiApp = typeof app;
