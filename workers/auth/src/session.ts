import { parseCookieHeader, retryTransient, sha256Hex } from '@avlo/worker-shared';
import type { z } from 'zod/v4';
import { SessionRecord, type SessionRecordT } from './zod/session';

/**
 * Opaque KV sessions. The cookie value is a 256-bit random capability; the KV key is its
 * SHA-256 (`sess:<hex>`), so a KV dump yields no usable tokens. Reads use `cacheTtl: 60`
 * — a deleted/expired session can keep verifying for ≤60 s at a colo (stolen-token-only
 * impact; the owner's cookie is cleared synchronously on logout). Writes are critical →
 * `retryTransient` (idempotent puts/deletes).
 */

export const SESSION_COOKIE = 'avlo_session';
export const SESSION_TTL_SEC = 400 * 24 * 60 * 60; // 400 d, sliding (browser Max-Age ceiling)
/** Re-put the KV record when remaining lifetime < this — at most one slide write / 5 d. */
export const SESSION_SLIDE_THRESHOLD_MS = 395 * 24 * 60 * 60 * 1000;

// 32 random bytes → base64url, 43 chars, no padding.
export function mintSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function sessionKvKey(token: string): Promise<string> {
  return `sess:${await sha256Hex(new TextEncoder().encode(token))}`;
}

export interface SessionHit {
  record: SessionRecordT;
  token: string;
  kvKey: string;
}

/**
 * Resolve `avlo_session` out of a raw Cookie header (works with or without a Hono ctx —
 * the RPC path has only the header). Shape-gates the token BEFORE any I/O (junk never
 * costs a hash or a KV read), then KV get → Zod parse → app-side exp check. Returns null
 * on any miss; THROWS only on KV infrastructure failure — callers choose between
 * degrade-to-anon (/me, verifySession) and treat-as-absent (callback, logout).
 */
export async function readSession(cookieHeader: string | null, kv: KVNamespace): Promise<SessionHit | null> {
  if (!cookieHeader) return null;
  const token = parseCookieHeader(cookieHeader, SESSION_COOKIE);
  if (!token || !TOKEN_RE.test(token)) return null;
  const kvKey = await sessionKvKey(token);
  const json = await kv.get(kvKey, { type: 'json', cacheTtl: 60 });
  if (json === null) return null;
  const parsed = SessionRecord.safeParse(json);
  if (!parsed.success) return null;
  if (parsed.data.exp <= Date.now()) return null;
  return { record: parsed.data, token, kvKey };
}

/** Critical write, retried. Record `exp` and KV `expirationTtl` move together. */
export function putSession(kv: KVNamespace, kvKey: string, record: z.input<typeof SessionRecord>): Promise<void> {
  return retryTransient(() => kv.put(kvKey, JSON.stringify(record), { expirationTtl: SESSION_TTL_SEC }));
}

/** Sliding renewal: same record, fresh `exp` (+TTL). `iat` keeps the original sign-in time. */
export function slideSession(kv: KVNamespace, kvKey: string, record: SessionRecordT): Promise<void> {
  return putSession(kv, kvKey, { ...record, exp: Date.now() + SESSION_TTL_SEC * 1000 });
}

/** Retried delete; KV TTL is the backstop when even the retries fail. */
export function deleteSession(kv: KVNamespace, kvKey: string): Promise<void> {
  return retryTransient(() => kv.delete(kvKey));
}
