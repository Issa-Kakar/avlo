/// <reference lib="webworker" />
/**
 * Service Worker — owns the entire fetch/cache layer.
 *
 * Strategies:
 *   images host (prod) / /api/images/* (dev)  cache-first (immutable, content-addressed)
 *   py host (prod) / /api/py/* (dev)           cache-first (immutable, buildHash-keyed)
 *   /assets/*                                  cache-first (Vite-hashed, immutable)
 *   /fonts/*, /cursors/*, /aqua-ink/*          cache-first (icons + webmanifest)
 *   navigation (HTML)                          network-first with cache fallback
 *   everything else                            passthrough (no respondWith)
 *
 * Mip URLs (?mip=half|quarter) are synthetic — written by the image worker,
 * never on the network. SW returns 404 on cache miss.
 */

// BUILD_LOCK is pure JSON + types (no worker ambients) — SW-bundle-safe.
import { IMAGES_ORIGIN, PY_ORIGIN, SYNC_HOST } from '@avlo/api-client/origins';
import { isImagesRequest, isPyRequest, isSyncRequest } from '@avlo/api-client/sw-matchers';
import { BUILD_LOCK, matchesLockEntry, PY_BUILD_HASH } from '@avlo/py-loader';

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE = 'avlo-assets';
const SHELL_CACHE = 'avlo-shell-v1';
// Shared with the py supervisor's Cache API reads/writes (same URL keys). The
// only way pyodide's INTERNAL indexURL fetches (glue/wasm/stdlib) become
// offline-capable — the supervisor only fetches tars itself.
// Verify-at-FILL model (P2): every py entry this SW writes is lock-verified
// FIRST and stored with `x-avlo-verified: 1`. Marked hits serve as-is —
// CORE artifacts (glue/wasm/stdlib) keep their pristine HTTP-cache identity
// (Cache-Control/ETag; Content-Encoding dropped with the decoded body), which
// V8's disk wasm code cache needs for `pyodide.asm.wasm` (the old synthetic
// hit Response defeated it on every page load). Unmarked legacy core entries
// are deleted + refilled; unmarked tar hits serve as-is (the supervisor wrote
// them verified, and it re-verifies unmarked reads — the marker is ITS
// fast-path signal to skip re-hashing ~40 MB per boot). Tar MISSES stream to
// the page unbuffered (download progress intact); the verify+put happens on a
// clone in waitUntil. A network body that fails the lock: core → 502
// fail-closed; tar → streamed through unmarked (the supervisor's own sha
// check is the gate) — NEVER cached either way. Snapshots are OPFS-only in
// P2 — no `.snap` ever crosses HTTP.
const PY_CACHE = `avlo-py-${PY_BUILD_HASH}`;
const VERIFIED_HEADER = 'x-avlo-verified';

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

/** `<py origin>/<PY_BUILD_HASH>/<rel>` → rel; null for other origins/hashes. */
function pyRelPath(url: URL): string | null {
  const base = new URL(PY_ORIGIN).pathname; // '/' (prod) or '/api/py' (dev proxy)
  const rel = base === '/' ? url.pathname.slice(1) : url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : null;
  if (!rel) return null;
  const slash = rel.indexOf('/');
  return slash > 0 && rel.slice(0, slash) === PY_BUILD_HASH ? rel.slice(slash + 1) : null;
}

/** Lock `artifacts` entry for a core artifact URL (glue/wasm/stdlib). No
 * `.snap` case exists today: P2 snapshots are OPFS-only, client-captured. */
function pyCoreEntry(url: URL): { name: string; sha256: string; size: number } | null {
  const name = pyRelPath(url);
  const entry = name ? BUILD_LOCK.artifacts[name] : undefined;
  return entry && name ? { name, ...entry } : null;
}

/** Lock `bundles` entry for a `bundles/<name>.tar` URL. */
function pyTarEntry(url: URL): { name: string; sha256: string; size: number } | null {
  const rel = pyRelPath(url);
  if (!rel?.startsWith('bundles/') || !rel.endsWith('.tar')) return null;
  const name = rel.slice('bundles/'.length, -'.tar'.length);
  const entry = BUILD_LOCK.bundles[name];
  return entry ? { name: `${name}.tar`, ...entry } : null;
}

/** The identity-relevant headers a stored verified response keeps. The body
 * is stored DECODED, so Content-Encoding/Content-Length must not ride along
 * (br↔identity inconsistency); Cache-Control/ETag/dates stay — that identity
 * is what V8's disk wasm code cache keys on for `pyodide.asm.wasm`. */
function verifiedHeaders(resp: Response): Headers {
  const h = new Headers();
  for (const name of ['Content-Type', 'Cache-Control', 'ETag', 'Date', 'Last-Modified']) {
    const v = resp.headers.get(name);
    if (v !== null) h.set(name, v);
  }
  h.set(VERIFIED_HEADER, '1');
  return h;
}

/** Core artifacts (glue/wasm/stdlib): verify-at-FILL against the committed
 * lock. Marked hits serve as-is (verified before they were ever written;
 * pristine identity keeps the wasm code cache alive). Unmarked legacy hits
 * (older SW format) delete + refill. A network body that fails the lock is a
 * 502 and NEVER cached — the bytes pyodide executes are exactly the bytes
 * the lock pins. */
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
      if (hit.headers.get(VERIFIED_HEADER) === '1') return hit;
      await cache.delete(request); // legacy unmarked entry — refill mints the marked form
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
  const out = new Response(bytes, { status: 200, headers: verifiedHeaders(resp) });
  // waitUntil: respondWith settles with `out` immediately — the multi-MB put
  // must survive SW termination or offline boot silently loses the artifact.
  if (cache) event.waitUntil(cache.put(request, out.clone()));
  return out;
}

/** Bundle tars: hits serve as-is (marked = SW-verified at fill; unmarked =
 * the supervisor wrote it, verified — it re-verifies unmarked reads). Misses
 * stream the network body to the page IMMEDIATELY (download progress runs on
 * this stream); the lock verify + marked put happen on a clone in waitUntil,
 * and a failing body is simply never cached — the supervisor's own sha check
 * remains the mount gate. */
async function verifiedTarFirst(
  event: FetchEvent,
  request: Request,
  entry: { name: string; sha256: string; size: number },
): Promise<Response> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(PY_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
    cache = null;
  }
  const resp = await fetch(request);
  if (!resp.ok || !cache) return resp;
  const clone = resp.clone();
  const store = cache;
  event.waitUntil(
    (async () => {
      try {
        const bytes = await clone.arrayBuffer();
        if (!(await matchesLockEntry(bytes, entry))) return; // corrupt body — never cached
        await store.put(
          request,
          new Response(bytes, {
            status: 200,
            headers: { 'Content-Type': clone.headers.get('Content-Type') ?? 'application/x-tar', [VERIFIED_HEADER]: '1' },
          }),
        );
      } catch {
        /* buffer/put failure — no write; the supervisor path still verifies */
      }
    })(),
  );
  return resp;
}

// ── Fetch Handler ───────────────────────────────────────────

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept: sync routes (WebSocket), non-GET (PUT uploads, etc.)
  if (isSyncRequest(url, SYNC_HOST) || request.method !== 'GET') return;

  // Image assets: cache-first from avlo-assets (immutable, content-addressed)
  if (isImagesRequest(url, IMAGES_ORIGIN)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Python runtime artifacts: verify-at-fill for core artifacts AND bundle
  // tars (see the PY_CACHE comment); anything else under the py origin
  // (manifest.json, stray keys) stays plain cache-first.
  if (isPyRequest(url, PY_ORIGIN)) {
    const core = pyCoreEntry(url);
    if (core) {
      event.respondWith(verifiedPyFirst(event, request, core));
      return;
    }
    const tar = pyTarEntry(url);
    event.respondWith(tar ? verifiedTarFirst(event, request, tar) : cacheFirst(request, PY_CACHE));
    return;
  }

  // Hashed static assets: cache-first (Vite hash = immutable)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Fonts, cursors, favicon + PWA manifest/icons: cache-first
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/cursors/') || url.pathname.startsWith('/aqua-ink/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Navigation (HTML): network-first with cache fallback. Dev + preview share
  // localhost:3000, so a preview-installed SW also controls later `pnpm dev`
  // pages — never cache Vite dev HTML (its /@vite/client module URLs are dead
  // offline; one cached dev page bricks every offline boot until site data is
  // cleared).
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(request);
          if (resp.ok && !(await resp.clone().text()).includes('/@vite/client')) {
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
