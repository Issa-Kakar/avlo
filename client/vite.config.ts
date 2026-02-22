import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src')
    }
  },
  server: {
    port: 3000,
    proxy: {
      // Proxy WebSocket connections to wrangler dev server
      '/parties': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true
      },
      // Also proxy regular HTTP requests to /parties
      '/parties/*': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
});
