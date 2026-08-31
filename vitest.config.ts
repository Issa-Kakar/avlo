import { defineConfig } from 'vitest/config';

// Root aggregator only — the source of truth for each suite is its own
// package's vitest.config.ts (driven by `turbo run test` for caching). This
// config exists so `pnpm test:watch` / `vitest --ui` run every suite as one
// process. The config-file globs mean a new test package auto-joins the moment
// it drops a vitest.config.ts — nothing to register here. One deliberate
// absentee: web/tests/py-integration (the `test:py` task) boots the real fork
// over staged artifacts — minutes-long and artifact-gated, so it never joins
// the watch process.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'workers/*/vitest.config.ts', 'web/vitest.config.ts'],
  },
});
