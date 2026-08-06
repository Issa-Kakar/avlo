/**
 * Cookie minting for suites that exercise the REAL auth chain (sync's aux auth worker,
 * the auth suite itself). Mirrors two wire formats exactly:
 *  - hono/cookie signed cookies: `<value>.<base64(HMAC-SHA256(value))>`, URI-encoded
 *  - worker-shared's AnonToken payload `{ userId, iat, nonce }`
 * Dependency-free on purpose (runs inside workerd, lives outside any worker's
 * node_modules) — WebCrypto only.
 */

export async function hmacBase64(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** `name=<signed value>` — the exact shape hono's setSignedCookie writes. */
export async function signedCookie(name: string, value: string, secret: string): Promise<string> {
  return `${name}=${encodeURIComponent(`${value}.${await hmacBase64(value, secret)}`)}`;
}

/** A valid `avlo_anon` cookie for `userId` (must be a 26-char Crockford ULID). */
export async function mintAnonCookie(userId: string, secret: string, opts?: { iat?: number }): Promise<string> {
  const payload = JSON.stringify({ userId, iat: opts?.iat ?? Date.now(), nonce: crypto.randomUUID() });
  return signedCookie('avlo_anon', payload, secret);
}
