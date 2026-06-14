import { zValidator } from '@hono/zod-validator';
import { generateCodeVerifier, generateState } from 'arctic';
import { setSignedCookie } from 'hono/cookie';
import { createFactory } from 'hono/factory';
import type { z } from 'zod/v4';
import type { AuthEnv } from '../env';
import { FLOW_COOKIE, flowCookieOpts, makeGoogle } from '../oauth';
import { loginQuery, type OAuthFlowToken, sanitizeReturnTo } from '../zod/oauth';

const factory = createFactory<AuthEnv>();

const SCOPES = ['openid', 'email', 'profile'];

/**
 * `GET /login/google` — top-level nav in. PKCE S256 challenge + state + nonce, all minted
 * here and sealed into ONE signed single-use flow cookie (the callback's only memory of
 * this attempt). `prompt=select_account` so a shared machine always gets the chooser.
 * Deliberately NO `access_type=offline`: Google tokens are never stored — the ID token is
 * consumed once at the callback and dropped.
 */
export const handleLogin = factory.createHandlers(zValidator('query', loginQuery), async (c) => {
  const returnTo = sanitizeReturnTo(c.req.valid('query').return_to);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const nonce = crypto.randomUUID();

  const url = makeGoogle(c.env).createAuthorizationURL(state, codeVerifier, SCOPES);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account');

  const flow = JSON.stringify({ state, codeVerifier, nonce, returnTo, iat: Date.now() } satisfies z.input<typeof OAuthFlowToken>);
  await setSignedCookie(c, FLOW_COOKIE, flow, c.env.OAUTH_PKCE_SECRET, flowCookieOpts(c.req.raw));
  return c.redirect(url.toString(), 302);
});
