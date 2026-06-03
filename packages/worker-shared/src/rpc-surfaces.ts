import type { Permission, UserId } from '@avlo/shared';
import type { AuthCtx } from './cookies';

/**
 * Minimal RPC-surface interfaces for cross-config binary RPC (§5.1 of the handoff).
 *
 * `wrangler types` types a `services` binding (and a cross-script DO binding) as an
 * untyped `Fetcher`/`Service` — it cannot resolve the target class's methods across
 * separate wrangler configs. So the call site casts the binding to one of these and
 * calls through it: `(c.env.AUTH as unknown as AuthRpcSurface).verifySession(...)`.
 *
 * The shapes mirror the real `WorkerEntrypoint` / DO methods exactly (same arg/return
 * types, branded ids), so caller and callee provably agree on the wire contract.
 */

/** auth worker's `AuthRpc` — cookie header in → resolved identity out, pure (H18). */
export interface AuthRpcSurface {
  verifySession(cookieHeader: string | null): Promise<AuthCtx | null>;
}

/** main worker's `RoomDurableObject` cross-script surface — owner-only permission flip (§8). */
export interface RoomDoStub {
  setPermission(caller: UserId, next: Permission): Promise<void>;
}
