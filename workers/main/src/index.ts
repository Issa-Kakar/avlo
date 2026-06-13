import { devRequestLogger } from '@avlo/worker-shared';
import { Hono } from 'hono';
import { partyserverMiddleware } from 'hono-party';
import { makeOnBeforeConnect } from './on-before-connect';

export { RoomDurableObject } from './room';

const app = new Hono<{ Bindings: Env }>();

// Dev-only WS-upgrade log (which room, status) — dormant in prod (DEV_LOGS unset).
app.use('*', devRequestLogger());

// /parties/* is the ONLY worker-served path. Assets binding handles every other URL
// (including SPA fallback to index.html via not_found_handling). The onBeforeConnect
// hook authenticates the upgrade at the edge and stamps x-avlo-user-id for the DO (§7).
app.use('/parties/*', partyserverMiddleware<{ Bindings: Env }>({ options: { onBeforeConnect: makeOnBeforeConnect() } }));

export default app;
export type MainApp = typeof app;
