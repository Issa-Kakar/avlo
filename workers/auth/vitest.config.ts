import { auxWorker, STUB_USERS_IMAGES, TEST_AUTH_BINDINGS } from '@avlo/test-support/aux-build';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Auth runs against RECORDING STUBS for its two RPC dependencies (users/images) — the
// real workers are exercised in their own suites; here we only need call capture +
// controllable results (see test-support/stub-users-images.mjs). Both aux names map to
// the ONE stub script (separate isolates, disjoint state slices). Secrets are test-only
// values injected as bindings — never read from .dev.vars.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Pins secrets AND public vars — the pool folds workers/auth/.dev.vars over the
        // wrangler `vars`, and tests must not depend on a developer's local overrides.
        bindings: { ...TEST_AUTH_BINDINGS },
        workers: [auxWorker('avlo-users', STUB_USERS_IMAGES), auxWorker('avlo-images', STUB_USERS_IMAGES)],
      },
    }),
  ],
  test: {
    name: 'worker-auth',
    include: ['test/**/*.test.ts'],
    // Files run in PARALLEL against one shared Miniflare. That holds because nothing
    // calls the global reset() (it wipes EVERY binding, incl. KV another file seeded
    // mid-test): rate-limit buckets are never refilled — instead each file allocates
    // per-call unique IPs from its own /24 block, and every KV assertion is scoped to
    // the test's own keys, never a global list.
  },
});
