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
import { PY_BUILD_HASH } from '@avlo/py-loader';

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE = 'avlo-assets';
const SHELL_CACHE = 'avlo-shell-v1';
// Shared with the py supervisor's Cache API reads/writes (same URL keys). The
// only way pyodide's INTERNAL indexURL fetches (glue/wasm/stdlib) become
// offline-capable — the supervisor only fetches tars itself. Expect a benign
// transient double-put on supervisor fetches (SW-controlled → same key); SW
// puts are unverified, and the supervisor's hit-verify neutralizes them for
// tars. Note: `.br`-served bodies cache DECODED with a Content-Encoding: br
// header — Chrome serves that back fine; if an offline preview ever shows
// decode errors, sanitize headers on put for this branch only.
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

  // Python runtime artifacts: cache-first into the generation cache the
  // supervisor shares (immutable — keys carry the build-lock hash).
  if (isPyRequest(url, PY_ORIGIN)) {
    event.respondWith(cacheFirst(request, PY_CACHE));
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
