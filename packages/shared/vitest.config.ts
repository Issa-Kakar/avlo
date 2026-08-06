import { defineConfig } from 'vitest/config';

// Node-environment unit tests for the cross-runtime pure logic (validators, URL and
// title normalization, id regexes) — colocated `*.test.ts`, explicit imports, per the
// py-loader exemplar.
export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
