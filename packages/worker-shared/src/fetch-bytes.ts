/**
 * Byte-level fetch primitives shared by unfurl (OG images / favicons), images upload
 * (hash-verify), and the avatar ingest RPC. SILENT BY DESIGN (H10): no URL, status, or
 * size logging in shared code — call sites own their (redacted or grandfathered)
 * diagnostics.
 */

import { isPrivateHost } from './ssrf';

/** SHA-256 → lowercase hex. The content-addressing primitive (H4). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest).toHex();
}

const MAX_REDIRECTS = 5;

export interface GuardedFetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Extra per-hop host allowlist layered ON TOP of the SSRF guard (avatar ingest pins googleusercontent). */
  hostAllowed?: (hostname: string) => boolean;
}

function guardedUrl(raw: string, base: string | undefined, hostAllowed?: (hostname: string) => boolean): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isPrivateHost(url.hostname)) return null;
  if (hostAllowed && !hostAllowed(url.hostname)) return null;
  return url;
}

/**
 * SSRF-guarded fetch: validates the target (http/https only, `isPrivateHost` refusal,
 * optional caller allowlist) on the FIRST hop and on EVERY redirect hop — `redirect:
 * 'follow'` would happily land a public URL on 169.254.169.254, and og:image/favicon
 * URLs are attacker-authored page content that never went through the Zod refine.
 * One `AbortSignal.timeout` spans the whole chain, so redirects can't stack timeouts.
 * Returns the final `Response` (caller checks `.ok`), or `null` when a hop is refused
 * or the chain exceeds MAX_REDIRECTS. Network errors and the timeout THROW, matching
 * plain `fetch` — callers decide between warn-and-null and propagation.
 */
export async function fetchGuarded(url: string, opts?: GuardedFetchOpts): Promise<Response | null> {
  const signal = AbortSignal.timeout(opts?.timeoutMs ?? 5000);
  let target = guardedUrl(url, undefined, opts?.hostAllowed);
  for (let redirects = 0; target; redirects++) {
    const res = await fetch(target.href, { headers: opts?.headers, redirect: 'manual', signal });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location === null) return res;
    await res.body?.cancel();
    if (redirects >= MAX_REDIRECTS) return null;
    target = guardedUrl(location, target.href, opts?.hostAllowed);
  }
  return null;
}

/**
 * ONE bounded fetch attempt over `fetchGuarded`: hard timeout via `AbortSignal.timeout`
 * (covers connect AND body streaming, across redirects) + a byte cap enforced while
 * reading — the reader cancels mid-stream the moment the cap is exceeded, so at most
 * `maxBytes` (+ one chunk) is ever buffered. Returns `null` on non-OK / missing body /
 * oversize / SSRF-refused hop; network errors and timeouts THROW (callers decide between
 * warn-and-null and propagation). No retry here — wrap in `retryTransient` only when the
 * fetch is idempotent and the caller is latency-tolerant.
 */
export async function fetchBytesCapped(
  url: string,
  maxBytes: number,
  opts?: { timeoutMs?: number; userAgent?: string; hostAllowed?: (hostname: string) => boolean },
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const res = await fetchGuarded(url, {
    timeoutMs: opts?.timeoutMs,
    headers: opts?.userAgent ? { 'User-Agent': opts.userAgent } : undefined,
    hostAllowed: opts?.hostAllowed,
  });
  if (!res?.ok || !res.body) return null;

  const contentType = res.headers.get('content-type') ?? '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}
