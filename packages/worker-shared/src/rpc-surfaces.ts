import type { Permission, UserId } from '@avlo/shared';
import type { AuthCtx } from './cookies';
import type { MetaEvent } from './zod/room-event';

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

/**
 * main worker's `RoomDurableObject` cross-script surface — owner-only meta mutations (§8).
 * Both RPCs return the full post-mutation meta snapshot (the `MetaEvent` shape) so the
 * users worker can mirror the DO's queue projection with a direct rev-guarded D1 upsert
 * and hand the client a read-your-writes Sessions bookmark.
 */
export interface RoomDoStub {
  setPermission(caller: UserId, next: Permission): Promise<MetaEvent>;
  setTitle(caller: UserId, title: string): Promise<MetaEvent>;
}
