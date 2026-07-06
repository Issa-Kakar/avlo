/// <reference lib="webworker" />
/**
 * Service Worker — owns the entire fetch/cache layer.
 *
 * Strategies:
 *   images host (prod) / /api/images/* (dev)  cache-first (immutable, content-addressed)
 *   py host (prod) / /api/py/* (dev)           cache-first (immutable, buildHash-keyed)
 *   /assets/*                                  cache-first (Vite-hashed, immutable)
 *   /fonts/*, /cursors/*                       cache-first
 *   navigation (HTML)                          network-first with cache fallback
 *   everything else                            passthrough (no respondWith)
 *
 * Mip URLs (?mip=half|quarter) are synthetic — written by the image worker,
 * never on the network. SW returns 404 on cache miss.
 */

// BUILD_LOCK is pure JSON + types (no worker ambients) — SW-bundle-safe.
import { IMAGES_ORIGIN, PY_ORIGIN, SYNC_HOST_PROD } from '@avlo/api-client/origins';
import { isImagesRequest, isPyRequest, isSyncRequest } from '@avlo/api-client/sw-matchers';
import { BUILD_LOCK, matchesLockEntry, PY_BUILD_HASH } from '@avlo/py-loader';

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE = 'avlo-assets';
const SHELL_CACHE = 'avlo-shell-v1';
// Shared with the py supervisor's Cache API reads/writes (same URL keys). The
// only way pyodide's INTERNAL indexURL fetches (glue/wasm/stdlib) become
// offline-capable — the supervisor only fetches tars itself. Expect a benign
// transient double-put on supervisor fetches (SW-controlled → same key).
// CORE artifacts (the lock's `artifacts` table: glue/wasm/stdlib) go through
// `verifiedPyFirst` — byte-verified against the committed lock on every hit
// AND before every cache write, so the bytes pyodide executes are exactly the
// bytes the lock pins. Tars stay streaming `cacheFirst`: the SUPERVISOR is
// their verifier (fetch-path sha + hit re-verify) and buffering them here
// would collapse its download-progress stream.
const PY_CACHE = `avlo-py-${PY_BUILD_HASH}`;

// ── Install + Activate ──────────────────────────────────────

sw.addEventListener('install', () => sw.skipWaiting());

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    sw.clients.claim().then(() =>
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter(
              (n) =>
                (n.startsWith('avlo-shell-') && n !== SHELL_CACHE) ||
                // Stale py runtime generations — a new build-lock hash keys a new cache.
                (n.startsWith('avlo-py-') && n !== PY_CACHE),
            )
            .map((n) => caches.delete(n)),
        ),
      ),
    ),
  );
});

// ── Helpers ─────────────────────────────────────────────────

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const resp = await fetch(request);
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch {
    return fetch(request);
  }
}

/** Lock `artifacts` entry iff the URL is `<py origin>/<PY_BUILD_HASH>/<core artifact>`.
 * Bundle tars, manifest.json, and other-generation hashes return null (→ cacheFirst). */
function pyCoreEntry(url: URL): { name: string; sha256: string; size: number } | null {
  const base = new URL(PY_ORIGIN).pathname; // '/' (prod) or '/api/py' (dev proxy)
  const rel = base === '/' ? url.pathname.slice(1) : url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : null;
  if (!rel) return null;
  const slash = rel.indexOf('/');
  if (slash < 0 || rel.slice(0, slash) !== PY_BUILD_HASH) return null;
  const name = rel.slice(slash + 1);
  const entry = BUILD_LOCK.artifacts[name];
  return entry ? { name, ...entry } : null;
}

/** Verify-first serving for the core artifacts (glue/wasm/stdlib): the bytes
 * handed to pyodide's `import()`/internal fetches are exactly the committed
 * lock's bytes. Cache hits are RE-verified (poisoned hit → delete → refetch,
 * the supervisor's tar discipline); a network body that fails the lock is a
 * 502 and NEVER cached. The synthetic Response carries Content-Type ONLY —
 * `arrayBuffer()` yields DECODED bytes, so the network response's
 * Content-Encoding/Content-Length (a `.br` body) must not ride along. */
async function verifiedPyFirst(
  event: FetchEvent,
  request: Request,
  entry: { name: string; sha256: string; size: number },
): Promise<Response> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(PY_CACHE);
    const hit = await cache.match(request);
    if (hit) {
      if (await matchesLockEntry(await hit.clone().arrayBuffer(), entry)) return hit;
      await cache.delete(request);
    }
  } catch {
    cache = null; // Cache API unavailable — verification still mandatory below
  }
  const resp = await fetch(request);
  // Non-ok propagates unverified + uncached — fail-visible: no consumer
  // executes a non-ok body (module import, instantiateStreaming, and the
  // supervisor glue preflight all reject it).
  if (!resp.ok) return resp;
  const bytes = await resp.arrayBuffer();
  if (!(await matchesLockEntry(bytes, entry))) {
    return new Response(`${entry.name} failed build-lock verification`, { status: 502 });
  }
  const out = new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/octet-stream' },
  });
  // waitUntil: respondWith settles with `out` immediately — the multi-MB put
  // must survive SW termination or offline boot silently loses the artifact.
  if (cache) event.waitUntil(cache.put(request, out.clone()));
  return out;
}

// ── Fetch Handler ───────────────────────────────────────────

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept: sync routes (WebSocket), non-GET (PUT uploads, etc.)
  if (isSyncRequest(url, SYNC_HOST_PROD) || request.method !== 'GET') return;

  // Image assets: cache-first from avlo-assets (immutable, content-addressed)
  if (isImagesRequest(url, IMAGES_ORIGIN)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Python runtime artifacts: core artifacts are lock-verified before they
  // are served or cached; tars stream cache-first (the supervisor verifies
  // them — see the PY_CACHE comment).
  if (isPyRequest(url, PY_ORIGIN)) {
    const core = pyCoreEntry(url);
    event.respondWith(core ? verifiedPyFirst(event, request, core) : cacheFirst(request, PY_CACHE));
    return;
  }

  // Hashed static assets: cache-first (Vite hash = immutable)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Fonts, cursors: cache-first
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/cursors/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Navigation (HTML): network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(request);
          if (resp.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(request, resp.clone());
          }
          return resp;
        } catch {
          return (await caches.match(request)) ?? (await caches.match('/')) ?? new Response('Offline', { status: 503 });
        }
      })(),
    );
    return;
  }

  // Everything else: passthrough (no respondWith → browser handles directly)
});
