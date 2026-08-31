import { readFileSync } from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const devPorts = JSON.parse(readFileSync(resolve(__dirname_local, '../scripts/dev-ports.json'), 'utf8'));

const portOffset = parseInt(process.env.PORT_OFFSET || '0', 10);
const clientPort = parseInt(process.env.VITE_PORT || '3000', 10);
const SYNC_PORT = devPorts.sync + portOffset;
const IMAGES_PORT = devPorts.images + portOffset;
const UNFURL_PORT = devPorts.unfurl + portOffset;
const AUTH_PORT = devPorts.auth + portOffset;
const USERS_PORT = devPorts.users + portOffset;
const AI_PORT = devPorts.ai + portOffset;

const proxyConfig = {
  // match SYNC_WS_PREFIX (@avlo/shared). No `rewrite` — the full /sync/rooms/<id> path must
  // reach the sync worker (unlike the /api/* proxies, which strip their prefix).
  '/sync': {
    target: `ws://localhost:${SYNC_PORT}`,
    ws: true,
    changeOrigin: true,
  },
  // Agents SDK routing prefix (AI_AGENTS_PREFIX, @avlo/shared). No `rewrite` —
  // routeAgentRequest + the browser's useAgent both speak /agents/... natively.
  '/agents': {
    target: `ws://localhost:${AI_PORT}`,
    ws: true,
    changeOrigin: true,
  },
  '/api/images': {
    target: `http://localhost:${IMAGES_PORT}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/images/, ''),
  },
  '/api/unfurl': {
    target: `http://localhost:${UNFURL_PORT}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/unfurl/, ''),
  },
  // Same-origin proxy → cookies auto-attach on dev (no cross-origin credentials
  // dance). Prod is a true subdomain (auth/users.avlo.io) reached cross-origin.
  '/api/auth': {
    target: `http://localhost:${AUTH_PORT}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/auth/, ''),
  },
  '/api/users': {
    target: `http://localhost:${USERS_PORT}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/users/, ''),
  },
};

// COEP credentialless (not require-corp). Both give crossOriginIsolated === true (⇒
// SAB), and the images asset-body CSP already sets CORP: cross-origin, so require-corp
// would load every asset too. Tie-breaker: credentialless strips credentials from
// no-cors cross-origin embeds — the app has exactly one, the account-avatar <img> from
// images.avlo.io (UserProfileMenu). That origin is same-site, so SameSite=Lax would NOT
// stop the <img> shipping avlo_anon + the HttpOnly avlo_session; credentialless keeps the
// bearer token off the image subdomain (which never reads it), for free. CORS calls (/me,
// /rooms, uploads) stay credentialed in BOTH modes — COEP doesn't touch them. Switch to
// require-corp only for a CREDENTIALED cross-origin embed (a private per-user CDN); public
// content-addressed assets never need it.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      // biome-ignore lint/suspicious/noExplicitAny: upstream-type — tanstackRouter plugin return type is narrower than Vite's Plugin[]; cast lets the plugin array type-check
    }) as any,
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname_local, './src'),
      '@avlo/shared': path.resolve(__dirname_local, '../packages/shared/src'),
      '@avlo/api-client': path.resolve(__dirname_local, '../packages/api-client/src'),
    },
  },
  server: {
    // host: true binds dual-stack (0.0.0.0 + ::) so WSL2-mirrored browsers
    // don't hit the ::1 → 127.0.0.1 retry dance on localhost.
    host: true,
    port: clientPort,
    proxy: proxyConfig,
    headers: isolationHeaders,
  },
  preview: {
    host: true,
    port: clientPort,
    proxy: proxyConfig,
    headers: isolationHeaders,
  },
  // ES-module worker output. The lezer worker uses dynamic `import()` to
  // lazy-load per-language grammars, which requires code-splitting — unsupported
  // by the default 'iife' worker format. Both workers are instantiated with
  // `{ type: 'module' }` at runtime, so ES output matches.
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname_local, 'index.html'),
        sw: path.resolve(__dirname_local, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        // Split the EAGER big vendors out of `main` for cross-deploy cache stability —
        // otherwise any app-code edit re-hashes all ~359 KB gzip. Lazy editor libs
        // (@tiptap/@codemirror/@lezer/prosemirror/y-prosemirror/y-codemirror) MUST stay
        // auto so Rollup keeps them in their async chunks — the early return is
        // belt-and-suspenders against a future regex collision. Everything else falls
        // through to `undefined` → Rollup auto (small vendors + lazy libs placed right).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/](@tiptap|@codemirror|@lezer|prosemirror-|y-prosemirror|y-codemirror)[\\/]/.test(id)) return;
          if (/[\\/](react-dom|react|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/](yjs|lib0|y-protocols|y-indexeddb|y-partyserver)[\\/]/.test(id)) return 'vendor-yjs';
          if (/[\\/]@tanstack[\\/]/.test(id)) return 'vendor-tanstack';
        },
      },
    },
  },
});
