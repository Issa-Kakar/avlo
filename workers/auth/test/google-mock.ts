/**
 * Google OAuth network doubles for the /callback pipeline, on MSW (`@avlo/test-support/msw`
 * — the shared `installMswServer` wiring) + the static RSA keys in `test-keys.ts`.
 *
 * Signing is fully deterministic: `GOOD_KEY_PKCS8` signs verifiable ID tokens and
 * `GOOD_JWK` (its public half) is served as the JWKS; `WRONG_KEY_PKCS8` signs tokens the
 * JWKS can never verify. Static keys dissolve the old "one runtime keypair per file"
 * constraint — jose's `createRemoteJWKSet` still caches per worker module instance, but
 * every file now publishes the SAME byte-stable JWKS, so the cache can never go stale.
 *
 * Lives here (not test-support/) because it's auth-specific — Google's endpoints, the
 * worker's client id/redirect URI, the ID-token claim shapes. Nothing else consumes it.
 *
 * The MSW server is installed at module scope: each test FILE gets its own isolate and
 * module registry, so this is one server per importing file — exactly the pool-workers
 * pattern `installMswServer` documents. Its afterEach `resetHandlers()` wipes
 * `server.use()` registrations, so the persistent JWKS handler is re-armed per test.
 */
import { env } from 'cloudflare:test';
import { HttpResponse, http, installMswServer } from '@avlo/test-support/msw';
import { importPKCS8, SignJWT } from 'jose';
import { beforeEach } from 'vitest';
import { GOOD_JWK, GOOD_KEY_PKCS8, WRONG_KEY_PKCS8 } from './test-keys';

export const { server, requested } = installMswServer();

const goodKey = await importPKCS8(GOOD_KEY_PKCS8, 'RS256');
const wrongKey = await importPKCS8(WRONG_KEY_PKCS8, 'RS256');

// PERSISTENT (non-once) JWKS: jwtVerify fetches it lazily on the first verify, then jose
// caches per module instance — later verifies in the same file may never re-fetch.
beforeEach(() => {
  server.use(
    http.get('https://www.googleapis.com/oauth2/v3/certs', () =>
      HttpResponse.json({ keys: [{ ...GOOD_JWK, kid: 'test-key', alg: 'RS256', use: 'sig' }] }),
    ),
  );
});

export interface IdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  name?: string;
  picture?: string;
  /** Override the audience (default: the worker's client id). */
  aud?: string;
  /** Override the issuer (default: Google's). */
  iss?: string;
  /** Sign with a key the JWKS does not contain. */
  wrongKey?: boolean;
}

/** A real RS256 ID token with the given claims; defaults form a verifiable happy path. */
export async function signIdToken(claims: IdTokenClaims = {}): Promise<string> {
  const { wrongKey: useWrongKey, aud, iss, ...rest } = claims;
  return new SignJWT({
    sub: 'google-sub-1',
    email: 'user@example.com',
    email_verified: true,
    nonce: 'test-nonce',
    ...rest,
  })
    .setProtectedHeader({ alg: 'RS256', kid: useWrongKey ? 'unknown-key' : 'test-key' })
    .setIssuer(iss ?? 'https://accounts.google.com')
    .setAudience(aud ?? env.GOOGLE_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(useWrongKey ? wrongKey : goodKey);
}

export interface TokenMockOpts {
  /** When given, the exchange's `code_verifier` must satisfy base64url(sha256(verifier)) === challenge. */
  expectedChallenge?: string;
}

/**
 * Mock ONE token-endpoint exchange returning `idToken` — and VERIFY the exchange request:
 * a malformed grant (wrong grant_type, missing code, wrong redirect_uri, absent
 * code_verifier, or — with `expectedChallenge` — a verifier that doesn't S256-hash to the
 * registered challenge) gets a 400 with a distinctive body instead of tokens. The
 * callback maps that to auth=error, failing the happy-path test loudly.
 */
export function installTokenMock(idToken: string, opts: TokenMockOpts = {}): void {
  server.use(
    http.post(
      'https://oauth2.googleapis.com/token',
      async ({ request }) => {
        const form = await request.formData(); // application/x-www-form-urlencoded
        const field = (name: string): string => {
          const v = form.get(name);
          return typeof v === 'string' ? v : '';
        };
        const fail = (reason: string) => {
          console.error(`[google-mock] token exchange assertion failed: ${reason}`);
          return HttpResponse.json({ error: 'invalid_request', error_description: `[google-mock] ${reason}` }, { status: 400 });
        };
        if (field('grant_type') !== 'authorization_code') return fail(`grant_type=${field('grant_type')}`);
        if (!field('code')) return fail('missing code');
        if (field('redirect_uri') !== env.OAUTH_REDIRECT_URI) return fail(`redirect_uri=${field('redirect_uri')}`);
        const verifier = field('code_verifier');
        if (!verifier) return fail('missing code_verifier');
        if (opts.expectedChallenge !== undefined && (await s256(verifier)) !== opts.expectedChallenge) {
          return fail('code_verifier does not S256-hash to the registered code_challenge');
        }
        return HttpResponse.json({
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: idToken,
        });
      },
      { once: true },
    ),
  );
}

/** Mock ONE failing token exchange (Google rejects the code). */
export function installTokenFailureMock(): void {
  server.use(
    http.post('https://oauth2.googleapis.com/token', () => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }), {
      once: true,
    }),
  );
}

/** base64url(sha256(input)) — the PKCE S256 challenge derivation, computed independently. */
async function s256(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
