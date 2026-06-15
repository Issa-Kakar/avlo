# Cloudflare Workers

> Pre-production, solo dev. Routes blocks are **commented out** in every `wrangler.jsonc` — the merge changes nothing in production. Deploy is gated on DNS transfer + additional pre-prod essentials, both out of scope.

Six independently-deployed Workers, one folder each. Shared server primitives live in `@avlo/worker-shared`; D1 + DO-SQLite Drizzle schemas in `@avlo/db`; typed HTTP-RPC clients live in `@avlo/api-client` (browser/SW side).

## Topology

```
avlo.io               sync.avlo.io          images.avlo.io        unfurl.avlo.io
────────────────────  ────────────────────  ────────────────────  ─────────────────
workers/main          workers/sync          workers/images        workers/unfurl
• SPA (Static         • WSS /sync/*         • PUT /:key (upload)   • GET /?url=
  Assets only)        • AvloDO (SQLite)     • GET /:key (serve)    • SSRF guard (Zod)
• _headers CSP        • DOCS R2 (V2 snaps)  • IMAGES R2 bucket     • IMAGES R2 (shared)
• no worker script    • Origin guard + auth • caches.default       • caches.default
```

## Worker Inventory

| Worker | Folder | Wrangler `name` | Dev port | Prod subdomain | Bindings |
|---|---|---|---|---|---|
| **main** | `workers/main/` | `avlo` | — (Vite serves the SPA in dev) | `avlo.io`, `www.avlo.io` | Static Assets only — no worker script, no bindings (the `_headers` CSP rides the Assets layer) |
| **sync** | `workers/sync/` | `avlo-sync` | 8787 | `sync.avlo.io` | `rooms` (DO/SQLite, class `AvloDO`), `DOCS` (R2), `AUTH` (service), `ROOM_VISITS`/`ROOM_META` (queue producers) |
| **images** | `workers/images/` | `avlo-images` | 8790 | `images.avlo.io` | `IMAGES` (R2 `avlo-assets`), `AUTH` (service), `RL_UPLOAD` |
| **unfurl** | `workers/unfurl/` | `avlo-unfurl` | 8791 | `unfurl.avlo.io` | `IMAGES` (R2 `avlo-assets`, shared), `AUTH` (service), `RL_UPLOAD` |
| **auth** | `workers/auth/` | `avlo-auth` | 8792 | `auth.avlo.io` | `SESSIONS` (KV), `RL_AUTH`, services `USERS`/`IMAGES`, secrets `ANON_SECRET`/`GOOGLE_CLIENT_SECRET`/`OAUTH_PKCE_SECRET`, public vars `GOOGLE_CLIENT_ID`/`APP_ORIGIN`/`OAUTH_REDIRECT_URI` |
| **users** | `workers/users/` | `avlo-users` | 8793 | `users.avlo.io` | `DB` (D1 `avlo-db`), `AUTH` (service), `RL_ROOMS`, cross-script `rooms` (DO), queue consumers `avlo-room-visits`/`avlo-room-meta` (+DLQs) |

> Beyond the four edge workers above (the `avlo` site host + the `sync` realtime host + images/unfurl), **auth** (`auth.avlo.io` — `GET /me`, the signed `avlo_anon` cookie, the Google OAuth flow `GET /login/google` → `GET /callback` + `POST /logout`, opaque KV sessions, `AuthRpc.verifySession`) and **users** (`users.avlo.io` — `GET /rooms`, `PATCH /rooms/:id/{permission,title}`, `UsersRpc.linkAccount`, the queue→D1 consumer) form the identity + dashboard-data vertical. `@avlo/db` owns the D1 + DO-SQLite schemas they (and `sync`) share.

**Naming rule (load-bearing):** Sibling workers use `workers/<short>/` = wrangler `name` `avlo-<short>` = subdomain stem `<short>.avlo.io` — `sync` (`workers/sync` = `avlo-sync` = `sync.avlo.io`) follows it exactly, DO namespace included. The **main** worker is the one asymmetry: wrangler `name: "avlo"` (bare) + subdomain `avlo.io` (bare) — the canonical app identity. The `avlo-` prefix is for things *attached to* the app; the app itself is just `avlo`. **Do not rename main.** (Before the split, main's bare name also pinned the `rooms` DO namespace — that namespace now lives in `avlo-sync`, so the only thing the bare name preserves today is the public domain stem.)

**Binding name `IMAGES`** (R2) on `workers/{images,unfurl}` instead of CF's default `ASSETS`, because `ASSETS` is the conventional name for Cloudflare's Static Assets binding (the `workers/main` site worker serves the SPA — as a pure assets-only worker it declares no binding, but the name stays reserved by convention). If/when CF Images transformations land on `unfurl`, its binding gets a non-default name (`IMG_TRANSFORM` is the stub in the commented wrangler block) since the R2 binding already owns `IMAGES`.

## Per-worker File Map

### `workers/main/` — SPA site host (assets-only)
| File | Responsibility |
|---|---|
| `wrangler.jsonc` | `name: "avlo"`, `assets.directory: ../../web/dist` + `not_found_handling: single-page-application`. NO `main`, NO worker script, NO `ASSETS` binding — Cloudflare's Static Assets layer serves the SPA + the `web/public/_headers` CSP directly. Yjs sync + the DO moved to `avlo-sync`, so SPA deploys (`deploy:main`) never touch the DO worker — the whole point of the split. |

A pure assets-only worker. A worker *script* can be re-added later (redirects, etc.) without disturbing sync. Not run in dev (Vite serves the SPA); its real Static-Assets binding is exercised only by `preview` and prod. (`pnpm preview` builds `web/dist` automatically via `turbo run build`.)

### `workers/sync/` — Yjs realtime sync + room DO
| File | Responsibility |
|---|---|
| `src/index.ts` | `partyserverMiddleware()` on `` /`${SYNC_WS_PREFIX}`/* `` (= `/sync/*`) with `options.prefix: SYNC_WS_PREFIX` → partyserver routes `<prefix>/rooms/<id>` where `rooms` is the **kebab-cased DO binding name** (class is `AvloDO`; binding stays `rooms`, so the URL party segment is unchanged). Pure worker: every request hits it, non-`/sync` paths 404. Dev-only `devRequestLogger` first. Exports `AvloDO` + `SyncApp`. |
| `src/on-before-connect.ts` | Edge guard for the WS upgrade. **CSWSH Origin allowlist FIRST** (`isAllowedOrigin`/`isDevHost` — the SAME shared set as CORS + csrf, no drift) since sync is now cross-origin from the SPA; then the room-id format guard; then the cookie→`x-avlo-user-id` verify/stamp/**delete** invariant (unchanged — never trust an inbound value). |
| `src/room.ts` | `AvloDO extends YServer<Env>` (was `RoomDurableObject`; binding stays `rooms`) — hibernate, debounced V2 snapshot to `env.DOCS`, hard-flush + z-key renorm on empty-room close. Meta RPCs `setPermission(caller, …)`/`setTitle(caller, …)` (owner-only; BOTH mint meta when absent — offline-created room renamed/shared from the dashboard pre-first-connect; `#mintMeta` takes the permission, mint is rev 1 with no extra bump) carry no room id: identity is `asRoomId(this.name)` (= `ctx.id.name`, populated on every entry path incl. the cold raw-RPC wake for any `getByName`/`idFromName`-addressed stub — workerd ≥ 2026-03), so there's no `#verifyRoomId` and no id to forge. They share `#mintMeta`/`#projectMeta`, return the `MetaEvent` snapshot, push `mode:`/`title:`/`owner:`/`perm:` custom messages, and throw `forbidden`/`invalid-title` as the wire error contract; the class declares `implements RoomDoRpc`, so surface drift fails typecheck at the class. The enqueue inside `#projectMeta` is try/caught — SQLite already committed; the users worker's direct write + the next meta event converge D1. |
| `drizzle/` | DO-SQLite migrations — the constructor's `migrate()` reads them; `migrations.js` imports the `.sql` as a text module (bundled via the wrangler `rules` Text glob). Regenerate target of `@avlo/db`'s `db:generate-do`. |
| `wrangler.jsonc` | `name: avlo-sync`, `durable_objects: rooms→AvloDO`, `migrations: new_sqlite_classes: ["AvloDO"]`, `DOCS` R2, `AUTH` service, `ROOM_VISITS`/`ROOM_META` queue producers, `rules` Text glob. No `assets`. |

Cross-origin SPA → sync — the SPA on `avlo.io` opens `wss://sync.avlo.io/sync/rooms/<id>` (host from `SYNC_HOST_PROD`, prefix from `SYNC_WS_PREFIX`, in `web/src/runtime/room-doc-manager.ts`). `avlo.io → sync.avlo.io` is **same-site** (so `SameSite=Lax` permits the `.avlo.io` cookie on the upgrade) but **cross-origin** (so a true cross-site attacker is blocked by Lax — plus the explicit Origin guard in `on-before-connect`).

**No `app-type.ts` mock here** — sync exposes only WSS (`y-partyserver` directly; the browser doesn't typed-RPC into it), so it's exempt from the App-Type pattern. Skip until a client-facing HTTP route is added.

### `workers/images/` — image upload + GET + avatar snapshot
| File | Responsibility |
|---|---|
| `src/index.ts` | per-worker `createCors({ methods: ['GET','PUT'], … })`, route-scoped `cspHeaders` (`asset-body` GETs / `api-json` PUT) + `csrf` on PUT, `app.onError` CSP stamp, drift-guard, default export + `ImagesRpc`. |
| `src/upload.ts` | `handleUpload` (H1 zod param + H2 content-length-bound + dedup + magic-byte + hash-verify + R2 put). CSP via the route's `cspHeaders('api-json')`. |
| `src/get.ts` | `handleGetAsset` (H1 zod param, Range bypasses `caches.default`, R2 conditional + range read, `Accept-Ranges` advertised). CSP via the route's `cspHeaders('asset-body')` — covers 200/206 + the 304/404 early returns. |
| `src/avatar.ts` | `handleGetAvatar` — `GET /avatars/:hash` (32-hex zod param), mirror of `get.ts` minus Range. Write-once content key ⇒ `Cache-Control: public, max-age=31536000, immutable` is CORRECT end-to-end (edge + browser + the SW's cache-first images origin). Public read; capability = the unguessable hash. |
| `src/rpc.ts` | `ImagesRpc.ingestAvatar(pictureUrl) → 32-hex \| null`, called only by auth's OAuth callback (H11). https + `googleusercontent.com` host allowlist (belt & braces over the verified claim) → `=s<N>(-c)` → `=s256-c` rewrite → ONE capped fetch (5 s, 1 MiB, no retry) → magic-byte sniff → `sha256[0..32)` → head-then-put `avatars/<hash>` (put in `retryTransient`). NEVER throws; redacted warns (H10). `implements ImagesRpcSurface` pins the surface. |
| `src/app-type.ts` | Public mock app — wire shape for `hc<ImagesApp>(...)`. Ambient-free. |

Paths are bare `/:key` + `/avatars/:hash` (disjoint — two segments vs one). Dev uses `/api/images/*` via Vite proxy with `rewrite` stripping the prefix. The `avatars/` key prefix keeps avatar objects disjoint from bare 64-hex board keys in the shared `avlo-assets` bucket (different reference roots: D1/session vs Y.Doc; R2 lifecycle rules can filter by prefix). Old avatar blobs are never pruned — stale session references keep rendering; orphans are tiny + unguessable.

### `workers/unfurl/` — bookmark unfurl
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({ methods: ['GET'] })` + `cspHeaders('api-json')`, `zValidator('query', unfurlQuery)`, drift-guard. |
| `src/unfurl.ts` | HTMLRewriter OG extraction, image fetch + R2 store (shared `avlo-assets`), edge cache 7d via `syntheticCacheUrl('unfurl', …)`. |
| `src/app-type.ts` | Public mock + exported `UnfurlResponseBody` (real handler imports the type to constrain its data builder). |

Path is `/` (subdomain IS the namespace in prod). Dev uses `/api/unfurl?url=` via Vite proxy.

**Unfurl writes R2 directly.** It binds the same `avlo-assets` bucket as the images worker. An inter-worker round-trip to call `images.put(key, body)` would do the same hash + put — one less hop to do it inline. `validateImage` stays single-sourced via `@avlo/shared`.

### `workers/auth/` — identity (anon + Google OAuth, §2/§9)
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({ methods: ['GET','POST'] })` → `cspHeaders('api-json')` → local `noStore` (every response `Cache-Control: no-store` — identity bodies + OAuth redirects) → `csrf` (origin allowlist; guards POST /logout, skips GET so the cross-site callback is unaffected) → routes; `RL_AUTH` `ipRateLimiter` on the three OAuth routes (NOT `/me` — identity boot, an IP key would 429 whole NATs); `app.onError(cspError)`; drift-guard; default export + `AuthRpc`. |
| `src/handlers/me.ts` | `GET /me` — session branch FIRST (valid KV record → account body with `email` + `avatarHash`, cookie re-set every hit, KV re-put only when < 25 d remain; KV outage degrades to anon), else the anon path: verify + slide the signed `avlo_anon` cookie, else mint a fresh `userId`. Exports `ANON_MAX_AGE_SEC` (400-day sliding ceiling). |
| `src/handlers/login.ts` | `GET /login/google` — `sanitizeReturnTo` → PKCE S256 + state + nonce (Arctic) → ONE signed single-use `avlo_oauth` flow cookie (`{state, codeVerifier, nonce, returnTo, iat}`, HttpOnly, **Lax** — Strict would drop it on Google's cross-site GET back, host-only, Max-Age 600) → 302 Google (`prompt=select_account`, scopes `openid email profile`, **no** `access_type=offline` — Google tokens never stored). |
| `src/handlers/callback.ts` | `GET /callback` — the strictly-ordered trust pipeline: flow cookie read → **deleted unconditionally** (single-use; replay dies here) → shape parse + re-`sanitizeReturnTo` → provider error split (`denied`/`error`) → iat ≤ 10 min + state equality → Arctic code exchange (**never retried** — single-use code) → jose `jwtVerify` (RS256 pinned, iss/aud/exp vs Google JWKS) + Zod claim narrowing (`email_verified === true` hard-required) + nonce match → inline best-effort `IMAGES.ingestAvatar` → `USERS.linkAccount` + KV session put as ONE **fail-closed** unit (failure ⇒ no session cookie, `?auth=error`) → `avlo_session` cookie → `waitUntil` replaced-session delete → **promote-only anon rotation** (iff this sign-in consumed the device's anon id, re-issue a fresh one — sign-out can't be bypassed via the leftover 400-day cookie; adopt keeps it, its id was never linked). Every exit 302s `${APP_ORIGIN}${returnTo}?auth=ok\|denied\|error`. Reason-code-only logging (H10 — the request URL carries `code`/`state`). |
| `src/handlers/logout.ts` | `POST /logout` — retried KV delete (TTL backstop on persistent failure) + attribute-matched cookie clear → 204 always. |
| `src/oauth.ts` | `makeGoogle` (client id/secret/redirect from env — **exact-redirect baseline**, never request-derived), `flowCookieOpts` (host-only Lax variant), module-scope `JWKS = createRemoteJWKSet(…)` (lazy I/O, per-isolate key cache), `verifyGoogleIdToken` (jwtVerify + claims + nonce → claims \| null). |
| `src/session.ts` | Opaque KV sessions: 256-bit base64url token in `avlo_session`; KV record at `sess:<sha256hex(token)>` (a KV dump yields no usable tokens), `expirationTtl` 30 d + app-side `exp`. `readSession` (shape-gates the token before any I/O; KV `cacheTtl: 60` ⇒ documented ≤60 s revocation lag), `putSession`/`slideSession`/`deleteSession` (all `retryTransient` — critical writes), `mintSessionToken`. |
| `src/zod/oauth.ts` | `sanitizeReturnTo` (path-only, no `//`, no `\`, no control bytes, ≤256 — applied at /login AND re-applied at /callback), `loginQuery`, `callbackQuery`, `OAuthFlowToken`, `GoogleClaims`. |
| `src/zod/session.ts` | `SessionRecord` — parsed on EVERY read; `userId` format-gated + branded (the `AnonToken` discipline). |
| `src/rpc.ts` | `AuthRpc.verifySession(cookieHeader)` — KV session branch first, anon HMAC fallback. **Signature unchanged** ⇒ images/unfurl/users gates + main's WS `on-before-connect` inherit Google sessions with zero changes. KV outage degrades signed-in → anon (availability over fail-closed; flip = remove the fallthrough). |
| `src/app-type.ts` | Public mock — `MeResponse` (+ optional `email`/`avatarHash`) + the three OAuth routes for `hc<AuthApp>`. |

`/me` is the ONLY identity resolver — no client-side `userId` mint. Dev: Vite `/api/auth/*` proxy; the OAuth nav routes work through it too (localhost cookies are host-only + port-agnostic, so the flow cookie set via `:3000` is readable at the registered `:8792/callback`). **`dev:p` (PORT_OFFSET) completes OAuth too** — the orchestrator's `ensureAuthDevVars` derives `OAUTH_REDIRECT_URI`=`http://localhost:8802/callback` + `APP_ORIGIN`=`http://localhost:5180` from the offset, and BOTH redirect URIs (`:8792` and `:8802`) are registered on the Google web client, so Google's redirect and the post-login Vite bounce both resolve. `makeGoogle` stays env-only (never request-derived — a security invariant), so the orchestrator is the sole injection point. Secrets live in `workers/auth/.dev.vars` (gitignored) locally, `wrangler secret put` in prod; a stale dev session started before a `.dev.vars` edit serves `undefined` secrets — restart `pnpm dev` after editing it (the 500 signature is `setSignedCookie → getCryptoKey` TypeError). `RL_AUTH` is rate-limit namespace **1003** (1001 images, 1002 unfurl, 1004 users).

### `workers/users/` — dashboard data + projections (§4–§8)
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({methods:['GET','PATCH'],…})` → `cspHeaders('api-json')` → `csrf` → `requireAuth` → `userRateLimiter(RL_ROOMS)` → routes; `app.onError` CSP stamp; default export `{ fetch, queue }` + `UsersRpc`. |
| `src/handlers/rooms.ts` | `GET /rooms` (D1 Sessions read, `x-d1-bookmark`, `isOwner` derived, `ownerName` via `users` left-join — null for anon owners; private rooms the caller doesn't own stay in the response as the client's prune signal but are REDACTED to `title:''`/`ownerName:null`) + `PATCH /rooms/:id/{permission,title}` (→ cross-script DO `setPermission`/`setTitle` via `c.env.rooms.getByName(id)` — the binding is typed `DurableObjectNamespace<RoomDoRpc>`, no cast; `metaRpcFailure` maps the DO's thrown message: `forbidden`→403, `invalid-title`→400, anything else→500 logged + client-retryable). Both PATCHes then run `projectMetaRYW` — the returned snapshot direct-written to D1 via the shared rev-guarded upsert on a `first-primary` session, bookmark out in body + `x-d1-bookmark` (read-your-writes for instant nav home); a failed direct write returns `''`, never an error (the queue converges). |
| `src/queue.ts` | `consume` — both queues (`switch(batch.queue)`); `safeParse` → ack-drop poison; coalesce by the DO's per-room `rev`, then ONE `db.batch` of chunked multi-row upserts (≤96 bound params/statement — D1 caps 100). Meta rows go through `upsertRoomsFromMeta` (@avlo/db — the same statement the PATCH handlers direct-write with). LWW guarded by `excluded.rev >`; owner/createdAt first-write-wins. |
| `src/rpc.ts` | `UsersRpc.linkAccount(currentUserId, googleSub, {email, name, avatarHash})` — called only by auth's OAuth callback (§9). ONE atomic upsert on a `first-primary` session: `INSERT … ON CONFLICT(google_sub) DO UPDATE` (email/name refresh; `avatar_hash = coalesce(excluded, existing)` so a failed ingest never clobbers) `RETURNING` — new sub **promotes** the device id, existing sub **adopts** the account's userId. `user_id` PK conflict (device id already linked to a different account) is deterministic → caught → retried once with a fresh ulid; a same-account repeat sign-in dual-conflicts on the SAME row and resolves through the conflict target (verified). `withRetry` covers transient D1 failures; returns the post-coalesce `avatarHash` + RYW bookmark. `implements UsersRpcSurface` pins the surface. |
| `src/env.ts` | `UsersEnv = { Bindings: RefineBindings<Env, { AUTH: AuthRpcSurface; rooms: DurableObjectNamespace<RoomDoRpc> }>; Variables: { userId: UserId } }` — `AUTH` AND the cross-script `rooms` DO both retyped to their RPC surfaces, so `requireAuth` and `c.env.rooms.getByName(id).setTitle(...)` need no cast; threaded through every handler (Hono `Context` is invariant in `Variables`). |
| `src/zod/rooms.ts` | `roomIdParam`/`permissionBody`/`titleBody` validators for the PATCH routes (`titleBody` normalizes via the shared `normalizeRoomTitle`). |
| `src/app-type.ts` | Public mock — `RoomListEntry`/`RoomListResponse` wire shapes for `hc<UsersApp>`. |

Globally auth-gated. D1 is the sole schema owner (`@avlo/db`). Dev: Vite `/api/users/*` proxy.

## App-Type Pattern (Option H)

Each worker that exposes a typed HTTP-RPC client to `@avlo/api-client` (auth, users, images, unfurl — `main` is assets-only and `sync` is WSS-only, so both are exempt) has a **public mock** in `src/app-type.ts` separate from the real handler in `src/index.ts`. The mock encodes the wire shape (paths, methods, validators, response types) ambient-free so client-side typecheck can traverse it without pulling worker ambient types (`Env`, `R2Bucket`, `HTMLRewriter`, `caches.default`).

**Why a mock?** The cross-tsconfig leak: `@avlo/api-client`'s `import type { ImagesApp } from '../../../workers/images/src/index'` would drag the real index's ambient deps into client compilation (cascading `TS2304` failures). The mock has none of those — it's pure Hono + Zod + inline schemas — so client compilation traverses it cleanly.

**Why not relax the real Hono `Bindings: Env` to `any` to escape the leak?** That loses the entire point of having `Env` — handler bodies become untyped against bindings.

**Why inline schemas in the mock?** If `app-type.ts` imported from `@avlo/worker-shared`, the cross-package import graph would noisier or fail (depending on resolution). The mock only needs the wire shape, not validation/refinement — the real handler is the source of truth for those.

### Drift guard

The mock and real app can drift silently: a route on the real not in the mock is invisible to typed clients; a route on the mock not in the real makes typed clients 404 at runtime. Each `src/index.ts` asserts surface-match against the mock:

```ts
import { assertSurfaceMatch } from '@avlo/worker-shared';
import type { FooApp as PublicSurface } from './app-type';

const app = new Hono<{ Bindings: Env }>().get('/', …);

assertSurfaceMatch<typeof app, PublicSurface>(true);
```

When real/mock paths × methods diverge in either direction, `AssertEqual<…>` resolves to `never`, the `true` argument fails the parameter type, and tsgo/tsc flag the call site. Verified empirically in both directions.

## Future-Worker Checklist

When adding a new worker (`code-exec`, `auth`, `ai`, …):

1. Add `<NAME>_ORIGIN` to `packages/api-client/src/origins.ts` (mirror `IMAGES_ORIGIN` / `UNFURL_ORIGIN`).
2. Create `workers/<name>/{wrangler.jsonc,package.json,tsconfig.json,src/index.ts,src/app-type.ts}` plus generated `worker-configuration.d.ts`.
3. Add the drift-guard `assertSurfaceMatch<typeof app, PublicSurface>(true)` call in `src/index.ts`.
4. Create `packages/api-client/src/<name>.ts` (`hc<FooApp>(FOO_ORIGIN)`) and re-export from `packages/api-client/src/index.ts`.
5. Add a Vite proxy entry in `web/vite.config.ts`.
6. Add a dev port to `scripts/dev-ports.json` (heed the `_comment`: `PORT_OFFSET` is already `10`; keep it ≥ the port-span). The orchestrator reads this JSON for its worker list — the **first** key is the Miniflare entry worker (`sync` today, on the top-level port); **append** new workers, don't prepend.
7. Add the dir→wrangler-`name` entry to the `NAME` map in `scripts/dev-miniflare.mjs` (else the pre-flight assert fails the new cross-worker edges). The orchestrator auto-discovers the worker from `dev-ports.json` (step 6) — no root `package.json` dev script to add.
8. Add `typecheck` + `typecheck:tsc` scripts to the worker's `package.json` (Turbo discovers them via `turbo run typecheck` — no root change).
9. Add `deploy: wrangler deploy` to the worker's `package.json`, then a delegating `deploy:<name>: pnpm --filter @avlo/<name> deploy` to root `package.json` (+ the root `deploy` chain).
10. Add a row to the Worker Inventory table above.

For inter-worker calls (today: `AUTH.verifySession` from images/unfurl/users/sync, `USERS.linkAccount` + `IMAGES.ingestAvatar` from auth, users' cross-script `rooms` DO), use `WorkerEntrypoint` + `[[services]] entrypoint` — binary RPC via service bindings, not public-internet `fetch()` or `hc<App>` over a service-binding fetcher. The two are different layers; don't conflate. Typing: the **producer** class declares `implements <Surface>` (the `*RpcSurface` from `@avlo/worker-shared/rpc-surfaces`), so drift fails natively at the class; the **consumer** retypes the untyped `Service` binding to that surface via `RefineBindings<Env, { AUTH: AuthRpcSurface }>` in its `env.ts` (pass the global `Env`, not `Cloudflare.Env`), so `c.env.AUTH.verifySession(...)` needs no cast. The cross-script `rooms` DO follows the same pattern: its binding is retyped `DurableObjectNamespace<RoomDoRpc>` (a branded surface), so `c.env.rooms.getByName(id).setTitle(...)` needs no cast — zero cast sites remain.

## Hardening Invariants (H1–H12)

Every PR touching a worker route must satisfy these. Non-negotiable.

| # | Invariant | Enforced by |
|---|---|---|
| H1 | Every path/query/header param Zod-validated before handler. | `zValidator('param'|'query'|'header', schema)` |
| H2 | `Content-Length` bounded BEFORE body await. | `zValidator('header', contentLengthBound(MAX))` |
| H3 | Zod does NOT touch image bytes, `Range`, or `If-*` headers. | Explicit — see `@avlo/worker-shared/zod/*` |
| H4 | Content-addressed keys server-computed and compared. | `sha256Hex(buffer) === key` |
| H5 | CSP set on every *returned* response via the `cspHeaders(profile)` egress middleware (never a forgettable per-handler call). | `app.use('*', cspHeaders(profile))`, or route-scoped where a worker serves two profiles (images GET `asset-body` / PUT `api-json`). Covers 304/404 early returns + the `requireAuth` 401. Thrown `HTTPException`s (csrf 403) are stamped by `app.onError`. |
| H6 | CORS is first middleware on every cross-origin worker, scoped per worker. | `app.use('*', createCors({ methods, allowHeaders?, exposeHeaders? }))` first — each worker advertises only the verbs + headers it serves. Main is exempt (same-origin SPA + WSS). |
| H7 | Synthetic cache keys namespaced by service. | `syntheticCacheUrl('unfurl', sha)` |
| H8 | No worker writes to a bucket it doesn't bind. | `r2_buckets` declared per-service |
| H9 | SSRF guard runs in a Zod `.refine`, not handler. | `unfurlQuery` chain |
| H10 | No URL/body/query logging at any level. | `console.warn`/`error` with redacted strings. Existing unfurl `[unfurl] request:` logs are grandfathered; do NOT add new full-URL logs. |
| H11 | Inter-worker calls via `WorkerEntrypoint`, never public `fetch()` or `hc` over service-binding fetcher. | `[[services]] entrypoint: "FooRpc"` + `await env.FOO.method(args)` |
| H12 | Every worker exports `export type <Name>App = typeof app;` (or re-exports from `app-type`) + any `WorkerEntrypoint` classes. | Last lines of `src/index.ts` |

## Platform Hardening (auth / users / room DO)

The identity + authz vertical layers these on top of H1–H12 (the formal H13–H28 enumeration from plan §15 is still to be merged into the table above):

- **Server-resolved identity only.** No client-side `userId` mint; auth `/me` is the sole source. `UserId`/`RoomId` are branded + validated at every wire boundary (`AnonToken` parse, `verifyAnonToken`, queue `safeParse`, D1 `$type<>()`, the edge-stamped `x-avlo-user-id` header verified in `on-before-connect`).
- **Auth gate before handler.** `requireAuth` (via the `AUTH` service RPC) resolves `c.get('userId')` before any gated route; `userRateLimiter` keys tier-1 limits on it.
- **The DO is the authority.** Room permission/ownership decisions read the room DO (never D1); `setPermission` is owner-only and re-pushes/evicts live connections. D1 is a display projection only; producers tie payloads to the event schemas (`satisfies z.input<…>`), the consumer `safeParse`s + upserts idempotently. Meta RPCs carry their own identity: the DO reads `asRoomId(this.name)` (= `ctx.id.name`, populated for any `getByName`/`idFromName`-addressed stub on every entry path incl. the cold raw-RPC wake, workerd ≥ 2026-03), so the meta RPCs take no room-id argument and need no identity proof — the `getByName(validatedId)` addressing binds the object to the id. The cross-config RPC contracts are enforced natively: each entrypoint class declares `implements <Surface>`, and each consumer retypes the untyped binding to the surface via `RefineBindings<Env, {…}>` in its `env.ts` (so call sites are type-checked against the surface, not blind-cast); the cross-script `rooms` DO is no exception — its binding is retyped `DurableObjectNamespace<RoomDoRpc>`, so nothing is blind-cast.
- **CSP is middleware, not per-handler.** `cspHeaders(profile)` (worker-shared) stamps the profile on egress, so every returned response — auth `/me`, users `/rooms` + PATCH, the `requireAuth` 401, images' 304/404 — carries it with nothing to forget. `applyCsp` remains for hand-built `Headers` + the `onError` path (csrf's thrown 403).
- **CORS is per-worker.** `createCors({ methods, allowHeaders?, exposeHeaders? })` advertises only what each worker serves (auth `GET`; users `GET`+`PATCH` + `x-d1-bookmark`; images `GET`+`PUT` + range/etag/accept-ranges; unfurl `GET`). The shared `isAllowedOrigin`/`isDevHost` predicate reflects the origin allowlist and gates `http://localhost:*` to dev (by request `Host`), so prod never reflects a localhost origin against the credentialed `.avlo.io` cookie.
- **CSRF on mutating routes.** `hono/csrf` guards users `PATCH` + images `PUT` + auth `POST /logout`, reusing the CORS origin allowlist (one source of truth). It engages on form content-types AND content-type-less requests (a bare `$post()` defaults to `text/plain` in the check) — `application/json` and binary uploads bypass, so `hc` traffic is unaffected — and never on GET/HEAD; service-binding RPC bypasses HTTP middleware entirely. **OAuth tripwire resolved:** sessions stay `SameSite=Lax` (the server-side code flow needs no cross-site cookie sends — Google's redirect back is a top-level GET to auth's own `/callback`, which Lax permits) and csrf now covers the auth worker. Residual tripwire: revisit if any subdomain begins serving first-party HTML.

## Dev Orchestration

`pnpm dev` runs Vite + **one** Miniflare instance holding **all five dev workers** (`scripts/dev-miniflare.mjs`) — `sync` + images/unfurl/auth/users; the `avlo` site worker is NOT run in dev (Vite serves the SPA). One instance is non-negotiable: Cloudflare Queues only deliver when producer (`sync` → `ROOM_VISITS`/`ROOM_META`) and consumer (`users`) share a single Miniflare (cross-process *service bindings* work since Sept 2025; cross-process *queues* do not — workers-sdk #9795). The old per-worker `wrangler dev` chain gave each worker its own Miniflare, so locally the queue → D1 projection never ran. Single source of truth for base ports stays `scripts/dev-ports.json`; Vite imports the same JSON for proxy targets, **unchanged** — that's the whole point.

```bash
pnpm dev                                # Vite + ONE Miniflare (all 5 workers; queues + cross-script DO + service RPC live)
PORT_OFFSET=10 VITE_PORT=5180 pnpm dev   # parallel session (dev:p alias — orchestrator reads PORT_OFFSET)
pnpm dev:workers                        # just the orchestrator (no Vite)
(cd workers/<name> && pnpm types)       # regenerate worker-configuration.d.ts
```

**Topology inside the one instance.** `sync` (wrangler `avlo-sync`) is `workers[0]` — the **entry worker** on Miniflare's top-level `port` (8787+offset; `const ENTRY = 'sync'` + `sync` first in `dev-ports.json`). This is the same entry path `wrangler dev` serves partyserver WS on, so the `/sync/*` upgrade + DO stay on proven ground (not an unsafe socket). `images`/`unfurl`/`auth`/`users` each pin `unsafeDirectSockets: [{ port: <existing dev port>+offset, entrypoint: 'default', proxy: false }]` → each listens on its **exact current port**, so the Vite proxy reaches every worker unchanged. Confirm at startup: each logs `[mf] <name> -> <url>` on the expected port (8787/8790-8793, +offset).

**No config fork.** `unstable_getMiniflareWorkerOptions(wrangler.jsonc)` (wrangler, experimental — pinned `~4.92.0`) translates each config into Miniflare options faithfully: services→entrypoints, cross-script DO, queues, D1/KV/R2, **rate limits**, and it **auto-folds `workers/auth/.dev.vars`** (the orchestrator keeps a defensive merge if a wrangler bump ever stops folding). The one thing it doesn't do is bundle TypeScript — esbuild does that here (`node:*`/`cloudflare:*` external; `.sql` → text inlines sync's drizzle migrations). A **pre-flight assert** fails loudly if any `services[].name` / DO `scriptName` doesn't resolve to an assembled worker (the `NAME` dir→wrangler-name map is load-bearing — it must now resolve `users`' `scriptName: avlo-sync`, which it does). One source-confirmed fix-up remains: `users`' cross-script `rooms` DO is forced `useSQLite=true` (the translator derives it from the binding worker's own migrations, which `users` lacks). (No dev worker has an `assets` binding now — `avlo` isn't assembled in dev — so the old "drop main's Static Assets" fix-up is gone.)

**Hot reload.** esbuild watches each worker's resolved graph **including `packages/*/src`** — a save rebuilds (sub-100 ms) and calls `mf.setOptions(...)`, which reloads in place: persisted state, DO storage, and the listening ports/direct sockets all survive, so the Vite proxy never blips. Build/reload errors are non-fatal (logged; last good bundle stays live). **`wrangler.jsonc` edits are NOT watched** — restart `pnpm dev` (same partial behavior as `wrangler dev`).

**Dev logging.** The programmatic Miniflare API suppresses the `[mf:*]` request/lifecycle log by default, so the orchestrator passes `log: new Log(logLevel)` — `MF_LOG_LEVEL=info` (default; entry-worker request lines + reload notices) → `debug` (binding/options detail) → `verbose` (workerd internals). This is the `--verbose` equivalent (a wrangler-CLI flag, inapplicable to the script). The orchestrator also injects `DEV_LOGS='1'` into every worker; `@avlo/worker-shared/dev-logs` gates the rest off it: `devRequestLogger` (per-worker request lines — the dependable source for the direct-socket workers, which bypass Miniflare's entry log), `devDrizzleLogger` (SQL + params on D1 + the room DO), `traceRpc` (every service + DO-meta RPC: `method → outcome · ms`), and the DO hibernation/wake lines in `room.ts`. **`DEV_LOGS` is absent from every `wrangler.jsonc`**, so prod (`wrangler deploy`) leaves it unset and all of the above stay dormant — the only always-on addition is the H10-safe queue projection heartbeat (`[queue] … applied/superseded · ms`) in `users/src/queue.ts`. A raw `wrangler dev` on a single worker doesn't set `DEV_LOGS` — there you get wrangler's own request UI instead. Prod observability is the per-worker `observability.enabled: true` + `wrangler tail`; **tail/Tail-Workers are prod-only** (they stream/trace a *deployed* worker — not a local-dev tool). For local deep dives use the single inspector at `9229+offset` (console + breakpoints across all five isolates).

**`PORT_OFFSET` is `10`** (in `dev-ports.json`'s `_comment` + the `dev:p` alias). Base ports span 8787…8793, so the offset must stay ≥ 7; 10 leaves headroom. There is now **ONE inspector** for all isolates at `9229`+offset (the per-worker base+1000+offset scheme was a per-process artifact). `dev:p` also uses `VITE_PORT=5180` (3001 is reserved on some WSL2/Windows hosts); `dev:p` **completes Google OAuth** — `ensureAuthDevVars` rewrites the auth worker's `OAUTH_REDIRECT_URI`/`APP_ORIGIN` to the offset ports (`:8802`/`:5180`), and both redirect URIs are registered on the Google client, so the round-trip lands (no worker code change — `makeGoogle` stays env-only).

**Shared Miniflare state.** The orchestrator sets `defaultPersistRoot` to `<repoRoot>/.wrangler/state/v3` — **the `v3` segment is load-bearing.** `wrangler dev --persist-to <X>` (and `wrangler d1 migrations apply --persist-to <X>`) store under `<X>/v3/{d1,r2,kv,do,cache}`, but Miniflare's `defaultPersistRoot` does NOT add `v3`; pointing it at the bare `.wrangler/state` opens a brand-new EMPTY tree beside the real one (D1 with no tables → "no such table: room_visits", empty R2 buckets, lost KV sessions + DO room data). Appending `v3` makes the orchestrator read the exact same SQLite/R2 tree the legacy `wrangler dev` wrote (same DB keys), so it's a drop-in. ONE tree regardless of `PORT_OFFSET` (each git checkout/worktree has its own `.wrangler/`, so two checkouts never contend; the `avlo-parallel` worktree gets its own `…/.wrangler/state/v3`). One instance means one process opening the tree serially, so the cross-process `SQLITE_BUSY` create-race the old per-worker chain guarded with retry-and-jitter is **gone** — a real startup error now surfaces immediately. Shared R2 still needs matching `bucket_name` across configs — `r2_buckets[].bucket_name = "avlo-assets"` is identical in `workers/{images,unfurl}/wrangler.jsonc` — but co-location now also gives genuine cross-worker queues, cross-script DO RPC, and service-binding RPC (incl. the mutual `auth↔users`/`auth↔images` cycle). `.wrangler/` is gitignored at the repo root.

**D1 migrations are not auto-applied** (not by the orchestrator, not by `wrangler dev`) — a one-time manual step, same as before. On a fresh state tree the `users` D1 has no tables and `GET /rooms` 500s with `no such table: room_visits`; the orchestrator detects this at startup and prints the fix: `npx wrangler d1 migrations apply avlo-db --local --persist-to .wrangler/state -c workers/users/wrangler.jsonc` (note `--persist-to .wrangler/state`, NOT `…/v3` — wrangler appends `v3` itself). DO-SQLite migrations (sync's `rooms`) self-apply in the DO constructor via drizzle `migrate()`, so only the D1 ones are manual.

**`preview` + the `avlo` site worker.** The dev orchestrator does NOT run the `avlo` site worker (Vite serves the SPA in dev), so main's real Static-Assets binding is exercised only by prod or a manual `wrangler dev -c workers/main/wrangler.jsonc`. `pnpm preview` serves the built SPA via Vite preview; its script runs `turbo run build` first, so `web/dist` is produced automatically.

## CI

`.github/workflows/ci.yml` runs typecheck (tsgo — the same check you run locally — plus a redundant `tsc --noEmit` pass whose only job is to catch the preview compiler ever diverging from tsc), biome check, web build, and the **SW bundle isolation grep**:

```bash
grep -E 'partyserverMiddleware|HTMLRewriter|R2Bucket|isPrivateHost' web/dist/sw.js
# empty output = pass
```

This is the load-bearing check that proves type-only imports of worker AppTypes are fully erased at build time. If anyone introduces a runtime import of `@avlo/worker-shared` from SW-graph code, those symbols leak into the bundle and CI fails.

## Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Public-internet `fetch('https://other.avlo.io/...')` between workers | `WorkerEntrypoint` + `[[services]] entrypoint` |
| `hc<App>('/', { fetch: env.X.fetch.bind(env.X) })` for inter-worker | HTTP serialization in the wrong layer. Use binary RPC |
| Merge sync back into the `avlo` site worker "to avoid cross-origin" | Keep them split — `avlo` is assets-only, `avlo-sync` hosts WSS + the DO. The `Domain=.avlo.io` cookie + the `on-before-connect` Origin guard handle cross-origin; SPA deploys then never touch the DO worker |
| Inline `createCors` / `applyCsp` / SSRF / asset-key Zod in a new worker | Import from `@avlo/worker-shared`; add a parameter if needed, don't fork |
| Read `c.req.param/query/header(...)` without Zod | `zValidator(...)` first (H1) |
| Buffer body before `Content-Length` check | Validate header first (H2) |
| Trust client-provided content hash | Server `sha256Hex(buffer) === key` (H4) |
| Inline CSP literals, or a per-handler `applyCsp` you can forget | `cspHeaders(profile)` middleware (H5); `applyCsp` only for hand-built `Headers` / `onError` |
| Serve cached 200 to a `Range` request | Skip `caches.default.match` when `Range` present |
| Re-introduce `ASSETS` as binding for the images R2 bucket | Binding is `IMAGES`; `ASSETS` is reserved by convention for Static Assets on the `avlo` site worker |
| Rename main's wrangler `name` from `avlo` to `avlo-main` | Asymmetry is load-bearing — bare `avlo` is the canonical app identity + public domain stem (the `rooms` DO namespace now lives in `avlo-sync`) |
| Add a worker script + routes to the `avlo` site host | It's assets-only; put WSS/server logic in `avlo-sync` or a new worker (a main script is fine ONLY for site-level concerns like redirects) |
| Rename `avlo-sync`'s `rooms` DO binding or change the `/sync` prefix on one side only | The URL party segment = the kebab-cased binding name (`rooms`); the prefix is `SYNC_WS_PREFIX` (shared) on the server + provider, a matching literal in the SW matcher + Vite proxy. Change all four together |
| Import `@avlo/worker-shared` from any client-side bundle | Server-only. Client uses `@avlo/api-client` (typed `hc`) and `@avlo/shared` (cross-runtime). Missing path entry in `web/tsconfig*.json` makes this a hard typecheck failure |
| Add `@avlo/worker-shared` to `web/tsconfig.json` paths | The omission IS the guardrail |
| Import `import type { FooApp } from '…/workers/foo/src/index'` in `@avlo/api-client` | Always import from `.../src/app-type`. The mock exists to prevent the ambient-types leak; bypassing reintroduces it |
| Drop `assertSurfaceMatch<...>(true)` from a real `index.ts` | Without it, mock and real silently diverge and typed clients reference stale routes |
| Stop to run `tsc` / `pnpm typecheck:tsc` as a "ground truth" pass after worker/backend edits | `pnpm typecheck` (tsgo) **is** the check — client *and* workers, no exceptions. The `tsc` parity pass is reserved for CI and pre-prod; it is never an agent step |
| Uncomment a `[[routes]]` block as part of any refactor | Deploy is gated on more than DNS — additional pre-prod essentials still needed |
| Speculatively cap `cpu_ms` in `wrangler.jsonc` | No cap until profiling shows a pathological ceiling worth defending |
| Use `console.log` in worker code | Biome blocks it; `console.warn`/`error` with redacted payloads (H10) |
