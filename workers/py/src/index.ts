import { createCors, cspError, cspHeaders, devRequestLogger, pyArtifactParam, pyBundleParam } from '@avlo/worker-shared';
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
 * Immutable content-hashed artifact read with brotli negotiation. Accept-Encoding is
 * read RAW off the request (H3 — never Zod'd): `br` support tries the `.br` sibling
 * key, null-falling back to identity (manifest.json ships no .br). The br branch sets
 * `encodeBody: 'manual'` so the runtime passes the pre-compressed body through instead
 * of re-encoding. 304s ride R2's `onlyIf` header parsing (`'body' in object` splits).
 * No `caches.default`: bare-URL keys would poison br↔identity variants — browser HTTP
 * cache + the SW route + the supervisor's Cache API already make repeats free.
 */
async function servePyObject(bucket: R2Bucket, req: Request, key: string, file: string): Promise<Response> {
  let object: R2Object | R2ObjectBody | null = null;
  let br = false;
  if ((req.headers.get('Accept-Encoding') ?? '').includes('br')) {
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
  if (br) {
    headers.set('Content-Encoding', 'br');
    return new Response(object.body, { headers, encodeBody: 'manual' });
  }
  return new Response(object.body, { headers });
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
    return servePyObject(c.env.PY, c.req.raw, `${hash}/bundles/${name}`, name);
  })
  .get('/:hash/:file', zValidator('param', pyArtifactParam), (c) => {
    const { hash, file } = c.req.valid('param');
    return servePyObject(c.env.PY, c.req.raw, `${hash}/${file}`, file);
  });

app.onError(cspError('asset-body'));

// Deliberately NO app-type mock / hc client (workers/CLAUDE.md app-type exemption):
// consumers fetch binary artifacts by constructed URL (build-lock + PY_ORIGIN), never
// through a typed JSON client — a route-surface mock would guard nothing.
export default app;
export type PyApp = typeof app;
