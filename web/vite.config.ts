import { readFileSync } from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const devPorts = JSON.parse(readFileSync(resolve(__dirname_local, '../scripts/dev-ports.json'), 'utf8'));

const portOffset = parseInt(process.env.PORT_OFFSET || '0', 10);
const clientPort = parseInt(process.env.VITE_PORT || '3000', 10);
const SYNC_PORT = devPorts.sync + portOffset;
const IMAGES_PORT = devPorts.images + portOffset;
const UNFURL_PORT = devPorts.unfurl + portOffset;
const AUTH_PORT = devPorts.auth + portOffset;
const USERS_PORT = devPorts.users + portOffset;

const proxyConfig = {
  // match SYNC_WS_PREFIX (@avlo/shared). No `rewrite` — the full /sync/rooms/<id> path must
  // reach the sync worker (unlike the /api/* proxies, which strip their prefix).
  '/sync': {
    target: `ws://localhost:${SYNC_PORT}`,
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

// Dev-only: serve Python runtime artifacts (web/public/py-dev/, gitignored) RAW.
// The executor worker ESM-imports pyodide's loader/glue at runtime; Vite's module
// pipeline refuses source imports of public-dir files and transforming multi-MB
// emscripten glue would be pointless anyway. configureServer middlewares run
// before Vite's internals, so both fetch() and import() requests short-circuit
// here. Prod serves these from the py worker (M3 replaces this with a proxy).
const PY_DEV_MIME: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.tar': 'application/x-tar',
  '.snap': 'application/octet-stream',
  '.whl': 'application/octet-stream',
};
const pyDevStatic = (): Plugin => ({
  name: 'avlo:py-dev-static',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (!url.startsWith('/py-dev/')) return next();
      const file = path.join(server.config.root, 'public', decodeURIComponent(url));
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('Content-Type', PY_DEV_MIME[path.extname(file)] ?? 'application/octet-stream');
      for (const [k, v] of Object.entries(isolationHeaders)) res.setHeader(k, v);
      return res.end(bytes);
    });
  },
});

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
    pyDevStatic(),
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
    // JS + CSS lower to Vite 8's default target ('baseline-widely-available'), which also
    // drives Lightning CSS minification (the v8 default CSS minifier). The support floor is
    // documented in `.browserslistrc` (Baseline "widely available") for Tailwind v4's engine
    // and other browserslist-aware tooling. We deliberately do NOT flip `css.transformer` to
    // 'lightningcss': that combo (Rolldown + @tailwindcss/vite) has known `@theme`-dropping bugs.
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname_local, 'index.html'),
        sw: path.resolve(__dirname_local, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        // Split the EAGER big vendors out of `main` for cross-deploy cache stability —
        // otherwise any app-code edit re-hashes all ~359 KB gzip. Lazy editor libs
        // (@tiptap/@codemirror/@lezer/prosemirror/y-prosemirror/y-codemirror) are left
        // UNGROUPED, so Rolldown keeps them in their async chunks; app code is ungrouped too
        // → Rolldown's default placement (small vendors + lazy libs land right). Rolldown's
        // `codeSplitting.groups` replaces Rollup's `manualChunks` (dropped in Vite 8); each
        // group's `test` matches the module id (`[\\/]` per Rolldown's Windows-path guidance).
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react-dom|react|scheduler)[\\/]/ },
            { name: 'vendor-yjs', test: /[\\/]node_modules[\\/](yjs|lib0|y-protocols|y-indexeddb|y-partyserver)[\\/]/ },
            { name: 'vendor-tanstack', test: /[\\/]node_modules[\\/]@tanstack[\\/]/ },
          ],
        },
      },
    },
  },
});
