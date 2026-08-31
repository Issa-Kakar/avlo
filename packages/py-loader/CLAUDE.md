# @avlo/py-loader

The committed **build-lock** for the Python runtime: `build-lock.json` +
a typed, deep-frozen `BUILD_LOCK` export. This is the atomic app↔artifact
coupling — there is NO boot-time manifest fetch. Consumers verify against
the lock at every trust boundary: the supervisor (bundle tars + the glue
trio), the SW's verify-at-fill py routes (everything they cache), and the
executor (stdlib zip hashed AS MOUNTED vs the lock sha it receives on
`boot-prep`). The Cache API / SW cache is keyed `avlo-py-<buildHash>` — the SW
imports the `PY_BUILD_HASH` constant, the supervisor derives the identical
string from `BUILD_LOCK.buildHash`.

**Resolution is alias-based, not node-resolution-based.** `main`/`types` point
at raw TypeScript (`src/index.ts`), so every consumer bundles or type-strips.
The wiring lives in `web/vite.config.ts` (alias), `web/tsconfig.json` +
`web/tsconfig.sw.json` (paths), and `web/package.json` (`workspace:*`).
py-build's toolchain skips the package entirely and reads `build-lock.json`
as plain JSON (`avlo-build stage` writes it, `avlo-build publish` reads it);
the web py-integration suite consumes the typed `BUILD_LOCK` export.

**Name collision note:** `@avlo/py-loader` (this package — the committed lock)
is UNRELATED to `web/src/core/py/py-loader.ts` (the fork `bootPyodide` boot
wrapper). They just share a name.

## Files

| File | Role |
|---|---|
| `build-lock.json` | GENERATED — only py-build's `avlo-build stage` writes it (byte-gated by `avlo-build stage --check`; excluded from biome so the formatter can't break the compare). `{ schema, buildHash, artifacts: {name:{sha256,size}}, bundles, sets }`. `artifacts` = the glue trio (`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`) + `python_stdlib.zip`; `bundles` = the 7 package tars; `sets` has 4 keys (`stdlib` is the implicit fifth `PySetKey` — it resolves to zero bundles client-side). Snapshots are NOT lock artifacts today — client-captured, OPFS-only (shipping build-time-captured snapshots as lock artifacts is an open direction; see py-build NOTES) |
| `src/index.ts` | `BUILD_LOCK` (typed + deep-frozen at module scope) + `PY_BUILD_HASH`; re-exports `verify.ts` |
| `src/verify.ts` | `sha256Hex` + `matchesLockEntry(bytes, {sha256,size})` — THE verification predicate for every lock-gated consumer: supervisor tar/glue checks, SW verify-at-fill routes, the web py-integration suite, and the executor (`sha256Hex` for the as-mounted stdlib hash). Dependency-free. The `./verify` subpath exists so lock-free consumers get the exact shipped code without index's JSON import (Node ESM demands import attributes there); its one consumer is `py-executor.ts`, which must not carry the lock JSON |
| `src/verify.test.ts` | vitest, 2 cases — a `sha256Hex` known-answer vector (empty input) and the `matchesLockEntry` size-then-sha gate |
| `package.json` | private, `type: module`, `sideEffects: false`, dual `exports` (`.` + `./verify`), `main`/`types` → raw TS. Scripts: `typecheck` (tsgo), `typecheck:tsc`, `test` (vitest run) |
| `tsconfig.json` | extends the root base; `lib: [ESNext, DOM, WebWorker]`; explicitly `include`s `build-lock.json` so the JSON import typechecks |
| `vitest.config.ts` | project `py-loader`, node env, `src/**/*.test.ts`. The reference config for the vitest node harness (see root `TESTING.md`); Turbo + the root `projects` glob pick it up with no registration |

## Invariants

- **Regeneration rule:** restage ⇒ new `buildHash` ⇒ reseed R2 + commit the
  lock. Seeding is `pnpm py:seed` from the root (local miniflare tree); the
  remote publish is `pnpm --filter @avlo/py-build publish:r2` — there is no
  root-level alias for it. The
  worker serves keys under `<buildHash>/…`, so a stale lock simply 404s —
  fail-visible, never fail-wrong.
- **Pure JSON + types** — no runtime deps, no ambient worker types; safe in
  the SW bundle (CI isolation grep unaffected) and in dedicated workers.
- `buildHash` = 16-hex truncated sha256 of the canonical (recursively
  key-sorted) `{artifacts, bundles, sets}` slim tables — deterministic for
  identical artifact bytes. It doubles as the **snapshot lock binding**:
  per-set OPFS snapshot headers embed it (`py-snapshot.ts` parse chain), so
  an image captured under one lock can never restore under another — and a
  rotated hash auto-invalidates every client's held state (OPFS snapshot dir
  GC + Cache API generation eviction).
