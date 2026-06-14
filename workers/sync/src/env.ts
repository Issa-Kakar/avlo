import type { AuthRpcSurface, RefineBindings } from '@avlo/worker-shared';

// Hono/partyserver env for the sync edge. The WS-upgrade hook (`on-before-connect`) calls
// the AUTH service binding to verify the cookie, so AUTH is retyped from the untyped
// cross-config `Service` to its RPC surface — `c.env.AUTH.verifySession(...)` with no cast
// (§5.1). The room DO (`AvloDO extends YServer<Env>`) uses the raw generated `Env`, NOT
// this — it reads the edge-stamped `x-avlo-user-id` header and never touches AUTH.
export type SyncEnv = { Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface }> };
