import { asUserId, type UserId, USER_ID_RE } from '@avlo/shared';
import { z } from 'zod/v4';

/**
 * Cookie attributes + the anon-token shape (mint + verify), single-sourced (§11/§14a).
 *
 * Issuance itself goes through `hono/cookie`'s `setSignedCookie`/`getSignedCookie`
 * on direct browser responses (H18). This module owns (a) the one attribute builder
 * both dev and prod share, (b) the `AnonToken` schema + `mintAnonToken` so the
 * payload shape is defined exactly once (the `/me` handler and the RPC verifier both
 * consume them), and (c) a raw HMAC verifier for the RPC path
 * (`AuthRpc.verifySession`) that has only a cookie header string, no Hono context.
 */

/** Resolved identity (§2). The trust boundary: `connection.state.userId` is server-set. */
export interface AuthCtx {
  userId: UserId;
  isAnon: boolean;
}

/**
 * Post-HMAC anon-token payload — the single source for both directions. `userId` is
 * format-gated by `USER_ID_RE` then branded, so a truncated/legacy cookie rejects
 * cleanly (→ re-mint) rather than feeding a half-id downstream (§14a).
 */
export const AnonToken = z.object({
  userId: z.string().regex(USER_ID_RE).transform(asUserId),
  iat: z.number(),
  nonce: z.string(),
});

/** Serialize a fresh anon-token payload for `setSignedCookie`. `satisfies z.input`
 *  ties the minted shape to the verifier's schema — they cannot drift. */
export function mintAnonToken(userId: UserId): string {
  return JSON.stringify({ userId, iat: Date.now(), nonce: crypto.randomUUID() } satisfies z.input<typeof AnonToken>);
}

/**
 * Cookie attributes shared by dev and prod. Host-only on localhost (no Domain, no
 * Secure — works over http); in prod `Secure` + `Domain=.avlo.io` so subdomain
 * workers receive the cookie for `verifySession`, `SameSite=Lax` for the OAuth
 * top-level redirect.
 */
export function cookieOpts(req: Request, maxAgeSec: number) {
  const host = req.headers.get('host') ?? '';
  const dev = host.includes('localhost') || host.startsWith('127.0.0.1');
  return dev
    ? ({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: maxAgeSec } as const)
    : ({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', domain: '.avlo.io', maxAge: maxAgeSec } as const);
}

/** Name of the signed anonymous-identity cookie. */
export const ANON_COOKIE = 'avlo_anon';

// Hono signs `value` (raw) → `${value}.${base64(HMAC-SHA256(value))}` →
// `encodeURIComponent(...)` → cookie. This verifier replicates that scheme exactly
// (utils/cookie.js: serializeSigned / parseSigned), so it validates whatever
// `setSignedCookie('avlo_anon', ...)` produced in the `/me` handler.
function parseCookieHeader(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function verifyHmac(signedValue: string, base64Signature: string, secret: string): Promise<boolean> {
  let bin: string;
  try {
    bin = atob(base64Signature);
  } catch {
    return false;
  }
  const sig = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) sig[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(signedValue));
}

/**
 * Verify the `avlo_anon` signed cookie out of a raw `Cookie` header (the RPC path,
 * no Hono context). Raw HMAC-SHA256 verify + Zod-parse `{userId, iat, nonce}`.
 * Returns the resolved anon identity or null. The account (`avlo_session` KV) branch
 * is the OAuth seam — added later.
 */
export async function verifyAnonToken(cookieHeader: string | null, secret: string): Promise<AuthCtx | null> {
  if (!cookieHeader) return null;
  const encoded = parseCookieHeader(cookieHeader, ANON_COOKIE);
  if (!encoded) return null;

  let raw: string;
  try {
    raw = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const signedValue = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  // Hono's base64 HMAC is always 44 chars ending in '=' — cheap pre-filter.
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  if (!(await verifyHmac(signedValue, signature, secret))) return null;

  let json: unknown;
  try {
    json = JSON.parse(signedValue);
  } catch {
    return null;
  }
  const parsed = AnonToken.safeParse(json);
  if (!parsed.success) return null;
  return { userId: parsed.data.userId, isAnon: true };
}
