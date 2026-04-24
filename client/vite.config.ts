import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const clientPort = parseInt(process.env.VITE_PORT || '3000', 10);
const workerPort = parseInt(process.env.WORKER_PORT || '8787', 10);

const proxyConfig = {
  '/parties': {
    target: `ws://localhost:${workerPort}`,
    ws: true,
    changeOrigin: true,
  },
  '/api': {
    target: `http://localhost:${workerPort}`,
    changeOrigin: true,
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
    }) as any,
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
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
