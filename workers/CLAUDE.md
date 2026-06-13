# Cloudflare Workers

> Pre-production, solo dev. Routes blocks are **commented out** in every `wrangler.jsonc` — the merge changes nothing in production. Deploy is gated on DNS transfer + additional pre-prod essentials, both out of scope.

Five independently-deployed Workers, one folder each. Shared server primitives live in `@avlo/worker-shared`; D1 + DO-SQLite Drizzle schemas in `@avlo/db`; typed HTTP-RPC clients live in `@avlo/api-client` (browser/SW side).

## Topology

```
avlo.io                    images.avlo.io           unfurl.avlo.io
─────────────────────────  ────────────────────     ─────────────────
workers/main               workers/images           workers/unfurl
• SPA via ASSETS binding   • PUT /:key (upload)     • GET /?url=
• WSS /parties/*           • GET /:key (serve)      • SSRF guard (Zod)
• rooms DO (SQLite)        • IMAGES R2 bucket       • IMAGES R2 (shared)
• DOCS R2 (V2 snapshots)   • caches.default         • caches.default
```

## Worker Inventory

| Worker | Folder | Wrangler `name` | Dev port | Prod subdomain | Bindings |
|---|---|---|---|---|---|
| **main** | `workers/main/` | `avlo` | 8787 | `avlo.io`, `www.avlo.io` | `ASSETS` (Static Assets), `rooms` (DO/SQLite), `DOCS` (R2), `AUTH` (service), `ROOM_VISITS`/`ROOM_META` (queue producers) |
| **images** | `workers/images/` | `avlo-images` | 8790 | `images.avlo.io` | `IMAGES` (R2 `avlo-assets`), `AUTH` (service), `RL_UPLOAD` |
| **unfurl** | `workers/unfurl/` | `avlo-unfurl` | 8791 | `unfurl.avlo.io` | `IMAGES` (R2 `avlo-assets`, shared), `AUTH` (service), `RL_UPLOAD` |
| **auth** | `workers/auth/` | `avlo-auth` | 8792 | `auth.avlo.io` | `SESSIONS` (KV), `RL_AUTH`, services `USERS`/`IMAGES`, secrets `ANON_SECRET`/`GOOGLE_CLIENT_SECRET`/`OAUTH_PKCE_SECRET`, public vars `GOOGLE_CLIENT_ID`/`APP_ORIGIN`/`OAUTH_REDIRECT_URI` |
| **users** | `workers/users/` | `avlo-users` | 8793 | `users.avlo.io` | `DB` (D1 `avlo-db`), `AUTH` (service), `RL_ROOMS`, cross-script `rooms` (DO), queue consumers `avlo-room-visits`/`avlo-room-meta` (+DLQs) |

> Beyond the three public R2/SPA edge workers above, **auth** (`auth.avlo.io` — `GET /me`, the signed `avlo_anon` cookie, the Google OAuth flow `GET /login/google` → `GET /callback` + `POST /logout`, opaque KV sessions, `AuthRpc.verifySession`) and **users** (`users.avlo.io` — `GET /rooms`, `PATCH /rooms/:id/{permission,title}`, `UsersRpc.linkAccount`, the queue→D1 consumer) form the identity + dashboard-data vertical. `@avlo/db` owns the D1 + DO-SQLite schemas they (and main) share.

**Naming rule (load-bearing):** Sibling workers use `workers/<short>/` = wrangler `name` `avlo-<short>` = subdomain stem `<short>.avlo.io`. The main worker is asymmetric on every axis — wrangler `name: "avlo"` (bare, preserves the `rooms` DO namespace), subdomain `avlo.io` (bare, canonical app identity). The `avlo-` prefix is for things *attached to* the app; the app itself is just `avlo`. **Do not rename main.**

**Binding name `IMAGES`** (R2) on `workers/{images,unfurl}` instead of CF's default `ASSETS`, because `ASSETS` is reserved for Cloudflare's Static Assets binding on `workers/main`. If/when CF Images transformations land on `unfurl`, its binding gets a non-default name (`IMG_TRANSFORM` is the stub in the commented wrangler block) since the R2 binding already owns `IMAGES`.

## Per-worker File Map

### `workers/main/` — SPA host + Yjs sync (merged)
| File | Responsibility |
|---|---|
| `src/index.ts` | `partyserverMiddleware()` on `/parties/*` — the ONLY worker-served path (`run_worker_first` scopes the worker to it; the Assets binding serves every other URL, SPA fallback included, **without invoking the worker** — so there is no in-worker catch-all). Dev-only `devRequestLogger` first. Exports `RoomDurableObject` + `MainApp`. |
| `src/room.ts` | `RoomDurableObject extends YServer<Env>` — hibernate, debounced V2 snapshot to `env.DOCS`, hard-flush + z-key renorm on empty-room close. Single trigger by design (onLoad scan would be defensive O(N) for a self-healing failure: long keys are perf, not correctness, and the next successful onClose catches up). Never-empty rooms are a documented limitation; if profiling ever surfaces it, add alarm-based periodic renorm. Meta RPCs `setPermission(roomId, caller, …)`/`setTitle(roomId, caller, …)` (owner-only; BOTH mint meta when absent — offline-created room renamed/shared from the dashboard pre-first-connect; `#mintMeta` takes the permission, mint is rev 1 with no extra bump) take the room id as their first argument: partyserver's `this.name` is unresolvable on a cold raw-RPC wake (native RPC bypasses the fetch/webSocket init that hydrates it), so `#verifyRoomId` proves `idFromName(roomId)` equals `ctx.id` and identity thereafter is `this.meta.roomId` (`RoomMeta` = `MetaEvent`, the row PK constructor-loaded). They share `#mintMeta`/`#projectMeta`, return the `MetaEvent` snapshot, push `mode:`/`title:`/`owner:`/`perm:` custom messages (`title:` rebroadcast to every connection on rename; `setPermission` runs ONE pass over live connections — caller's tabs get `perm:` only, non-owners are 4403-evicted on private or get the `mode:` re-push + `perm:`, never a message to a just-closed socket), and throw `forbidden`/`invalid-title`/`room-mismatch` as the wire error contract; `assertRpcMatch` pins the class surface to `RoomDoStub`. The enqueue inside `#projectMeta` is try/caught — SQLite already committed; the users worker's direct write + the next meta event converge D1. |
| `wrangler.jsonc` | `assets.directory: ../../client/dist`, `binding: ASSETS`, `run_worker_first: ["/parties/*"]`, `migrations: new_sqlite_classes`. |

Same-origin SPA + WSS — SPA on `avlo.io` opens `wss://avlo.io/parties/rooms/<id>` via `window.location.host` in `client/src/runtime/room-doc-manager.ts`. No CORS, no preflight.

**No `app-type.ts` mock here** — main's only HTTP route is the Assets-binding catch-all (browser doesn't typed-RPC into it) and `/parties/*` is WSS via `y-partyserver` directly. Skip until a client-facing HTTP route is added.

**Dev mode caveat.** Under `npm run dev` (the single-instance orchestrator), main's **Static Assets are dropped** — Vite serves the SPA and main is hit only on `/parties/*`, so `client/dist` is **not** needed and the `ASSETS` binding is simply **absent** in dev (main's worker code no longer references it — the defensive `c.env.ASSETS.fetch` catch-all was removed; the orchestrator drops `entry.assets` with no stub). Consequently `run_worker_first` + the `not_found_handling` SPA fallback are exercised only by `dev:legacy`, `preview`, and prod — those serve the real Assets binding and need `../../client/dist` to exist (run `npm run build -w client` first, else the binding fails to start). Either way, never visit `http://localhost:8787` directly in dev; visit `http://localhost:3000` (Vite). See *Dev Orchestration* below for the one-instance topology.

### `workers/images/` — image upload + GET + avatar snapshot
| File | Responsibility |
|---|---|
| `src/index.ts` | per-worker `createCors({ methods: ['GET','PUT'], … })`, route-scoped `cspHeaders` (`asset-body` GETs / `api-json` PUT) + `csrf` on PUT, `app.onError` CSP stamp, drift-guard, default export + `ImagesRpc`. |
| `src/upload.ts` | `handleUpload` (H1 zod param + H2 content-length-bound + dedup + magic-byte + hash-verify + R2 put). CSP via the route's `cspHeaders('api-json')`. |
| `src/get.ts` | `handleGetAsset` (H1 zod param, Range bypasses `caches.default`, R2 conditional + range read, `Accept-Ranges` advertised). CSP via the route's `cspHeaders('asset-body')` — covers 200/206 + the 304/404 early returns. |
| `src/avatar.ts` | `handleGetAvatar` — `GET /avatars/:hash` (32-hex zod param), mirror of `get.ts` minus Range. Write-once content key ⇒ `Cache-Control: public, max-age=31536000, immutable` is CORRECT end-to-end (edge + browser + the SW's cache-first images origin). Public read; capability = the unguessable hash. |
| `src/rpc.ts` | `ImagesRpc.ingestAvatar(pictureUrl) → 32-hex \| null`, called only by auth's OAuth callback (H11). https + `googleusercontent.com` host allowlist (belt & braces over the verified claim) → `=s<N>(-c)` → `=s256-c` rewrite → ONE capped fetch (5 s, 1 MiB, no retry) → magic-byte sniff → `sha256[0..32)` → head-then-put `avatars/<hash>` (put in `retryTransient`). NEVER throws; redacted warns (H10). `assertRpcMatch` pins `ImagesRpcSurface`. |
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

`/me` is the ONLY identity resolver — no client-side `userId` mint. Dev: Vite `/api/auth/*` proxy; the OAuth nav routes work through it too (localhost cookies are host-only + port-agnostic, so the flow cookie set via `:3000` is readable at the registered `:8792/callback`). **`dev:p` (PORT_OFFSET) cannot complete OAuth** — Google only redirects to the registered `:8792` URI; everything else about the offset session works. Secrets live in `workers/auth/.dev.vars` (gitignored) locally, `wrangler secret put` in prod; a stale dev session started before a `.dev.vars` edit serves `undefined` secrets — restart `npm run dev` after editing it (the 500 signature is `setSignedCookie → getCryptoKey` TypeError). `RL_AUTH` is rate-limit namespace **1003** (1001 images, 1002 unfurl, 1004 users).

### `workers/users/` — dashboard data + projections (§4–§8)
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({methods:['GET','PATCH'],…})` → `cspHeaders('api-json')` → `csrf` → `requireAuth` → `userRateLimiter(RL_ROOMS)` → routes; `app.onError` CSP stamp; default export `{ fetch, queue }` + `UsersRpc`. |
| `src/handlers/rooms.ts` | `GET /rooms` (D1 Sessions read, `x-d1-bookmark`, `isOwner` derived, `ownerName` via `users` left-join — null for anon owners; private rooms the caller doesn't own stay in the response as the client's prune signal but are REDACTED to `title:''`/`ownerName:null`) + `PATCH /rooms/:id/{permission,title}` (→ cross-script DO `setPermission`/`setTitle` via `roomDoStub` — stub + first RPC argument from the one validated id; `metaRpcFailure` maps the DO's thrown message: `forbidden`→403, `invalid-title`→400, anything else→500 logged + client-retryable). Both PATCHes then run `projectMetaRYW` — the returned snapshot direct-written to D1 via the shared rev-guarded upsert on a `first-primary` session, bookmark out in body + `x-d1-bookmark` (read-your-writes for instant nav home); a failed direct write returns `''`, never an error (the queue converges). |
| `src/queue.ts` | `consume` — both queues (`switch(batch.queue)`); `safeParse` → ack-drop poison; coalesce by the DO's per-room `rev`, then ONE `db.batch` of chunked multi-row upserts (≤96 bound params/statement — D1 caps 100). Meta rows go through `upsertRoomsFromMeta` (@avlo/db — the same statement the PATCH handlers direct-write with). LWW guarded by `excluded.rev >`; owner/createdAt first-write-wins. |
| `src/rpc.ts` | `UsersRpc.linkAccount(currentUserId, googleSub, {email, name, avatarHash})` — called only by auth's OAuth callback (§9). ONE atomic upsert on a `first-primary` session: `INSERT … ON CONFLICT(google_sub) DO UPDATE` (email/name refresh; `avatar_hash = coalesce(excluded, existing)` so a failed ingest never clobbers) `RETURNING` — new sub **promotes** the device id, existing sub **adopts** the account's userId. `user_id` PK conflict (device id already linked to a different account) is deterministic → caught → retried once with a fresh ulid; a same-account repeat sign-in dual-conflicts on the SAME row and resolves through the conflict target (verified). `withRetry` covers transient D1 failures; returns the post-coalesce `avatarHash` + RYW bookmark. `assertRpcMatch` pins `UsersRpcSurface`. |
| `src/env.ts` | `UsersEnv = { Bindings: Env; Variables: { userId: UserId } }`, threaded through every handler (Hono `Context` is invariant in `Variables`). |
| `src/zod/rooms.ts` | `roomIdParam`/`permissionBody`/`titleBody` validators for the PATCH routes (`titleBody` normalizes via the shared `normalizeRoomTitle`). |
| `src/app-type.ts` | Public mock — `RoomListEntry`/`RoomListResponse` wire shapes for `hc<UsersApp>`. |

Globally auth-gated. D1 is the sole schema owner (`@avlo/db`). Dev: Vite `/api/users/*` proxy.

## App-Type Pattern (Option H)

Each worker that exposes a typed HTTP-RPC client to `@avlo/api-client` (auth, users, images, unfurl — main is exempt) has a **public mock** in `src/app-type.ts` separate from the real handler in `src/index.ts`. The mock encodes the wire shape (paths, methods, validators, response types) ambient-free so client-side typecheck can traverse it without pulling worker ambient types (`Env`, `R2Bucket`, `HTMLRewriter`, `caches.default`).

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
5. Add a Vite proxy entry in `client/vite.config.ts`.
6. Add a dev port to `scripts/dev-ports.json` (heed the `_comment`: `PORT_OFFSET` is already `10`; keep it ≥ the port-span). The orchestrator reads this JSON for its worker list.
7. Add the dir→wrangler-`name` entry to the `NAME` map in `scripts/dev-miniflare.mjs` (else the pre-flight assert fails the new cross-worker edges). For `dev:legacy` rollback parity, also add `dev:<name>` to root `package.json` + the `dev:legacy` chain.
8. Add the typecheck workspace to the root `typecheck` and `typecheck:tsc` scripts.
9. Add a `deploy:<name>` script to root `package.json`.
10. Add a row to the Worker Inventory table above.

For inter-worker calls (today: `AUTH.verifySession` from images/unfurl/users/main, `USERS.linkAccount` + `IMAGES.ingestAvatar` from auth, users' cross-script `rooms` DO), use `WorkerEntrypoint` + `[[services]] entrypoint` — binary RPC via service bindings, not public-internet `fetch()` or `hc<App>` over a service-binding fetcher. The two are different layers; don't conflate.

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
- **The DO is the authority.** Room permission/ownership decisions read the room DO (never D1); `setPermission` is owner-only and re-pushes/evicts live connections. D1 is a display projection only; producers tie payloads to the event schemas (`satisfies z.input<…>`), the consumer `safeParse`s + upserts idempotently. Meta RPCs carry their own identity: the users worker passes the validated room id with the call (raw cross-script RPC can't resolve partyserver's `this.name` on a cold DO) and the DO rejects any id that doesn't `idFromName(…)`-hash to its own `ctx.id`. The blind RPC casts (`RoomDoStub`, `AuthRpcSurface`) are pinned by `assertRpcMatch` drift guards at the implementing classes.
- **CSP is middleware, not per-handler.** `cspHeaders(profile)` (worker-shared) stamps the profile on egress, so every returned response — auth `/me`, users `/rooms` + PATCH, the `requireAuth` 401, images' 304/404 — carries it with nothing to forget. `applyCsp` remains for hand-built `Headers` + the `onError` path (csrf's thrown 403).
- **CORS is per-worker.** `createCors({ methods, allowHeaders?, exposeHeaders? })` advertises only what each worker serves (auth `GET`; users `GET`+`PATCH` + `x-d1-bookmark`; images `GET`+`PUT` + range/etag/accept-ranges; unfurl `GET`). The shared `isAllowedOrigin`/`isDevHost` predicate reflects the origin allowlist and gates `http://localhost:*` to dev (by request `Host`), so prod never reflects a localhost origin against the credentialed `.avlo.io` cookie.
- **CSRF on mutating routes.** `hono/csrf` guards users `PATCH` + images `PUT` + auth `POST /logout`, reusing the CORS origin allowlist (one source of truth). It engages on form content-types AND content-type-less requests (a bare `$post()` defaults to `text/plain` in the check) — `application/json` and binary uploads bypass, so `hc` traffic is unaffected — and never on GET/HEAD; service-binding RPC bypasses HTTP middleware entirely. **OAuth tripwire resolved:** sessions stay `SameSite=Lax` (the server-side code flow needs no cross-site cookie sends — Google's redirect back is a top-level GET to auth's own `/callback`, which Lax permits) and csrf now covers the auth worker. Residual tripwire: revisit if any subdomain begins serving first-party HTML.

## Dev Orchestration

`npm run dev` runs Vite + **one** Miniflare instance holding **all five workers** (`scripts/dev-miniflare.mjs`). One instance is non-negotiable: Cloudflare Queues only deliver when producer (`main` → `ROOM_VISITS`/`ROOM_META`) and consumer (`users`) share a single Miniflare (cross-process *service bindings* work since Sept 2025; cross-process *queues* do not — workers-sdk #9795). The old per-worker `wrangler dev` chain gave each worker its own Miniflare, so locally the queue → D1 projection never ran. Single source of truth for base ports stays `scripts/dev-ports.json`; Vite imports the same JSON for proxy targets, **unchanged** — that's the whole point.

```bash
npm run dev                                # Vite + ONE Miniflare (all 5 workers; queues + cross-script DO + service RPC live)
PORT_OFFSET=10 VITE_PORT=5180 npm run dev   # parallel session (dev:p alias — orchestrator reads PORT_OFFSET)
npm run dev:workers                        # just the orchestrator (no Vite)
npm run dev:legacy                         # ROLLBACK: the old five-process wrangler-dev chain (no queues across workers)
(cd workers/<name> && npm run types)       # regenerate worker-configuration.d.ts
```

**Topology inside the one instance.** `main` (wrangler `avlo`) is `workers[0]` — the **entry worker** on Miniflare's top-level `port` (8787+offset). This is the same entry path `wrangler dev` serves partyserver WS on, so the `/parties/*` upgrade + DO stay on proven ground (not an unsafe socket). `images`/`unfurl`/`auth`/`users` each pin `unsafeDirectSockets: [{ port: <existing dev port>+offset, entrypoint: 'default', proxy: false }]` → each listens on its **exact current port**, so the Vite proxy reaches every worker unchanged. Confirm at startup: each logs `[mf] <name> -> <url>` on the expected port (8787/8790-8793, +offset).

**No config fork.** `unstable_getMiniflareWorkerOptions(wrangler.jsonc)` (wrangler, experimental — pinned `~4.92.0`) translates each config into Miniflare options faithfully: services→entrypoints, cross-script DO, queues, D1/KV/R2, **rate limits**, and it **auto-folds `workers/auth/.dev.vars`** (the orchestrator keeps a defensive merge if a wrangler bump ever stops folding). The one thing it doesn't do is bundle TypeScript — esbuild does that here (`node:*`/`cloudflare:*` external; `.sql` → text inlines main's drizzle migrations). A **pre-flight assert** fails loudly if any `services[].name` / DO `scriptName` doesn't resolve to an assembled worker (the `NAME` dir→wrangler-name map is load-bearing). Two source-confirmed fix-ups: `users`' cross-script `rooms` DO is forced `useSQLite=true` (the translator derives it from the binding worker's own migrations, which `users` lacks), and `main`'s Static Assets are **dropped in dev** (see main's *Dev mode caveat*).

**Hot reload.** esbuild watches each worker's resolved graph **including `packages/*/src`** — a save rebuilds (sub-100 ms) and calls `mf.setOptions(...)`, which reloads in place: persisted state, DO storage, and the listening ports/direct sockets all survive, so the Vite proxy never blips. Build/reload errors are non-fatal (logged; last good bundle stays live). **`wrangler.jsonc` edits are NOT watched** — restart `npm run dev` (same partial behavior as `wrangler dev`).

**Dev logging.** The programmatic Miniflare API suppresses the `[mf:*]` request/lifecycle log by default, so the orchestrator passes `log: new Log(logLevel)` — `MF_LOG_LEVEL=info` (default; entry-worker request lines + reload notices) → `debug` (binding/options detail) → `verbose` (workerd internals). This is the `--verbose` equivalent (a wrangler-CLI flag, inapplicable to the script). The orchestrator also injects `DEV_LOGS='1'` into every worker; `@avlo/worker-shared/dev-logs` gates the rest off it: `devRequestLogger` (per-worker request lines — the dependable source for the direct-socket workers, which bypass Miniflare's entry log), `devDrizzleLogger` (SQL + params on D1 + the room DO), `traceRpc` (every service + DO-meta RPC: `method → outcome · ms`), and the DO hibernation/wake lines in `room.ts`. **`DEV_LOGS` is absent from every `wrangler.jsonc`**, so prod (`wrangler deploy`) leaves it unset and all of the above stay dormant — the only always-on addition is the H10-safe queue projection heartbeat (`[queue] … applied/superseded · ms`) in `users/src/queue.ts`. `dev:legacy` (raw `wrangler dev`) doesn't set `DEV_LOGS` — there you get wrangler's own request UI instead. Prod observability is the per-worker `observability.enabled: true` + `wrangler tail`; **tail/Tail-Workers are prod-only** (they stream/trace a *deployed* worker — not a local-dev tool). For local deep dives use the single inspector at `9229+offset` (console + breakpoints across all five isolates).

**`PORT_OFFSET` is `10`** (in `dev-ports.json`'s `_comment` + the `dev:p` alias). Base ports span 8787…8793, so the offset must stay ≥ 7; 10 leaves headroom. There is now **ONE inspector** for all isolates at `9229`+offset (the per-worker base+1000+offset scheme was a per-process artifact). `dev:p` also uses `VITE_PORT=5180` (3001 is reserved on some WSL2/Windows hosts); note `dev:p` still can't complete Google OAuth (Google only redirects to the registered `:8792`).

**Shared Miniflare state.** The orchestrator sets `defaultPersistRoot` to `<repoRoot>/.wrangler/state/v3` — **the `v3` segment is load-bearing.** `wrangler dev --persist-to <X>` (and `wrangler d1 migrations apply --persist-to <X>`) store under `<X>/v3/{d1,r2,kv,do,cache}`, but Miniflare's `defaultPersistRoot` does NOT add `v3`; pointing it at the bare `.wrangler/state` opens a brand-new EMPTY tree beside the real one (D1 with no tables → "no such table: room_visits", empty R2 buckets, lost KV sessions + DO room data). Appending `v3` makes the orchestrator read the exact same SQLite/R2 tree the legacy `wrangler dev` wrote (same DB keys), so it's a drop-in. Like the legacy `dev-worker.mjs`, ONE tree regardless of `PORT_OFFSET` (each git checkout/worktree has its own `.wrangler/`, so two checkouts never contend; the `avlo-parallel` worktree gets its own `…/.wrangler/state/v3`). One instance means one process opening the tree serially, so the cross-process `SQLITE_BUSY` create-race the old `dev-worker.mjs` guarded with retry-and-jitter is **gone** — a real startup error now surfaces immediately. Shared R2 still needs matching `bucket_name` across configs — `r2_buckets[].bucket_name = "avlo-assets"` is identical in `workers/{images,unfurl}/wrangler.jsonc` — but co-location now also gives genuine cross-worker queues, cross-script DO RPC, and service-binding RPC (incl. the mutual `auth↔users`/`auth↔images` cycle). `.wrangler/` is gitignored at the repo root.

**D1 migrations are not auto-applied** (not by the orchestrator, not by `wrangler dev`) — a one-time manual step, same as before. On a fresh state tree the `users` D1 has no tables and `GET /rooms` 500s with `no such table: room_visits`; the orchestrator detects this at startup and prints the fix: `npx wrangler d1 migrations apply avlo-db --local --persist-to .wrangler/state -c workers/users/wrangler.jsonc` (note `--persist-to .wrangler/state`, NOT `…/v3` — wrangler appends `v3` itself). DO-SQLite migrations (main's `rooms`) self-apply in the DO constructor via drizzle `migrate()`, so only the D1 ones are manual.

**`dev:legacy` escape hatch.** `scripts/dev-worker.mjs` + the `dev:main`…`dev:users` scripts are retained **verbatim**, reachable only via `dev:legacy`. It restores the exact five-`wrangler dev` behavior (separate Miniflare each → no cross-worker queues) for rollback, and is the only `dev` path (besides `preview`/prod) that exercises main's real Static-Assets binding + SPA fallback — so it needs `client/dist` (run `npm run build -w client` first).

## CI

`.github/workflows/ci.yml` runs typecheck (tsgo — the same check you run locally — plus a redundant `tsc --noEmit` pass whose only job is to catch the preview compiler ever diverging from tsc), biome check, client build, and the **SW bundle isolation grep**:

```bash
grep -E 'partyserverMiddleware|HTMLRewriter|R2Bucket|isPrivateHost' client/dist/sw.js
# empty output = pass
```

This is the load-bearing check that proves type-only imports of worker AppTypes are fully erased at build time. If anyone introduces a runtime import of `@avlo/worker-shared` from SW-graph code, those symbols leak into the bundle and CI fails.

## Anti-Patterns

| ❌ Don't | ✅ Do |
|---|---|
| Public-internet `fetch('https://other.avlo.io/...')` between workers | `WorkerEntrypoint` + `[[services]] entrypoint` |
| `hc<App>('/', { fetch: env.X.fetch.bind(env.X) })` for inter-worker | HTTP serialization in the wrong layer. Use binary RPC |
| Re-create the "site" worker — split SPA hosting from sync | Main does both (same-origin, no WSS CORS) |
| Inline `createCors` / `applyCsp` / SSRF / asset-key Zod in a new worker | Import from `@avlo/worker-shared`; add a parameter if needed, don't fork |
| Read `c.req.param/query/header(...)` without Zod | `zValidator(...)` first (H1) |
| Buffer body before `Content-Length` check | Validate header first (H2) |
| Trust client-provided content hash | Server `sha256Hex(buffer) === key` (H4) |
| Inline CSP literals, or a per-handler `applyCsp` you can forget | `cspHeaders(profile)` middleware (H5); `applyCsp` only for hand-built `Headers` / `onError` |
| Serve cached 200 to a `Range` request | Skip `caches.default.match` when `Range` present |
| Re-introduce `ASSETS` as binding for the images R2 bucket | Binding is `IMAGES`; `ASSETS` is reserved for Static Assets on main |
| Rename main's wrangler `name` from `avlo` to `avlo-main` | Asymmetry is load-bearing — preserves DO namespace, signals canonical app identity |
| Add a route to main that isn't `/parties/*` or the Assets fallback | Make a new worker; main stays minimal |
| Import `@avlo/worker-shared` from any client-side bundle | Server-only. Client uses `@avlo/api-client` (typed `hc`) and `@avlo/shared` (cross-runtime). Missing path entry in `client/tsconfig*.json` makes this a hard typecheck failure |
| Add `@avlo/worker-shared` to `client/tsconfig.json` paths | The omission IS the guardrail |
| Import `import type { FooApp } from '…/workers/foo/src/index'` in `@avlo/api-client` | Always import from `.../src/app-type`. The mock exists to prevent the ambient-types leak; bypassing reintroduces it |
| Drop `assertSurfaceMatch<...>(true)` from a real `index.ts` | Without it, mock and real silently diverge and typed clients reference stale routes |
| Stop to run `tsc` / `npm run typecheck:tsc` as a "ground truth" pass after worker/backend edits | `npm run typecheck` (tsgo) **is** the check — client *and* workers, no exceptions. The `tsc` parity pass is reserved for CI and pre-prod; it is never an agent step |
| Uncomment a `[[routes]]` block as part of any refactor | Deploy is gated on more than DNS — additional pre-prod essentials still needed |
| Speculatively cap `cpu_ms` in `wrangler.jsonc` | No cap until profiling shows a pathological ceiling worth defending |
| Use `console.log` in worker code | Biome blocks it; `console.warn`/`error` with redacted payloads (H10) |
