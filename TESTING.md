# Testing

Framework scaffolding. Suites grow gradually; this doc is the **precedent** — follow it so the codebase stays consistent. Each harness ships with one deletable smoke test proving the wiring.

## Harnesses

| Harness | Runs | File pattern | Location | Command |
|---|---|---|---|---|
| **Vitest — node** | pure logic (Node env) | `*.test.ts` | colocated next to source | `pnpm test` |
| **Vitest — pool-workers** | a worker inside workerd (Miniflare) | `*.test.ts` | `workers/<name>/test/` | `pnpm test` |
| **Vitest — integration** | four workers cross-wired in one Miniflare (wrangler `createTestHarness`, Node env) | `*.test.ts` | `workers/integration/test/` | `pnpm test` |
| **Playwright** | the canvas app in a real browser | `*.spec.ts` | `e2e/` | `pnpm test:e2e` |
| **pytest** | the `.py` toolchain (plain CPython) | `test_*.py` | `packages/py-build/tests/` | `pnpm test:py` |

`.test.ts` (vitest) vs `.spec.ts`-in-`e2e/` (playwright) is the rule that keeps the two TS runners from glob-colliding. Don't cross them.

```
pnpm test          # turbo run test — every package's vitest suite (node + pool-workers), cached
pnpm test:watch    # root vitest — all vitest projects in one watch/UI process
pnpm test:e2e      # playwright — needs `pnpm exec playwright install chromium` once
pnpm test:py       # uv run pytest (in packages/py-build) — needs `uv sync` there once
```

**CI** gates on `pnpm test` (after typecheck, before the web build) — the worker suites are real and have already caught production bugs (see the suite standard below).

## Vitest (node + pool-workers)

Orchestration: each package owns its `vitest.config.ts` (the source of truth, run by `turbo run test` for per-package caching). The root `vitest.config.ts` is a thin aggregator (`test.projects` config-globs) so `pnpm test:watch` runs everything as one process.

**Add tests to a package**: drop a `vitest.config.ts` + a `"test": "vitest run"` script. The root globs (`packages/*/vitest.config.ts`, `workers/*/vitest.config.ts`) pick it up automatically — nothing to register.

- **Node logic** — see `packages/py-loader/` and `packages/shared/` (`environment: 'node'`, explicit `import { describe, it, expect } from 'vitest'` — no globals, colocated `src/**/*.test.ts`). Colocated node tests ride the package's production typecheck (they're plain TS) — that's the precedent.
- **Pool-workers** — see `workers/py/` (the minimal exemplar) and the real suites below. `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })` sources bindings/compat from the real wrangler config; tests import from `cloudflare:test`. The `test/tsconfig.json` exists for editor types only and is **outside** the worker's `src/**` typecheck glob. `packages/worker-shared` shows the no-wrangler variant (inline `miniflare: { compatibilityDate, compatibilityFlags }`).
- **Version pin**: `vitest` and `@cloudflare/vitest-pool-workers` are peer-locked (pool-workers pins `vitest ^4.1.0`; keep it exact — its config API churns). Both live in root `devDependencies`.

**Gotcha — web tests**: none exist yet. When they do, add a dedicated `web/vitest.config.ts` (`environment: 'node'` or `jsdom`) so vitest never auto-loads `web/vite.config.ts` (its Cloudflare/TanStack plugins don't belong in the test env). `@avlo/*` imports resolve natively via pnpm workspace exports; `@/*` needs an alias (`vite-tsconfig-paths` or a one-line `resolve.alias`) — only for web tests.

## Worker suites — the standard

Every worker (except `main`, which has no script) plus `packages/{shared,worker-shared}` carries a real suite: **sync** (WS upgrade guard, connect flow, meta RPCs + live permission enforcement, real hibernation via `evictDurableObject`, R2 persistence + z-renorm, the tier-3 rate limiter), **auth** (/me identity, OAuth login/callback trust pipeline against real RS256 tokens incl. a full PKCE roundtrip, logout, `AuthRpc`), **unfurl** (validation, per-hop SSRF, page/extraction/image handling, edge cache), **images** (upload guard matrix, GET/Range/cache, avatars, `ImagesRpc.ingestAvatar`), **users** (rooms list projection, cross-worker PATCH→DO seam, all three queue consumers, `UsersRpc` promote/adopt/migration) — plus per-worker `hardening.test.ts` files pinning H5 (CSP profile on every returned response, incl. thrown-403 and 429 paths) and the tier-1 user rate limiters at their exact numeric boundary. Cross-worker contracts live in **`workers/integration`** (see below). Style: one behavior per test, names state behavior AND mechanism; `describe` files named by concern (`upload.test.ts`, `oauth-callback.test.ts`), never by source file; **unique ids per test** (rooms/users/bytes) — never rely on cleanup ordering; `reset()` from `cloudflare:test` only where rate-limit buckets or cross-test binding state genuinely need wiping.

**Shared plumbing — `@avlo/test-support`** (`workers/test-support/`, a real workspace package: consumers declare the devDep and import `@avlo/test-support/<module>`; it may carry its own deps — today `esbuild` + `msw`):
- `aux-build.ts` — Node-side esbuild bundler for REAL aux workers (entry → single ESM, `.sql` as text), invoked from vitest configs; output in `.build/` (gitignored) with a metafile freshness check, so config reloads skip the rebuild. Also exports `TEST_COMPAT_DATE` (read from sync's wrangler.jsonc) and `TEST_AUTH_BINDINGS` (the auth worker's full test secret/var set).
- `msw.ts` — `installMswServer()`: the outbound-HTTP mock (see below) + re-exported `http`/`HttpResponse`.
- `stub-auth.mjs` — transparent `AuthRpc` stub: `avlo-test-user=<id>[:anon]` cookie → identity. Used by images/unfurl/users.
- `stub-users-images.mjs` — recording `UsersRpc`/`ImagesRpc` doubles with an RPC control surface (`_reset`/`_calls`/`_set`). Used by auth.
- `cookies.ts` — mint real hono-format signed cookies (WebCrypto only).
- `image-bytes.ts` — minimal VALID image byte builders (real magic bytes + parseable dims) + `uniqueGif()`/`uniquePng()` allocators (counter+random-tag bytes ⇒ unique sha256 keys ⇒ no cross-test R2/cache collisions).
- `csp.ts` — `expectCspProfile(res, profile)`: the H5 oracle; header literals deliberately duplicated from `worker-shared/csp` so a profile edit must consciously touch both sides.
- `until.ts` / `unique.ts` — the ONLY waiting primitive (poll, named timeout — never a bare sleep) and per-test URL/id allocators.

**Outbound HTTP mocking — MSW in the isolate.** pool-workers 0.13 removed `cloudflare:test`'s `fetchMock` and Cloudflare recommends MSW as the replacement (`fixtures/vitest-pool-workers-examples/request-mocking`): worker code runs in the SAME isolate as the tests, so `setupServer` from `msw/node` patches the `globalThis.fetch` every egress call rides. `installMswServer()` wires the lifecycle (listen with `onUnhandledRequest: 'error'`, per-test `resetHandlers`, close) and returns `{ server, requested }`:
- Per-test handlers via `server.use(http.get(url, resolver, { once: true }))`. **Redirect/hop chains for one URL go in ONE `use()` call in hop order** (handlers resolve in array order; a used-up `once` handler falls through; a later `use()` call would take precedence and reverse the order).
- A stray fetch can never pass silently (unhandled → rejected fetch + MSW error), and neither can a dead mock: afterEach fails the test if a `once` handler was armed but never matched. A route you want to prove is NOT fetched stays un-armed and is asserted via `requested(substr)`.
- Thrown resolvers become 500s in MSW — model a network failure with `HttpResponse.error()`.

**Aux-worker strategy**: sync runs the REAL auth worker (full cookie→verify→stamp fidelity at the WS seam); users runs the REAL sync worker (cross-script `AvloDO` — the cross-worker permission seam); everything else uses the stubs. Secrets/vars are injected via `miniflare.bindings` in each vitest config (`TEST_AUTH_BINDINGS` wherever real auth code runs) — **never** read from `.dev.vars` (the pool folds `.dev.vars` over wrangler `vars`, so pin every var the tests observe).

**Policies** (set once, apply everywhere):
- **`fileParallelism` stays at the default (parallel).** Serialize a suite ONLY while it uses a Miniflare-global API (`reset()`, `abortAllDurableObjects`) — today none does: rate-limit tests key on per-test unique identities/IPs instead of refilling buckets, and every state assertion is scoped to the test's own keys. Targeted `evictDurableObject(stub)` replaces global aborts.
- **`CHARACTERIZED:` name prefix** marks a test that pins CURRENT behavior (with a comment saying why it's accepted) rather than a designed contract — changing it should be a deliberate act, not a test fix.
- **Property-based tests (fast-check)** ride beside the examples wherever a contract is algebraic: `isPrivateHost` vs an independent CIDR reference + trailing-dot/case/mapped-IPv6 invariance, cookie tamper-rejection, normalization idempotence (`normalizeRoomTitle`), regex boundaries (identifiers), parser totality + builder↔parser roundtrips (image dims). Cap `numRuns` on WebCrypto-per-case properties; default elsewhere. The first pass found a real hole (`isDevHost` prefix-matching `localhost:3000.evil.com`) — properties earn their keep.
- **Caching is correct, not disabled.** `turbo run test` caches; invalidation is the dependency graph (`test` `dependsOn: ["^typecheck"]` folds every workspace dep's hash in) plus explicit `$TURBO_ROOT$` inputs for the cross-worker reads (sync#test → auth src; users#test → sync src+drizzle; integration#test → all four workers). Adding a new cross-package read to a suite means adding its glob to that task's `inputs` in root `turbo.json`.

**Hard-won pool-workers (0.20.x) facts** — the difference between an afternoon and a week:
- Aux workers need `modules: [{ type: 'ESModule', path }]` + `modulesRoot: dirname(path)`. Letting miniflare scan a bundle trips on dynamic `import(expr)` (hono's logger), and a cwd-relative module name (`../…`) is rejected by workerd with an opaque `internal error`.
- Client-side WS binary messages arrive as **Blob** in pool suites — set `ws.binaryType = 'arraybuffer'` before decoding (sync harness does). The integration harness's Node-side sockets deliver ArrayBuffer already (no `binaryType` property).
- Service-binding fetches synthesize NO `Host` and NO `Content-Length` header — set both explicitly when a guard reads them (`isDevHost`, `contentLengthBound`).
- Rejected WS upgrades surface as **404**, not the guard's 403/400 — hono-party swallows non-WebSocket responses and falls through to Hono's notFound.
- `wrangler.jsonc` `ratelimits` DO materialize as enforcing bindings. Since miniflare 5.20260801.0-alpha the counters are per-period and storage-backed (they survive DO eviction, matching prod), so exact-boundary assertions like "the 121st request 429s" hold; `reset()` still clears them along with every other binding.
- Queue producer sends **auto-deliver** to same-config consumers — and a pending batch window at pool teardown can deadlock it. The users suite strips consumers (`queueConsumers: []`) and drives consumption deterministically via `createMessageBatch` + `worker.queue` + `getQueueResult`.
- A rejected cross-script DO RPC (`forbidden` wire errors) leaves a duplicate pipelined-promise rejection: use `try/catch`+message assert instead of `expect(...).rejects`, and don't throw real wire errors across the boundary from inside a queue-handler context (simulate that one verdict — see `users/test/queue.test.ts`; the REAL queue-path verdict is pinned in `workers/integration`, where no pool teardown is in play). Relatedly, the users suite may LOG `EnvironmentTeardownError: Closing rpc while "resolve" was pending` at teardown — cosmetic (the run still exits green); a HANG at teardown is the real wedge signature.
- Real hibernation is testable: `evictDurableObject(stub)` tears the instance down while hibernatable sockets survive; the next frame re-runs the constructor and lands in `webSocketMessage`. Eviction politely drains a pending y-partyserver save debounce (~5 s) — budget the test timeout (the suite uses explicit 20 s timeouts on every evict test).
- D1: `readD1Migrations` is exported from the pool's MAIN entry (not `/config`); inject the array via `miniflare.bindings` and `applyD1Migrations` in a `setupFiles` hook (`workers/users/test/apply-migrations.ts`).
- OAuth against real crypto: STATIC checked-in RSA test keys (`workers/auth/test/test-keys.ts` — deterministic, no per-file keygen) signed via jose `importPKCS8`; the JWKS is a constant served by a persistent MSW handler, and the token-endpoint mock VERIFIES the exchange request (grant/code/redirect_uri/PKCE S256) instead of blindly returning a token.

## Integration suite (`workers/integration`)

Wrangler's `createTestHarness` (4.119+) boots sync (PRIMARY) + auth + users + images from their REAL `wrangler.jsonc` files into ONE merged Miniflare — service bindings, the cross-script `rooms` DO, and the queue broker wire up by wrangler `name`, exactly like the dev orchestrator. Tests run in plain Node: `getWorker(name).fetch` (incl. real WS upgrades), `getEnv()` binding proxies (D1 reads, queue sends), `getDurableObjectStorage(...).exec` (DO-SQLite truth), `getLogs()` (the queue heartbeat as a delivery marker). No `reset()` — unique ids per test; `applyD1Migrations('DB')` in beforeAll. One harness per FILE (~3 s boot); the suite budget is dominated by real queue batch windows (1 s visits/meta, 5 s migrate) — `testTimeout: 60000` in the config, whole suite ~13 s.

What lives here (and ONLY here): contracts that span the seams the pool suites must stub — the visit pipeline (WS connect → DO mint → real queue delivery → D1 projection → `GET /rooms`), PATCH→DO→RYW-D1 with the DO storage read as the authority check, and the real DO-thrown `forbidden` inside a queue consumer. `createTestHarness` is a new API — re-verify this suite first after any wrangler bump.

## Testability friction — deferred prod refactors

Noted during test passes, deliberately NOT done in them; pick up when the module is next open:
- `sync/room.ts`: a read-only `getMeta()` on `RoomDoRpc` would retire the last white-box cast (`readMeta` in sync's harness — `rev`/`createdAt`/`deletedAt` have no wire observable) AND the users suite's two mutation-as-getter sites that lean on `migrateOwner`'s idempotent branch.
- `sync/room.ts`: the SYNC/AWARE/WINDOW rate budgets are module constants; reading them from env (prod defaults) would let limiter tests flood the real wire with a tiny budget and delete the white-box `instance.onMessage` drive plus the test-side mirrored constant. Cheapest useful step: export the constants.
- `auth/handlers/callback.ts`: the session token is minted internally and never escapes on the fail-closed path, so the "no KV record written" oracle is a scoped prefix-diff, not an exact-key probe; an injectable token source would pin the exact key.
- auth→users/images is the one RPC seam exercised only against recording stubs (auth's pool suite); users→auth runs real in the integration harness. A full OAuth callback against real users/images would need Google egress mocking inside the harness — revisit if the seam grows.
- wrangler's generated runtime types omit `FetcherQueueResult` (`getQueueResult` arrives `any` under skipLibCheck) and leave cross-script DO bindings untyped — the users harness carries typed views (`QueueResultLedger`, `roomsNs`); recheck after each `wrangler types` regen.

## Playwright

Root `playwright.config.ts` (`testDir: e2e/`) auto-starts a transient `pnpm dev:web` (vite; the dev-only `window.__avlo` bridge is present only in dev mode) and honors `BASE_URL` / `VITE_PORT` for the parallel worktree. `e2e/fixtures.ts` seeds a synthetic identity into `localStorage` so `/room/:id` loads worker-free — ported from `scripts/verify/browser.mjs`, which stays as-is (this is additive). Drive the canvas through `window.__avlo` (see `web/src/dev/test-bridge.ts`); type it via `e2e/env.d.ts`.

Note `reuseExistingServer` reuses whatever is already on the port — if a non-dev build occupies it, the bridge won't be present. Run on a clean port (or a fresh dev server) when in doubt.

## pytest + uv

The repo root is a **uv workspace** (virtual root `pyproject.toml` + one committed root `uv.lock`); the only member is `packages/py-build` — a real src-layout package (`avlo-py-build`, py3.14) exposing the `avlo-build` toolchain CLI, with `pytest` in its dev group. `pnpm test:py` runs `uv run --directory packages/py-build pytest`; `uv sync` at the root (or any first `uv run`) sets up the shared `.venv/`. Tests live in `packages/py-build/tests/test_*.py` and import the package (`from avlo_py_build import packlib`).

- **Worktree dedup** is automatic: uv's global content-addressed cache (`~/.cache/uv`) is shared across worktrees and hardlinks/clones into each `.venv` — heavy wheels download once. **Do not override `cache-dir`** (that breaks the sharing).
- **Ad-hoc numpy** (rare — pixel-level render debugging) is NOT a committed dep: a one-off session is `uv run --with numpy python`. PEP 723 inline-metadata scripts (`uv run <script>.py`) remain the pattern for one-off tooling.
- **Determinism boundary (moved into the lock, still a boundary)**: the mpl-font subset runs fontTools **from the workspace env** at exactly the `hostTools.fonttools` pin — `packages/py-build/pyproject.toml` pins `fonttools==<pin>` and both `avlo-build config check` and the packer assert installed == config pin. The pin (not the installer) fixes the subset bytes. Artifact **pycs** never compile in the dev-env process at all: they compile in py-build's hermetic `_pyc_worker.py` subprocesses (frozen import surface — pyc bytes depend on the compiling process's import history; see py-build NOTES learnings).
- Scope: pytest runs **plain CPython** against the toolchain package (packlib writers, config model, wasmmeta). Running code *inside* Pyodide (pytest-pyodide) arrives with the test-replatform phase (`toolchain-replatform-plan.md` §2.7), not this setup.
