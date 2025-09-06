import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // Node environment for server tests
    setupFiles: [path.resolve(__dirname, './vitest.setup.ts')],
    include: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],

    // Server tests configuration
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false, // Server tests can run in parallel
        isolate: true, // Isolate test environment between test files
      },
    },

    // Reasonable timeouts for server tests
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 1000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        'node_modules/',
        'dist/',
        '*.config.*',
        '**/index.ts',
        '**/*.d.ts',
        '**/types/**',
        'src/prisma/migrations/**',
      ],
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
      '@avlo/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
  // ES module support
  esbuild: {
    target: 'node20',
  },
});
