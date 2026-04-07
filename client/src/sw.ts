/// <reference lib="webworker" />
/**
 * Service Worker — owns the entire fetch/cache layer.
 *
 * Strategies:
 *   /api/assets/*        cache-first (immutable, content-addressed)
 *   /assets/*            cache-first (Vite-hashed, immutable)
 *   /fonts/*, /cursors/* cache-first
 *   navigation (HTML)    network-first with cache fallback
 *   everything else      passthrough (no respondWith)
 *
 * Mip URLs (?mip=half|quarter) are synthetic — written by the image worker,
 * never on the network. SW returns 404 on cache miss.
 */

const sw = self as unknown as ServiceWorkerGlobalScope;

const ASSET_CACHE = 'avlo-assets';
const SHELL_CACHE = 'avlo-shell-v1';

// ── Install + Activate ──────────────────────────────────────

sw.addEventListener('install', () => sw.skipWaiting());

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    sw.clients
      .claim()
      .then(() =>
        caches
          .keys()
          .then((names) => Promise.all(names.filter((n) => n.startsWith('avlo-shell-') && n !== SHELL_CACHE).map((n) => caches.delete(n)))),
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

  // Never intercept: party routes (WebSocket), non-GET (PUT uploads, etc.)
  if (url.pathname.startsWith('/parties/') || request.method !== 'GET') return;

  // Asset routes: cache-first from avlo-assets (immutable, content-addressed)
  if (url.pathname.startsWith('/api/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Other API routes: passthrough
  if (url.pathname.startsWith('/api/')) return;

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
