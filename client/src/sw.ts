/* eslint-disable no-undef */
/* eslint-disable no-console */
/// <reference lib="webworker" />
/// <reference types="vite/client" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;
declare const __APP_VERSION__: string;

const APP_VERSION = __APP_VERSION__ || 'dev';
const APP_SHELL_CACHE = `app-shell-v${APP_VERSION}`;
const OFFLINE_PACK_CACHE = `offline-pack-v${APP_VERSION}`;
const PYODIDE_CACHE_PREFIX = 'pyodide-pack-';

// Clean up outdated caches
cleanupOutdatedCaches();

// Precache all build assets
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', (event: ExtendableEvent) => {
  console.log('SW: Installing service worker, version:', APP_VERSION);
  
  event.waitUntil((async () => {
    // Pre-cache Monaco and practice problems
    const offlinePackCache = await caches.open(OFFLINE_PACK_CACHE);
    
    // Practice problems JSON
    await offlinePackCache.add('/problems.v1.json');
    
    // Monaco editor assets - these patterns should match Monaco files
    const monacoAssets: string[] = [
      // These will be populated by the build process
      // The actual paths will depend on your Monaco setup
    ];
    
    for (const asset of monacoAssets) {
      try {
        await offlinePackCache.add(asset);
      } catch (error) {
        console.warn('SW: Failed to cache Monaco asset:', asset, error);
      }
    }
    
    console.log('SW: Offline pack cached');
  })());
  
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log('SW: Activating service worker, version:', APP_VERSION);
  
  event.waitUntil((async () => {
    // Clean up old caches
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name => 
      (name.startsWith('app-shell-v') && name !== APP_SHELL_CACHE) ||
      (name.startsWith('offline-pack-v') && name !== OFFLINE_PACK_CACHE) ||
      name.startsWith(PYODIDE_CACHE_PREFIX)
    );
    
    await Promise.all(oldCaches.map(name => {
      console.log('SW: Deleting old cache:', name);
      return caches.delete(name);
    }));
    
    // Take control immediately
    await self.clients.claim();
    
    console.log('SW: Activated, old caches cleaned');
  })());
});

// Handle skipWaiting message
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('SW: Received SKIP_WAITING message');
    self.skipWaiting();
  }
});

// Navigation route - cache-first HTML for SPA
const navigationHandler = async ({ request }: { request: Request }) => {
  const appShellCache = await caches.open(APP_SHELL_CACHE);
  
  // Try cache first for HTML shell
  const cachedResponse = await appShellCache.match('/index.html');
  if (cachedResponse) {
    return cachedResponse;
  }
  
  // Fallback to network (for development)
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      // Cache the response for future use
      await appShellCache.put('/index.html', networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.error('SW: Navigation failed:', error);
    // Return a minimal offline page if we have one
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
};

registerRoute(
  new NavigationRoute(navigationHandler, {
    allowlist: [/^\/$/], // Only handle root and rooms
  })
);

// API and WebSocket bypass - never cache these
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/yjs/'),
  async ({ request }) => {
    // Always bypass cache for API calls
    return fetch(request);
  }
);

// Static assets (Monaco, JSON) - cache first
registerRoute(
  ({ url, request }) => {
    return request.destination === 'script' || 
           request.destination === 'style' ||
           url.pathname.endsWith('.json') ||
           url.pathname.includes('monaco') ||
           url.pathname.includes('problems.v1.json');
  },
  new CacheFirst({
    cacheName: OFFLINE_PACK_CACHE,
  })
);

// Pyodide warm cache (desktop only, handled by client)
registerRoute(
  ({ url }) => url.pathname.startsWith('/pyodide/'),
  new CacheFirst({
    cacheName: `${PYODIDE_CACHE_PREFIX}${APP_VERSION}`,
  })
);

console.log('SW: Service worker loaded, version:', APP_VERSION);