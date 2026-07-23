import { defineConfig } from 'vitest/config';

// Node-environment unit tests for dependency-light pure logic in web/src
// (exemplar: packages/py-loader/vitest.config.ts). Colocated `*.test.ts`,
// explicit imports, relative imports only — browser-API-dependent halves of a
// module (OPFS, workers) are e2e territory (e2e/*.spec.ts), not vitest.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
