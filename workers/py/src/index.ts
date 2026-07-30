import { createCors, cspError, cspHeaders, devRequestLogger, pyArtifactParam, pyBundleParam, syntheticCacheUrl } from '@avlo/worker-shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

// `.wasm` → `application/wasm` is load-bearing: WebAssembly.instantiateStreaming
// hard-requires it. `.mjs`/`.js` → text/javascript for the cross-origin import().
const MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.tar': 'application/x-tar',
};
const contentTypeFor = (file: string): string => MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';

/**
 * Immutable content-hashed artifact read with brotli negotiation + edge cache.
 * Accept-Encoding is read RAW off the request (H3 — never Zod'd): `br` support
 * tries the `.br` sibling key, null-falling back to identity (manifest.json
 * ships no .br). The br branch sets `encodeBody: 'manual'` so the runtime
 * passes the pre-compressed body through instead of re-encoding. Cold 304s
 * ride R2's `onlyIf` header parsing (`'body' in object` splits).
 *
 * Edge cache (`caches.default`): the ENCODING CLASS rides a synthetic key
 * (H7 — `py/<br|id>/<r2 key>`), so br↔identity variants can never poison each
 * other (a bare-URL key would). A br-class request that fell back to identity
 * (no `.br` sibling) caches that identity body under the br class — stable
 * forever, content is immutable per key. Bodies are stored WITHOUT
 * `Content-Encoding` (opaque bytes + `X-Avlo-Enc` marker) so the Cache API's
 * compressed-payload transcoding can never apply regardless of runtime
 * version; CE + `encodeBody:'manual'` are re-attached on the way out. Warm
 * 304s compare `If-None-Match` against the cached ETag manually (`includes`
 * handles list-valued + weak-prefixed values — weak compare is RFC-correct
 * for If-None-Match). Only 200s are cached (404/304 return before the put);
 * the put rides `waitUntil` on a tee'd stream, fail-open.
 */
async function servePyObject(
  bucket: R2Bucket,
  req: Request,
  ctx: { waitUntil(p: Promise<unknown>): void },
  key: string,
  file: string,
): Promise<Response> {
  const wantsBr = (req.headers.get('Accept-Encoding') ?? '').includes('br');
  const cache = caches.default;
  const cacheKey = syntheticCacheUrl('py', `${wantsBr ? 'br' : 'id'}/${key}`);
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) {
    const etag = cached.headers.get('ETag') ?? '';
    if (etag !== '' && (req.headers.get('If-None-Match') ?? '').includes(etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, Vary: 'Accept-Encoding' } });
    }
    if (cached.headers.get('X-Avlo-Enc') !== 'br') return cached;
    const h = new Headers(cached.headers);
    h.delete('X-Avlo-Enc');
    h.set('Content-Encoding', 'br');
    return new Response(cached.body, { headers: h, encodeBody: 'manual' });
  }

  let object: R2Object | R2ObjectBody | null = null;
  let br = false;
  if (wantsBr) {
    object = await bucket.get(`${key}.br`, { onlyIf: req.headers });
    br = object !== null;
  }
  if (!object) object = await bucket.get(key, { onlyIf: req.headers });
  if (!object) return new Response('Not Found', { status: 404 });
  if (!('body' in object) || !object.body) return new Response(null, { status: 304 });

  const headers = new Headers();
  headers.set('Content-Type', contentTypeFor(file));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('Vary', 'Accept-Encoding');

  const [cacheBody, body] = object.body.tee();
  const stored = new Headers(headers);
  if (br) stored.set('X-Avlo-Enc', 'br');
  ctx.waitUntil(cache.put(cacheKey, new Response(cacheBody, { headers: stored })));
  if (br) {
    headers.set('Content-Encoding', 'br');
    return new Response(body, { headers, encodeBody: 'manual' });
  }
  return new Response(body, { headers });
}

// Anonymous GET only — no auth, no rate limiter, no service bindings: the content is
// public build artifacts behind unguessable-enough immutable hashes, and every layer
// above (browser cache, SW, supervisor Cache API) exists to make repeats free anyway.
// `asset-body` CSP app-wide (`default-src 'none'; sandbox` + nosniff + CORP:
// cross-origin — the latter required under the SPA's COEP credentialless).
// No route-overlap hazard between the two GETs: 2 vs 3 segments, `file` regex bars `/`.
const app = new Hono<{ Bindings: Env }>()
  .use('*', createCors({ methods: ['GET'], allowHeaders: ['If-None-Match', 'If-Modified-Since'], exposeHeaders: ['ETag'] }))
  .use('*', devRequestLogger()) // dev-only request lines; dormant in prod
  .use('*', cspHeaders('asset-body'))
  .get('/:hash/bundles/:name', zValidator('param', pyBundleParam), (c) => {
    const { hash, name } = c.req.valid('param');
    return servePyObject(c.env.PY, c.req.raw, c.executionCtx, `${hash}/bundles/${name}`, name);
  })
  .get('/:hash/:file', zValidator('param', pyArtifactParam), (c) => {
    const { hash, file } = c.req.valid('param');
    return servePyObject(c.env.PY, c.req.raw, c.executionCtx, `${hash}/${file}`, file);
  });

app.onError(cspError('asset-body'));

// Deliberately NO app-type mock / hc client (workers/CLAUDE.md app-type exemption):
// consumers fetch binary artifacts by constructed URL (build-lock + PY_ORIGIN), never
// through a typed JSON client — a route-surface mock would guard nothing.
export default app;
export type PyApp = typeof app;
