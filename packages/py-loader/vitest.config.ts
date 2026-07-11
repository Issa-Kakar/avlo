import { defineConfig } from 'vitest/config';

// Node-environment unit tests for dependency-free pure logic. This is the
// exemplar for the "vitest node" harness: colocated `*.test.ts`, explicit
// imports (no globals), no path aliases (relative imports only).
export default defineConfig({
  test: {
    name: 'py-loader',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
