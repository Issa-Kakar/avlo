import { auxWorker, buildAuxWorker, TEST_AUTH_BINDINGS } from '@avlo/test-support/aux-build';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const authScript = buildAuxWorker('auth');

// Sync runs the REAL auth worker as an auxiliary (full-fidelity identity chain at the
// WS-upgrade seam — cookie → AuthRpc.verifySession → x-avlo-user-id → DO). The aux
// worker gets its own KV + test secrets here; sync's own bindings (DO, R2, queues,
// the AUTH service binding) come from wrangler.jsonc. Secrets are test-only values —
// never read from .dev.vars.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        workers: [
          auxWorker('avlo-auth', authScript, {
            compatibilityFlags: ['nodejs_compat'],
            kvNamespaces: ['SESSIONS'],
            bindings: { ...TEST_AUTH_BINDINGS },
          }),
        ],
      },
    }),
  ],
  test: {
    name: 'worker-sync',
    include: ['test/**/*.test.ts'],
    // WS + DO tests share live storage (per-test isolation left the pool in 0.13);
    // suites use unique room ids per test instead of cleanup ordering. File parallelism
    // stays at the default: no Miniflare-global API (abortAllDurableObjects / reset)
    // remains in the suite — every DO touch is targeted by room id (evictDurableObject
    // on that room's stub), so parallel files never disturb each other's instances.
  },
});
