import type { Permission, RoomId, UserId } from '@avlo/shared';
import type { AuthCtx } from './cookies';
import type { MetaEvent } from './zod/room-event';

/**
 * Minimal RPC-surface interfaces for cross-config binary RPC (§5.1 of the handoff).
 *
 * `wrangler types` types a `services` binding (and a cross-script DO binding) as an
 * untyped `Fetcher`/`Service` — it cannot resolve the target class's methods across
 * separate wrangler configs. So the call site casts the binding to one of these and
 * calls through it. The shapes are kept honest by `assertRpcMatch` drift guards at each
 * implementation site (`workers/main/src/room.ts`, `workers/auth/src/rpc.ts`) — drift
 * fails typecheck there, not at runtime here.
 */

/** auth worker's `AuthRpc` — cookie header in → resolved identity out, pure (H18). */
export interface AuthRpcSurface {
  verifySession(cookieHeader: string | null): Promise<AuthCtx | null>;
}

/**
 * main worker's `RoomDurableObject` cross-script surface — owner-only meta mutations (§8).
 *
 * `roomId` MUST be the id the stub was derived from. Raw native RPC cannot resolve
 * partyserver's `this.name` on a cold DO (it bypasses the fetch/webSocket init that
 * hydrates it), so the DO takes its identity from this argument — after proving
 * `idFromName(roomId)` equals its own `ctx.id`, which makes a forged or mismatched id
 * impossible rather than merely trusted. Derive stub + argument from the one validated
 * value via `roomDoStub`.
 *
 * Both RPCs return the full post-mutation meta snapshot (the `MetaEvent` shape) so the
 * users worker can mirror the DO's queue projection with a direct rev-guarded D1 upsert
 * and hand the client a read-your-writes Sessions bookmark. Thrown `Error.message`s are
 * the wire contract: `'forbidden'` (caller isn't the owner) | `'invalid-title'` (failed
 * the shared normalize) | `'room-mismatch'` (identity proof failed — a caller bug). The
 * users worker maps them to 403 / 400 / 500.
 */
export interface RoomDoStub {
  setPermission(roomId: RoomId, caller: UserId, next: Permission): Promise<MetaEvent>;
  setTitle(roomId: RoomId, caller: UserId, title: string): Promise<MetaEvent>;
}

/** The ONE cast site for the cross-script `rooms` binding (§5.1) — stub and RPC argument
 *  derive from the same validated `roomId`, the coherence `#verifyRoomId` proves DO-side. */
export const roomDoStub = (rooms: DurableObjectNamespace, roomId: RoomId): RoomDoStub =>
  rooms.get(rooms.idFromName(roomId)) as unknown as RoomDoStub;
