import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations, Node side) — it is
// not part of the worker's real Env, hence the cast.
beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
});
