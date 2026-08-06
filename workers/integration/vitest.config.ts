import { defineConfig } from 'vitest/config';

// Node-environment suite — no pool-workers. Each test file boots its own
// createTestHarness (one merged Miniflare running sync/auth/users/images from their
// REAL wrangler.jsonc files), so real queue delivery, real WS upgrades, and the real
// cross-script DO seam are all in play. Queue batch windows (1 s visits/meta, 5 s
// migrate) dominate the timings — hence the generous budgets.
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
