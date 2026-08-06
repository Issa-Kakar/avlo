import { auxWorker, STUB_AUTH } from '@avlo/test-support/aux-build';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Images needs only an identity for its PUT gate — the transparent stub auth worker
// (avlo-test-user cookie) stands in; the real chain is the auth suite's job. The avatar
// ingest RPC's outbound fetch rides MSW inside the isolate (test-support/msw.ts).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { workers: [auxWorker('avlo-auth', STUB_AUTH)] },
    }),
  ],
  test: {
    name: 'worker-images',
    include: ['test/**/*.test.ts'],
  },
});
