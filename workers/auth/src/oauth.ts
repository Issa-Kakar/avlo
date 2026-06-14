import { Google } from 'arctic';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GoogleClaims, type GoogleClaimsT } from './zod/oauth';

export const FLOW_COOKIE = 'avlo_oauth';
export const FLOW_MAX_AGE_SEC = 600; // 10 min — ample for consent, tight for replay

/** Exact-redirect baseline: client id/secret/redirect URI all from env — NEVER derived
 *  from the request, so a Host/X-Forwarded game can't bend the redirect. */
export const makeGoogle = (env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'OAUTH_REDIRECT_URI'>): Google =>
  new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OAUTH_REDIRECT_URI);

/**
 * Flow-cookie attributes — the host-only variant of `cookieOpts` (no Domain even in prod:
 * only this worker's /callback ever reads it). SameSite=Lax, NOT Strict — Google's
 * redirect back is a cross-site top-level GET and Strict would drop the cookie exactly
 * when it's needed. Max-Age 600 mirrors the in-payload `iat` re-check.
 */
export function flowCookieOpts(req: Request) {
  const host = req.headers.get('host') ?? '';
  const dev = host.includes('localhost') || host.startsWith('127.0.0.1');
  return dev
    ? ({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: FLOW_MAX_AGE_SEC } as const)
    : ({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: FLOW_MAX_AGE_SEC } as const);
}

// Module scope is safe: createRemoteJWKSet performs NO I/O until the first verify, then
// caches keys per isolate (built-in cooldown + max age) — warm sign-ins skip the fetch.
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * The ID-token trust pipeline: jose proves signature (RS256 pinned — no alg confusion),
 * issuer, audience, and expiry (±5 s tolerance); Zod narrows the claim shape
 * (`email_verified` hard-required); the nonce must equal the flow cookie's — binding the
 * token to THIS browser's login attempt (a token minted for any other flow fails here).
 * Returns claims or null; never throws.
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string, expectedNonce: string): Promise<GoogleClaimsT | null> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
      clockTolerance: 5,
    }));
  } catch {
    return null;
  }
  const parsed = GoogleClaims.safeParse(payload);
  if (!parsed.success || parsed.data.nonce !== expectedNonce) return null;
  return parsed.data;
}
