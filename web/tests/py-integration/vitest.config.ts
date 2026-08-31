import { defineConfig } from 'vitest/config';

// The py-integration project — the JS-contract gate over REAL staged
// artifacts (web/public/py-dev/fork, written by `avlo-build stage`). Every
// file boots the fork under Node through the SHIPPED web/src/core/py modules,
// so this project is artifact-gated and minutes-long: it is deliberately NOT
// in the root vitest `projects` array (test:watch stays fast) — it runs via
// `pnpm --filter @avlo/web test:py`, wired into `pnpm py:board` through the
// turbo `test:py` task (dependsOn @avlo/py-build#py:stage).
export default defineConfig({
  test: {
    name: 'py-integration',
    environment: 'node',
    include: ['tests/py-integration/*.test.ts'],
    // Fork per file, like the old harness's child-per-section: three files
    // scrub + FREEZE the realm (py-harden), and every file holds a full
    // interpreter image. maxWorkers bounds concurrent boots on the 9 GB box.
    pool: 'forks',
    maxWorkers: 3,
    testTimeout: 120_000,
    // beforeAll carries the boots (snapshot runs two + a capture/restore).
    hookTimeout: 300_000,
    // The staged glue is a runtime artifact — import it natively, never
    // through the vite transform pipeline (it also has no sourcemap).
    server: { deps: { external: [/\/public\/py-dev\//] } },
  },
});
