import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const clientPort = parseInt(process.env.VITE_PORT || '3000', 10);
const workerPort = parseInt(process.env.WORKER_PORT || '8787', 10);

const proxyConfig = {
  '/parties': {
    target: `ws://localhost:${workerPort}`,
    ws: true,
    changeOrigin: true,
  },
  '/parties/*': {
    target: `http://localhost:${workerPort}`,
    changeOrigin: true,
  },
  '/api': {
    target: `http://localhost:${workerPort}`,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
  server: {
    port: clientPort,
    proxy: proxyConfig,
  },
  preview: {
    port: clientPort,
    proxy: proxyConfig,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        sw: path.resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
