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
| **auth** | `workers/auth/` | `avlo-auth` | 8792 | `auth.avlo.io` | secret `ANON_SECRET` |
| **users** | `workers/users/` | `avlo-users` | 8793 | `users.avlo.io` | `DB` (D1 `avlo-db`), `AUTH` (service), `RL_ROOMS`, cross-script `rooms` (DO), queue consumers `avlo-room-visits`/`avlo-room-meta` (+DLQs) |

> Beyond the three public R2/SPA edge workers above, **auth** (`auth.avlo.io` — `GET /me`, the signed `avlo_anon` cookie, `AuthRpc.verifySession`) and **users** (`users.avlo.io` — `GET /rooms`, `PATCH /rooms/:id/permission`, the queue→D1 consumer) form the identity + dashboard-data vertical. `@avlo/db` owns the D1 + DO-SQLite schemas they (and main) share.

**Naming rule (load-bearing):** Sibling workers use `workers/<short>/` = wrangler `name` `avlo-<short>` = subdomain stem `<short>.avlo.io`. The main worker is asymmetric on every axis — wrangler `name: "avlo"` (bare, preserves the `rooms` DO namespace), subdomain `avlo.io` (bare, canonical app identity). The `avlo-` prefix is for things *attached to* the app; the app itself is just `avlo`. **Do not rename main.**

**Binding name `IMAGES`** (R2) on `workers/{images,unfurl}` instead of CF's default `ASSETS`, because `ASSETS` is reserved for Cloudflare's Static Assets binding on `workers/main`. If/when CF Images transformations land on `unfurl`, its binding gets a non-default name (`IMG_TRANSFORM` is the stub in the commented wrangler block) since the R2 binding already owns `IMAGES`.

## Per-worker File Map

### `workers/main/` — SPA host + Yjs sync (merged)
| File | Responsibility |
|---|---|
| `src/index.ts` | `partyserverMiddleware()` on `/parties/*`, Assets binding fallback for everything else. Exports `RoomDurableObject` + `MainApp`. |
| `src/room.ts` | `RoomDurableObject extends YServer<Env>` — hibernate, debounced V2 snapshot to `env.DOCS`, hard-flush + z-key renorm on empty-room close. Single trigger by design (onLoad scan would be defensive O(N) for a self-healing failure: long keys are perf, not correctness, and the next successful onClose catches up). Never-empty rooms are a documented limitation; if profiling ever surfaces it, add alarm-based periodic renorm. |
| `wrangler.jsonc` | `assets.directory: ../../client/dist`, `binding: ASSETS`, `run_worker_first: ["/parties/*"]`, `migrations: new_sqlite_classes`. |

Same-origin SPA + WSS — SPA on `avlo.io` opens `wss://avlo.io/parties/rooms/<id>` via `window.location.host` in `client/src/runtime/room-doc-manager.ts`. No CORS, no preflight.

**No `app-type.ts` mock here** — main's only HTTP route is the Assets-binding catch-all (browser doesn't typed-RPC into it) and `/parties/*` is WSS via `y-partyserver` directly. Skip until a client-facing HTTP route is added.

**Dev mode caveat.** `wrangler dev` for main needs `../../client/dist` to exist (Assets binding fails to start otherwise). One-time setup: `npm run build -w client` before the first `npm run dev`. Subsequent dev sessions don't need to rebuild — Vite serves the SPA, and the main worker is only hit on `/parties/*`. Never visit `http://localhost:8787` directly in dev; visit `http://localhost:3000` (Vite).

### `workers/images/` — image upload + GET
| File | Responsibility |
|---|---|
| `src/index.ts` | per-worker `createCors({ methods: ['GET','PUT'], … })`, route-scoped `cspHeaders` (`asset-body` GET / `api-json` PUT) + `csrf` on PUT, `app.onError` CSP stamp, drift-guard, default export. |
| `src/upload.ts` | `handleUpload` (H1 zod param + H2 content-length-bound + dedup + magic-byte + hash-verify + R2 put). CSP via the route's `cspHeaders('api-json')`. |
| `src/get.ts` | `handleGetAsset` (H1 zod param, Range bypasses `caches.default`, R2 conditional + range read, `Accept-Ranges` advertised). CSP via the route's `cspHeaders('asset-body')` — covers 200/206 + the 304/404 early returns. |
| `src/app-type.ts` | Public mock app — wire shape for `hc<ImagesApp>(...)`. Ambient-free. |

Path is bare `/:key`. Dev uses `/api/images/:key` via Vite proxy with `rewrite` stripping the prefix.

### `workers/unfurl/` — bookmark unfurl
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({ methods: ['GET'] })` + `cspHeaders('api-json')`, `zValidator('query', unfurlQuery)`, drift-guard. |
| `src/unfurl.ts` | HTMLRewriter OG extraction, image fetch + R2 store (shared `avlo-assets`), edge cache 7d via `syntheticCacheUrl('unfurl', …)`. |
| `src/app-type.ts` | Public mock + exported `UnfurlResponseBody` (real handler imports the type to constrain its data builder). |

Path is `/` (subdomain IS the namespace in prod). Dev uses `/api/unfurl?url=` via Vite proxy.

**Unfurl writes R2 directly.** It binds the same `avlo-assets` bucket as the images worker. An inter-worker round-trip to call `images.put(key, body)` would do the same hash + put — one less hop to do it inline. `validateImage` stays single-sourced via `@avlo/shared`.

### `workers/auth/` — anonymous identity (§2)
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({ methods: ['GET'] })` + `cspHeaders('api-json')`, `GET /me`, drift-guard, default export + `AuthRpc`. |
| `src/handlers/me.ts` | `GET /me` — verify + slide the signed `avlo_anon` cookie, else mint a fresh `userId`; `name`/`color` deterministic from id (`@avlo/shared`). 400-day sliding Max-Age. |
| `src/rpc.ts` | `AuthRpc extends WorkerEntrypoint` — `verifySession(cookieHeader)` (anon-only today; OAuth/KV is the seam). |
| `src/app-type.ts` | Public mock — `MeResponse` wire shape for `hc<AuthApp>`. |

`/me` is the ONLY identity resolver — no client-side `userId` mint. Dev: Vite `/api/auth/*` proxy.

### `workers/users/` — dashboard data + projections (§4–§8)
| File | Responsibility |
|---|---|
| `src/index.ts` | `createCors({methods:['GET','PATCH'],…})` → `cspHeaders('api-json')` → `csrf` → `requireAuth` → `userRateLimiter(RL_ROOMS)` → routes; `app.onError` CSP stamp; default export `{ fetch, queue }` + `UsersRpc`. |
| `src/handlers/rooms.ts` | `GET /rooms` (D1 Sessions read, `x-d1-bookmark`, `isOwner` derived) + `PATCH /rooms/:id/permission` (→ cross-script `rooms` DO `setPermission`; 403 on non-owner). |
| `src/queue.ts` | `consume` — both queues (`switch(batch.queue)`); `safeParse` → ack-drop poison; coalesce + idempotent upsert (visits `max()`, meta LWW / first-write-wins). |
| `src/rpc.ts` | `UsersRpc extends WorkerEntrypoint` — `linkAccount` OAuth-deferred stub. |
| `src/env.ts` | `UsersEnv = { Bindings: Env; Variables: { userId: UserId } }`, threaded through every handler (Hono `Context` is invariant in `Variables`). |
| `src/zod/permission.ts` | `permissionParam`/`permissionBody` validators for the PATCH route. |
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
6. Add a dev port to `scripts/dev-ports.json` (heed the `_comment`: `PORT_OFFSET` is already `10`; keep it ≥ the port-span).
7. Add `dev:<name>` to root `package.json` and to the `dev` concurrently chain.
8. Add the typecheck workspace to the root `typecheck` and `typecheck:tsc` scripts.
9. Add a `deploy:<name>` script to root `package.json`.
10. Add a row to the Worker Inventory table above.

For inter-worker calls (none today), use `WorkerEntrypoint` + `[[services]] entrypoint` — binary RPC via service bindings, not public-internet `fetch()` or `hc<App>` over a service-binding fetcher. The two are different layers; don't conflate.

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
- **The DO is the authority.** Room permission/ownership decisions read the room DO (never D1); `setPermission` is owner-only and re-pushes/evicts live connections. D1 is a display projection only; producers tie payloads to the event schemas (`satisfies z.input<…>`), the consumer `safeParse`s + upserts idempotently.
- **CSP is middleware, not per-handler.** `cspHeaders(profile)` (worker-shared) stamps the profile on egress, so every returned response — auth `/me`, users `/rooms` + PATCH, the `requireAuth` 401, images' 304/404 — carries it with nothing to forget. `applyCsp` remains for hand-built `Headers` + the `onError` path (csrf's thrown 403).
- **CORS is per-worker.** `createCors({ methods, allowHeaders?, exposeHeaders? })` advertises only what each worker serves (auth `GET`; users `GET`+`PATCH` + `x-d1-bookmark`; images `GET`+`PUT` + range/etag/accept-ranges; unfurl `GET`). The shared `isAllowedOrigin`/`isDevHost` predicate reflects the origin allowlist and gates `http://localhost:*` to dev (by request `Host`), so prod never reflects a localhost origin against the credentialed `.avlo.io` cookie.
- **CSRF on mutating routes.** `hono/csrf` guards users `PATCH` + images `PUT`, reusing the CORS origin allowlist (one source of truth). It engages only on form content-types — `application/json` and binary uploads bypass, so `hc` traffic is unaffected — and never on GET/HEAD; service-binding RPC bypasses HTTP middleware entirely. **Tripwire:** revisit csrf coverage and the `SameSite=Lax` cookie if the session goes `SameSite=None`/OAuth, or any subdomain begins serving first-party HTML.

## Dev Orchestration

Single source of truth for base ports: `scripts/dev-ports.json`. `scripts/dev-worker.mjs` reads it + applies `PORT_OFFSET`. Vite imports the same JSON for proxy targets.

```bash
npm run dev                                # all six (Vite + main + images + unfurl + auth + users)
PORT_OFFSET=10 VITE_PORT=5180 npm run dev   # parallel session (dev:p alias)
npm run dev:images                         # single worker, useful with separate Vite
(cd workers/<name> && npm run types)       # regenerate worker-configuration.d.ts
```

**`PORT_OFFSET` is `10`** (in `dev-ports.json`'s `_comment` + the `dev:p` alias). Base ports span 8787…8793, so the offset must stay ≥ 7; 10 leaves headroom and keeps inspector ports (base+1000+offset) collision-free. `dev:p` also uses `VITE_PORT=5180` (3001 is reserved on some WSL2/Windows hosts).

**Shared Miniflare state.** `dev-worker.mjs` passes `--persist-to=<repoRoot>/.wrangler/state` (absolute) to every `wrangler dev`. Without this, wrangler v4 resolves the default `.wrangler/` *relative to the config file's directory*, so each `workers/<name>/.wrangler/state/v3/r2/avlo-assets/` becomes a separate physical bucket — unfurl writes an OG image, the images worker's bucket stays empty, and the browser's GET 404s in dev. The path must be absolute (relative paths re-resolve against the config dir in some wrangler versions). Sharing requires *both* a shared persist root *and* matching `bucket_name` in every config — `r2_buckets[].bucket_name = "avlo-assets"` is identical in `workers/{images,unfurl}/wrangler.jsonc`. Same constraint applies if KV (`id`), D1 (`database_id`), DOs, or Queues are ever shared across workers. `.wrangler/` is gitignored at the repo root.

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
