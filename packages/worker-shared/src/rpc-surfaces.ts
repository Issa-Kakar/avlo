import type { Permission, RoomId, UserId } from '@avlo/shared';
import type { AuthCtx } from './cookies';
import type { MetaEvent } from './zod/room-event';

/**
 * Minimal RPC-surface interfaces for cross-config binary RPC (§5.1 of the handoff).
 *
 * `wrangler types` types a `services` binding (and a cross-script DO binding) as an
 * untyped `Service`/`DurableObjectNamespace` — it cannot resolve the target class's
 * methods across separate wrangler configs. These interfaces ARE the contract, and they
 * sit on both ends:
 *
 *   • Producer — the implementing class declares `implements <Surface>`, so any drift
 *     (renamed/removed method, param/return change) fails typecheck at the class itself,
 *     with a native error (`workers/{auth,users,images}/src/rpc.ts`, `sync/src/room.ts`).
 *   • Consumer — the worker retypes the untyped binding to the surface ONCE in its env via
 *     `RefineBindings<Env, { AUTH: AuthRpcSurface }>`, so call sites read
 *     `c.env.AUTH.verifySession(...)` with no per-call cast.
 *
 * The cross-script DO is the one binding still reached through a cast helper (`roomDoStub`)
 * — its stub must be derived together with the validated room id it's called with.
 */

/**
 * Retype specific cross-config bindings of the generated worker `Env` to their RPC
 * surfaces. `wrangler types` can only emit them as untyped `Service`/`DurableObjectNamespace`,
 * and the generated `Env` interface can't be narrowed in place (declaration-merging a
 * differently-typed `AUTH` is a conflict, not a refinement) — so each consumer omits the
 * loose bindings and intersects the precise ones. `keyof Overrides` drives the omit, so the
 * removed keys can never drift from the re-added ones. Pure type-level; never instantiated.
 *
 * Pass the GLOBAL `Env`, NOT `Cloudflare.Env`: the runtime types merge an empty
 * `interface Env {}` into `namespace Cloudflare`, and tsgo computes `keyof` of that merged
 * namespaced interface as `never` — which silently collapses the `Omit` to `{}`. The global
 * `Env` is a single unmerged declaration, so its `keyof` resolves the bindings correctly.
 */
export type RefineBindings<Base, Overrides> = Omit<Base, keyof Overrides> & Overrides;

/** auth worker's `AuthRpc` — cookie header in → resolved identity out, pure (H18). */
export interface AuthRpcSurface {
  verifySession(cookieHeader: string | null): Promise<AuthCtx | null>;
}

/**
 * users worker's `UsersRpc` — called only by the auth worker's OAuth callback (§9).
 * Promote-or-adopt, one atomic D1 upsert: new `googleSub` → promote `currentUserId` into
 * the account row; existing → adopt that account's userId (+ refresh email/name; ingest's
 * `avatarHash` is coalesced so a failed snapshot never clobbers a stored avatar — the
 * RETURNED `avatarHash` is the post-coalesce truth). `bookmark` is the D1 Sessions
 * read-your-writes token. Throws on D1 failure after retries — the callback fails closed.
 */
export interface UsersRpcSurface {
  linkAccount(
    currentUserId: UserId,
    googleSub: string,
    profile: { email: string; name: string; avatarHash: string | null },
  ): Promise<{ userId: UserId; avatarHash: string | null; bookmark: string }>;
}

/**
 * images worker's `ImagesRpc` — snapshot a Google avatar into R2 under the write-once
 * `avatars/<hash32>` key (§9). Returns the 32-hex truncated content hash or `null` on ANY
 * failure; NEVER throws — the OAuth callback awaits it inline and a missing avatar must
 * not fail sign-in.
 */
export interface ImagesRpcSurface {
  ingestAvatar(pictureUrl: string): Promise<string | null>;
}

/**
 * sync worker's `AvloDO` cross-script surface — owner-only meta mutations (§8).
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
