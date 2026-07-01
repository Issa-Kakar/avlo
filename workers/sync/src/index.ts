import { SYNC_WS_PREFIX } from '@avlo/shared';
import { devRequestLogger } from '@avlo/worker-shared';
import { Hono } from 'hono';
import { partyserverMiddleware } from 'hono-party';
import type { SyncEnv } from './env';
import { makeOnBeforeConnect } from './on-before-connect';

export { AvloDO } from './room';

const app = new Hono<SyncEnv>();

// Dev-only WS-upgrade log — dormant in prod (DEV_LOGS unset).
app.use('*', devRequestLogger());

// /<SYNC_WS_PREFIX>/* is the only path this worker serves (pure worker, no Assets binding);
// other paths 404. onBeforeConnect Origin-guards + authenticates the upgrade and stamps
// x-avlo-user-id for the DO (§7). `options.prefix` routes `<prefix>/rooms/<id>` — the `rooms`
// segment is the kebab-cased DO binding name (class is AvloDO; binding stays rooms).
app.use(
  `/${SYNC_WS_PREFIX}/*`,
  partyserverMiddleware<SyncEnv>({ options: { prefix: SYNC_WS_PREFIX, onBeforeConnect: makeOnBeforeConnect() } }),
);

export default app;
export type SyncApp = typeof app;
