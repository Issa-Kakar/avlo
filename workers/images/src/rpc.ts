import { WorkerEntrypoint } from 'cloudflare:workers';
import { validateImage } from '@avlo/shared';
import { fetchBytesCapped, type ImagesRpcSurface, retryTransient, sha256Hex, traceRpc } from '@avlo/worker-shared';

const AVATAR_MAX_BYTES = 1024 * 1024; // 1 MiB — avatars are small; the cap bounds the SSRF/abuse blast radius
const AVATAR_FETCH_TIMEOUT_MS = 5000;

// Belt & braces over the verified-claim provenance: the picture URL comes out of a
// signature-checked Google ID token, but this worker still refuses to egress-fetch
// anything that isn't Google's avatar CDN. A trailing-dot FQDN fails endsWith → refused.
function isAllowedAvatarHost(hostname: string): boolean {
  return hostname === 'googleusercontent.com' || hostname.endsWith('.googleusercontent.com');
}

/**
 * Binary RPC surface called only by the auth worker's OAuth callback (§9): snapshot a
 * Google profile photo into R2 under the content-addressed, write-once key
 * `avatars/<sha256[0..32)>`. Content addressing is load-bearing, not aesthetic — the SW
 * is cache-first for the whole images origin, so a mutable `avatars/<userId>` key would
 * be pinned forever client-side; the hash IS the version (unchanged photo → same URL →
 * every cache stays warm; changed photo → new URL propagated by reference via /me).
 *
 * Recipe, fail-closed at every step: https + googleusercontent host allowlist → rewrite a
 * trailing `=s<N>(-c)` size suffix to `=s256-c` (96 px default is too small for retina) →
 * ONE capped+timed fetch (no retry — retries would stack timeouts into login latency) →
 * magic-byte sniff (detected mime becomes the stored contentType, never Google's header) →
 * head-then-put (put retried — idempotent). Returns the 32-hex hash, or `null` on ANY
 * failure; NEVER throws — a missing avatar must not fail sign-in. Logs are reason-only
 * (H10): the URL embeds a per-user CDN token.
 */
export class ImagesRpc extends WorkerEntrypoint<Env> implements ImagesRpcSurface {
  async ingestAvatar(pictureUrl: string): Promise<string | null> {
    return traceRpc(
      this.env,
      'images.ingestAvatar',
      () => this.#ingestAvatar(pictureUrl),
      (r) => (r ? 'hash' : 'null'),
    );
  }

  async #ingestAvatar(pictureUrl: string): Promise<string | null> {
    try {
      const url = new URL(pictureUrl);
      if (url.protocol !== 'https:' || !isAllowedAvatarHost(url.hostname)) {
        console.warn('[images] avatar ingest refused: disallowed origin');
        return null;
      }
      url.pathname = url.pathname.replace(/=s\d+(?:-c)?$/, '=s256-c');

      const fetched = await fetchBytesCapped(url.toString(), AVATAR_MAX_BYTES, { timeoutMs: AVATAR_FETCH_TIMEOUT_MS });
      if (!fetched) {
        console.warn('[images] avatar ingest failed: fetch non-OK or oversize');
        return null;
      }
      const { valid, mimeType } = validateImage(fetched.bytes);
      if (!valid) {
        console.warn('[images] avatar ingest failed: unsupported image format');
        return null;
      }

      const hash = (await sha256Hex(fetched.bytes)).slice(0, 32);
      const key = `avatars/${hash}`;
      if (!(await this.env.IMAGES.head(key))) {
        await retryTransient(() => this.env.IMAGES.put(key, fetched.bytes, { httpMetadata: { contentType: mimeType } }));
      }
      return hash;
    } catch {
      console.warn('[images] avatar ingest failed');
      return null;
    }
  }
}
