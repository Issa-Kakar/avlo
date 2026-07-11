# Testing

Framework scaffolding. Suites grow gradually; this doc is the **precedent** — follow it so the codebase stays consistent. Each harness ships with one deletable smoke test proving the wiring.

## Harnesses

| Harness | Runs | File pattern | Location | Command |
|---|---|---|---|---|
| **Vitest — node** | pure logic (Node env) | `*.test.ts` | colocated next to source | `pnpm test` |
| **Vitest — pool-workers** | a worker inside workerd (Miniflare) | `*.test.ts` | `workers/<name>/test/` | `pnpm test` |
| **Playwright** | the canvas app in a real browser | `*.spec.ts` | `e2e/` | `pnpm test:e2e` |
| **pytest** | the `.py` toolchain (plain CPython) | `test_*.py` | `packages/py-build/tests/` | `pnpm test:py` |

`.test.ts` (vitest) vs `.spec.ts`-in-`e2e/` (playwright) is the rule that keeps the two TS runners from glob-colliding. Don't cross them.

```
pnpm test          # turbo run test — every package's vitest suite (node + pool-workers), cached
pnpm test:watch    # root vitest — all vitest projects in one watch/UI process
pnpm test:e2e      # playwright — needs `pnpm exec playwright install chromium` once
pnpm test:py       # uv run pytest (in packages/py-build) — needs `uv sync` there once
```

**CI** does not gate on tests yet (kept frictionless during pre-prod iteration). Wire `pnpm test` into `.github/workflows/ci.yml` once there are real suites that catch regressions.

## Vitest (node + pool-workers)

Orchestration: each package owns its `vitest.config.ts` (the source of truth, run by `turbo run test` for per-package caching). The root `vitest.config.ts` is a thin aggregator (`test.projects` config-globs) so `pnpm test:watch` runs everything as one process.

**Add tests to a package**: drop a `vitest.config.ts` + a `"test": "vitest run"` script. The root globs (`packages/*/vitest.config.ts`, `workers/*/vitest.config.ts`) pick it up automatically — nothing to register.

- **Node logic** — see `packages/py-loader/` (config + `src/verify.test.ts`). `environment: 'node'`, explicit `import { describe, it, expect } from 'vitest'` (no globals), colocated tests.
- **Pool-workers** — see `workers/py/` (config + `test/index.test.ts` + `test/tsconfig.json`). The `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })` plugin sources bindings/compat from the real wrangler config. Tests import from `cloudflare:test`. The `test/tsconfig.json` exists for editor types only and is **outside** the worker's `src/**` typecheck glob, so test-only types never enter the production typecheck.
  - **Workers with bindings** (sync/users/images/unfurl/auth → DO, queues, service bindings): same shape, but add the bound workers as **auxiliary workers** under `cloudflareTest({ miniflare: { workers: [...] } })` so they run in the same workerd process.
- **Version pin**: `vitest` and `@cloudflare/vitest-pool-workers` are peer-locked (pool-workers pins `vitest ^4.1.0`; keep it exact — its config API churns). Both live in root `devDependencies`.

**Gotcha — web tests**: none exist yet. When they do, add a dedicated `web/vitest.config.ts` (`environment: 'node'` or `jsdom`) so vitest never auto-loads `web/vite.config.ts` (its Cloudflare/TanStack plugins don't belong in the test env). `@avlo/*` imports resolve natively via pnpm workspace exports; `@/*` needs an alias (`vite-tsconfig-paths` or a one-line `resolve.alias`) — only for web tests.

## Playwright

Root `playwright.config.ts` (`testDir: e2e/`) auto-starts a transient `pnpm dev:web` (vite; the dev-only `window.__avlo` bridge is present only in dev mode) and honors `BASE_URL` / `VITE_PORT` for the parallel worktree. `e2e/fixtures.ts` seeds a synthetic identity into `localStorage` so `/room/:id` loads worker-free — ported from `scripts/verify/browser.mjs`, which stays as-is (this is additive). Drive the canvas through `window.__avlo` (see `web/src/dev/test-bridge.ts`); type it via `e2e/env.d.ts`.

Note `reuseExistingServer` reuses whatever is already on the port — if a non-dev build occupies it, the bridge won't be present. Run on a clean port (or a fresh dev server) when in doubt.

## pytest + uv

`packages/py-build/pyproject.toml` (the toolchain's own non-package project, py3.13) defines a minimal uv dev env — **just `pytest`**. `pnpm test:py` runs `uv run --directory packages/py-build pytest`; setup is `uv sync` inside `packages/py-build` once. Tests live in `packages/py-build/tests/test_*.py`; `pythonpath = ["scripts"]` makes the toolchain scripts importable (`import packlib`). The **repo root carries no Python project** — avlo is a TS monorepo, so Python is scoped to this one subpackage.

- **Worktree dedup** is automatic: uv's global content-addressed cache (`~/.cache/uv`) is shared across worktrees and hardlinks/clones into each `.venv` — heavy wheels download once. **Do not override `cache-dir`** (that breaks the sharing).
- **Ad-hoc numpy/fonttools** (rare — font subsetting, pixel-level render debugging) are NOT committed deps. `scripts/subset-*.py` self-declare fonttools via PEP 723 inline metadata, so `uv run scripts/subset-museomoderno.py` just works (cache-backed, no venv); a one-off numpy session is `uv run --with numpy python`.
- **Boundary — do not cross**: the determinism-critical reproducible pack path (`packages/py-build`'s docker build + its mpl-font subset) is **independent** of this dev env. The subset runs fontTools at the exact `hostTools.fonttools` pin via an isolated `uvx --from fonttools==<pin>` call (byte-repro unaffected — the pin, not the installer, fixes the bytes); repro / byte-identical assertions run under system `python3.13`, never through the dev env.
- Scope: pytest runs **plain CPython** against the `.py` toolchain logic. Running code *inside* Pyodide (pytest-pyodide) is a future extension, not this setup.
