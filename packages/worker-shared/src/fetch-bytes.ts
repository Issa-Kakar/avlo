/**
 * Byte-level fetch primitives shared by unfurl (OG images / favicons), images upload
 * (hash-verify), and the avatar ingest RPC. SILENT BY DESIGN (H10): no URL, status, or
 * size logging in shared code — call sites own their (redacted or grandfathered)
 * diagnostics.
 */

/** SHA-256 → lowercase hex. The content-addressing primitive (H4). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * ONE bounded fetch attempt: hard timeout via `AbortSignal.timeout` (covers connect AND
 * body streaming) + a byte cap enforced while reading — the reader cancels mid-stream the
 * moment the cap is exceeded, so at most `maxBytes` (+ one chunk) is ever buffered.
 * Returns `null` on non-OK / missing body / oversize; network errors and timeouts THROW
 * (callers decide between warn-and-null and propagation). No retry here — wrap in
 * `retryTransient` only when the fetch is idempotent and the caller is latency-tolerant.
 */
export async function fetchBytesCapped(
  url: string,
  maxBytes: number,
  opts?: { timeoutMs?: number; userAgent?: string },
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const res = await fetch(url, {
    headers: opts?.userAgent ? { 'User-Agent': opts.userAgent } : undefined,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 5000),
  });
  if (!res.ok || !res.body) return null;

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
