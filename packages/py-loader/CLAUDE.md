# @avlo/py-loader

The committed **build-lock** for the Python runtime: `build-lock.json` +
a typed, deep-frozen `BUILD_LOCK` export. This is the atomic app↔artifact
coupling — the supervisor sha256-verifies every fetched artifact against the
lock (there is NO boot-time manifest fetch), and the Cache API / SW cache is
keyed `avlo-py-<PY_BUILD_HASH>`.

**Name collision note:** `@avlo/py-loader` (this package — the committed lock)
is UNRELATED to `web/src/core/py/py-loader.ts` (the fork `loadPyodide` boot
wrapper). They just share a name.

## Files

| File | Role |
|---|---|
| `build-lock.json` | GENERATED — only py-build's `stage.mjs` writes it (byte-gated by `stage --check`; excluded from biome so the formatter can't break the compare). `{ schema, buildHash, artifacts: {name:{sha256,size}}, bundles, sets }` |
| `src/index.ts` | `BUILD_LOCK` (typed + deep-frozen at module scope), `PY_BUILD_HASH`, `pyArtifactBase(origin)` |

## Invariants

- **Regeneration rule:** restage ⇒ new `buildHash` ⇒ reseed R2
  (`pnpm py:seed` locally / `publish:r2` remote) + commit the lock. The
  worker serves keys under `<buildHash>/…`, so a stale lock simply 404s —
  fail-visible, never fail-wrong.
- **Pure JSON + types** — no runtime deps, no ambient worker types; safe in
  the SW bundle (CI isolation grep unaffected) and in dedicated workers.
- `buildHash` = 16-hex truncated sha256 of the canonical (recursively
  key-sorted) `{artifacts, bundles, sets}` slim tables — deterministic for
  identical artifact bytes.
