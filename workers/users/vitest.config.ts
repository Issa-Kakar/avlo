import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auxWorker, buildAuxWorker, STUB_AUTH } from '@avlo/test-support/aux-build';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Users runs the REAL sync worker as an auxiliary so its cross-script `rooms` DO binding
// reaches the REAL AvloDO (the cross-worker permission seam is the point of this suite);
// identity comes from the transparent stub auth worker. D1 migrations are read Node-side
// here and applied per-file by test/apply-migrations.ts (setup file).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const syncScript = buildAuxWorker('sync');
const migrations = await readD1Migrations(path.join(HERE, 'drizzle'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        // The pool auto-delivers queue batches to the wrangler-config consumers, which
        // (a) makes projections land asynchronously mid-test and (b) leaves pending
        // batch windows that intermittently DEADLOCK pool teardown. Every suite drives
        // consumption deterministically via createMessageBatch + worker.queue, so strip
        // the consumers entirely.
        queueConsumers: [],
        // The wrangler translator derives a cross-script DO's storage backend from the
        // BINDING worker's migrations, which users lacks — force SQLite so AvloDO's
        // `ctx.storage` drizzle works (mirrors scripts/dev-miniflare.mjs's fix-up).
        durableObjects: {
          rooms: { className: 'AvloDO', scriptName: 'avlo-sync', useSQLite: true },
        },
        workers: [
          auxWorker('avlo-auth', STUB_AUTH),
          auxWorker('avlo-sync', syncScript, {
            compatibilityFlags: ['nodejs_compat'],
            durableObjects: { rooms: { className: 'AvloDO', useSQLite: true } },
            r2Buckets: ['DOCS'],
            queueProducers: { ROOM_VISITS: 'avlo-room-visits', ROOM_META: 'avlo-room-meta' },
            serviceBindings: { AUTH: { name: 'avlo-auth', entrypoint: 'AuthRpc' } },
          }),
        ],
      },
    }),
  ],
  test: {
    name: 'worker-users',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
