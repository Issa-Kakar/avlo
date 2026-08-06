import { TEST_COMPAT_DATE } from '@avlo/test-support/aux-build';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Pool-workers WITHOUT a wrangler file: this package has no worker of its own, but its
// primitives use ambient runtime APIs (crypto.subtle, HTMLRewriter-adjacent, fetch), so
// they are tested inside workerd with an inline compat config.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: TEST_COMPAT_DATE,
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    name: 'worker-shared',
    include: ['test/**/*.test.ts'],
  },
});
