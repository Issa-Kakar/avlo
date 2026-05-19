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
const MAIN_PORT = devPorts.main + portOffset;
const IMAGES_PORT = devPorts.images + portOffset;
const UNFURL_PORT = devPorts.unfurl + portOffset;

const proxyConfig = {
  '/parties': {
    target: `ws://localhost:${MAIN_PORT}`,
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
};

// credentialless (not require-corp) so cross-origin Google Fonts keep loading
// without needing CORP headers on each asset. Future external CDN assets that
// need credentials will look like 401s — switch to require-corp + per-asset
// CORP, or proxy them through /api, if that becomes an issue.
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
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
      '@avlo/api-client': path.resolve(__dirname, '../packages/api-client/src'),
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
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        sw: path.resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
