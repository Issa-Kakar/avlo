import type { Permission, UserId } from '@avlo/shared';
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
 * This now covers the cross-script DO too — its binding is retyped to a branded surface
 * (`DurableObjectNamespace<RoomDoRpc>`), so the call site reads
 * `c.env.rooms.getByName(id).setTitle(...)` with no cast. Zero cast sites remain.
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
 * Branded so the users worker types its binding `DurableObjectNamespace<RoomDoRpc>` and
 * calls `c.env.rooms.getByName(id).setTitle(...)` with NO cast. The brand is a string-literal
 * marker, structurally shared across `@cloudflare/workers-types` (this package) and the
 * worker's generated runtime types, so the surface satisfies the namespace generic in either
 * place. `AvloDO` declares `implements RoomDoRpc`, so drift fails at the class.
 *
 * No room-id argument: the DO derives its own identity from `ctx.id.name` — populated by the
 * runtime for any stub addressed via `getByName`/`idFromName`, on every entry path incl. the
 * cold raw-RPC wake and the constructor (workerd ≥ 2026-03). The `getByName(validatedId)`
 * addressing IS the identity binding, so there's nothing to forge and nothing to re-verify;
 * only the authenticated `caller` rides along (the DO can't read a cookie on the RPC path).
 *
 * Both return the post-mutation `MetaEvent` snapshot so the users worker can mirror the DO's
 * queue projection with a direct rev-guarded D1 upsert + a read-your-writes bookmark. Thrown
 * `Error.message`s are the wire contract: `'forbidden'` (caller isn't the owner) |
 * `'invalid-title'` (failed the shared normalize). The users worker maps them to 403 / 400.
 */
export interface RoomDoRpc extends Rpc.DurableObjectBranded {
  setPermission(caller: UserId, next: Permission): Promise<MetaEvent>;
  setTitle(caller: UserId, title: string): Promise<MetaEvent>;
}
