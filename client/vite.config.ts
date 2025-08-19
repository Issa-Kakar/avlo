import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== 'production',
    // Chunk splitting for lazy-loaded modules
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          yjs: ['yjs', 'y-websocket', 'y-indexeddb', 'y-webrtc'],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
