import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/src/**/*.test.{ts,tsx}'],
    exclude: ['**/phase2-*.ts', '**/test-*.ts'],
    
    // Memory-safe configuration
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,  // Run tests sequentially to prevent memory issues
        isolate: true,       // Isolate test environment between test files
      },
    },
    
    // Disable watch mode by default
    watch: false,
    
    // Set reasonable timeouts
    testTimeout: 10000,
    hookTimeout: 10000,
    
    // Clean up after each test file
    teardownTimeout: 1000,
    
    // Memory monitoring
    onConsoleLog(_log) {
      if (process.memoryUsage) {
        const usage = process.memoryUsage();
        const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
        if (heapUsedMB > 500) {
          console.warn(`⚠️ High memory usage detected: ${heapUsedMB}MB`);
        }
      }
    },
    
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: ['node_modules/', 'dist/', '*.config.*', '**/index.ts', '**/*.d.ts', '**/types/**'],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@avlo/shared': path.resolve(__dirname, './packages/shared/src'),
    },
  },
});