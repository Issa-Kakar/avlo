import { auxWorker, STUB_AUTH } from '@avlo/test-support/aux-build';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Unfurl needs only an identity for its requireAuth gate — the transparent stub auth
// worker resolves `avlo-test-user=<id>[:anon]` cookies; the REAL cookie chain is covered
// by the auth suite (and end-to-end by sync's aux). All outbound page/image fetches ride
// MSW inside the isolate (test-support/msw.ts, globalThis.fetch patch), never the network.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { workers: [auxWorker('avlo-auth', STUB_AUTH)] },
    }),
  ],
  test: {
    name: 'worker-unfurl',
    include: ['test/**/*.test.ts'],
  },
});
