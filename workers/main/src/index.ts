import { Hono } from 'hono';
import { partyserverMiddleware } from 'hono-party';

export { RoomDurableObject } from './room';

const app = new Hono<{ Bindings: Env }>();

// /parties/* is the ONLY worker-served path. Assets binding handles every other URL
// (including SPA fallback to index.html via not_found_handling).
app.use('/parties/*', partyserverMiddleware());

// Defensive fallback: if run_worker_first matches a non-parties path somehow, forward
// to the Assets binding so we never accidentally 404 the SPA from the worker.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
export type MainApp = typeof app;
