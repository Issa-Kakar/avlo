# @avlo/worker-shared

Server-only shared primitives for Cloudflare Workers. Uses ambient types (`R2Bucket`, `HTMLRewriter`, `caches.default`, `crypto.subtle`). **Never import from any client-side bundle.**

The package publishes TS source directly via `exports` (no dist build). Consumers (`workers/*`) resolve via the `@avlo/worker-shared` workspace dep + path mapping in their `tsconfig.json`. Client `tsconfig.json` and `tsconfig.sw.json` deliberately omit this path — accidental imports fail at typecheck.

## Files

| File | Exports |
|---|---|
| `src/index.ts` | Barrel re-export (only entry — no subpath exports declared) |
| `src/cors.ts` | `createCors({ methods, allowHeaders?, exposeHeaders? })` — per-worker Hono CORS factory; each worker advertises only the verbs + headers it serves (`OPTIONS` auto-appended). `isAllowedOrigin(origin, isDev)` + `isDevHost(host)` — the shared origin allow-list (prod `avlo.io`/`www.avlo.io`; `localhost:*` only when the request `Host` is dev), reused by the `hono/csrf` guard so origin policy is single-sourced. |
| `src/csp.ts` | `cspHeaders(profile)` — egress middleware stamping the profile on every returned response (H5; register early/route-scoped). `cspError(profile)` — `app.onError` companion that stamps thrown responses (csrf's 403) + unexpected 500s while preserving Hono's error log. `applyCsp(headers, profile)` — the underlying per-`Headers` factory (used by both + hand-built `Headers`). `CspProfile` (`'asset-body'` | `'api-json'`). **SPA HTTP headers are not set by a worker** — they live in `client/public/_headers` since `run_worker_first: ["/parties/*"]` means main never sees HTML responses. |
| `src/ssrf.ts` | `isPrivateHost(hostname)` — blocks `localhost`, `[::1]`, `.local`, `.internal`, 127/10/172.16-31/192.168/169.254/0.x. Used in Zod `.refine`. |
| `src/cache-keys.ts` | `syntheticCacheUrl(service, key)` — namespaces synthetic edge-cache keys by service. `caches.default` keys on full URL; real URLs include host but synthetic keys are bare and easy to collide cross-service. |
| `src/surface-drift.ts` | `assertSurfaceMatch<Real, Mock>(true)` — Hono route-surface drift guard for the `app-type.ts` pattern (see `workers/CLAUDE.md` → App-Type Pattern). `assertRpcMatch<Impl, Surface>(true)` — the binary-RPC companion: each class implementing an `rpc-surfaces.ts` cast target asserts mutual assignability next to its definition (`workers/main/src/room.ts`, `workers/auth/src/rpc.ts`). |
| `src/cookies.ts` | `verifyAnonToken` (raw HMAC verify + `AnonToken` parse — the RPC path, no Hono ctx), `mintAnonToken`, `cookieOpts` (dev/prod cookie attrs), `ANON_COOKIE`, `AuthCtx`. Schema lives in `zod/anon-token.ts`. |
| `src/require-auth.ts` | `requireAuth<E>()` — generic Hono gate; verifies the session via the `AUTH` service RPC into `c.get('userId')` (401 if absent). Called with an explicit env arg per worker. |
| `src/rate-limit.ts` | `userRateLimiter<E>(binding)` — tier-1 `cloudflareRateLimiter` keyed on `c.get('userId')`. |
| `src/rpc-surfaces.ts` | `AuthRpcSurface` / `RoomDoStub` — cross-config RPC cast targets (the `AUTH` service + cross-script `rooms` DO are untyped across wrangler configs) — plus `roomDoStub(rooms, roomId)`, the ONE cast site for the DO binding (stub + RPC argument derive from the same validated id). `RoomDoStub.setPermission`/`setTitle` take `roomId` first (the DO proves it against `ctx.id` — partyserver's `this.name` is unresolvable on a cold raw-RPC wake), return the post-mutation `MetaEvent` snapshot for the users worker's direct rev-guarded D1 write + bookmark, and throw `forbidden`/`invalid-title`/`room-mismatch` as the wire error contract. Not convention-typed anymore: `assertRpcMatch` guards at both implementing classes fail typecheck on drift. |
| `src/zod/anon-token.ts` | `AnonToken` — post-HMAC `avlo_anon` cookie payload `{ userId, iat, nonce }`. `safeParse`d by `cookies.ts` (mint + verify), not a `zValidator`. |
| `src/zod/asset-key.ts` | `assetKeyParam` — `{ key: regex(/^[0-9a-f]{64}$/) }`. Canonical lowercase hex, no uppercase. |
| `src/zod/content-length.ts` | `contentLengthBound(max)` + `MAX_UPLOAD_BYTES = 10MB`. Hono `header` validator that rejects oversize requests BEFORE the body is awaited (H2). |
| `src/zod/room-event.ts` | `VisitEvent` / `MetaEvent` — branded-on-parse queue event schemas (§6). `safeParse`d by the `users` queue consumer so a poison body acks to DLQ. |
| `src/zod/url-param.ts` | `unfurlQuery` — `{ url: normalizeUrl + isPrivateHost refine }`. SSRF guard runs inside Zod (H9). |

## Invariants

- **Barrel-only exports.** No subpath exports in `package.json`. Every consumer imports from `@avlo/worker-shared`. Keeps the public surface flat and the package.json minimal.
- **`zod/` is the home for every schema.** All `zod/v4` schemas live in `src/zod/` — request validators (`assetKeyParam`, `contentLengthBound`, `unfurlQuery`) AND parse/`safeParse` data schemas (`AnonToken` for the signed cookie, `VisitEvent`/`MetaEvent` for the queue). The modules that *use* them (`cookies.ts`, the queue consumer) import from `./zod/*`. Keeps every schema greppable in one place. The `app-type.ts` mocks are the one exception — their inline schemas stay inline (ambient-free isolation; a mock must not import worker-shared).
- **`responses.ts` is intentionally absent.** Earlier drafts had `jsonErr`/`notFound` helpers; they were never used. Most workers want raw `new Response(...)` for full header control. Reintroduce only if there's a real call site.
