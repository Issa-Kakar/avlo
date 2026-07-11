import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Pool-workers harness exemplar: tests run INSIDE workerd (Miniflare), with
// bindings/compat sourced from the real wrangler.jsonc (single source of truth).
// Extending to workers with DO/queue/service bindings uses the same shape —
// see TESTING.md for the auxiliary-workers recipe.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    name: 'worker-py',
    include: ['test/**/*.test.ts'],
  },
});
