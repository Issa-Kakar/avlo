# py-build — AVLO Python toolchain

Forked-Pyodide build + artifact packing for the in-browser Python runtime
(`web/src/core/py/`). Everything is pinned in `build.config.json`
(reproducibility root); in-flight cross-session state lives in `NOTES.md`.
Deliberately NO `build` script — the toolchain needs docker and never runs in
Turbo/CI. All pack scripts are byte-reproducible (`--repro` builds twice and
compares) and re-exec under `PYTHONHASHSEED=0` (marshalled sets iterate in
hash order).

## Scripts (`scripts/`)

| Script | Role |
|---|---|
| `run-build.mjs` + `build.sh` | Docker fork build (pyodide 0.29.4 + patch queue) → `dist/raw/`. Prestage gate: `grep -c "snapshot DSO table drift" dist/raw/pyodide.asm.js` ≥ 1 |
| `packlib.py` | Shared pack primitives: hashseed re-exec guard, `compile_pyc` (UNCHECKED_HASH), prune-rule parsing + EXACT dotted tombstone keys (`xml/sax/` → `xml.sax`; data-file rules mint none), deterministic zip/ustar writers, canonical JSON |
| `pack-stdlib.py` | Pruned pyc-only stdlib zip (`-o 2`, DEFLATED 9) + overlay modules + `_avlo_pruned` registry → `dist/stage/python_stdlib.zip` + `stdlib-modules.json` |
| `fetch-wheels.mjs` | Downloads the pinned recipes wheels → `.cache/wheels/` (sha-verified; release asset → CDN mirror fallback). `--stamp` re-pins from the stock lock |
| `pack-package.py` | Bundle tars (D2-D6): wheel patches (`patches/wheels/<pkg>/`) → global excludes → prune (`config/pkg-prune/`) → [mpl: font subset via pinned host fontTools (`uvx --from fonttools==<hostTools pin>`) + fontlist prebake] → pyc `-o 1` → `_avlo_pruned_<bundle>` → meta.json-first deterministic ustar → `dist/stage/bundles/`. `--unpruned` materializes tracer trees; `--stage-only`/`--tar-only` split at the prebake seam |
| `prebake-fontcache.mjs` | Bakes `matplotlib/fontlist.json` over the SUBSET faces (fork boot on staged trees, det-env kit, canonical JSON). The wheel ships a stale 39-face list — deleted before the rebuild |
| `trace-imports.mjs` + `.py` | Import tracer (G3): runs package corpus groups over UNPRUNED trees (raw stdlib; pillow/fonttools mounted for mpl groups) recording attempts + loads. `--check`: trace ∩ prune = ∅ AND no PIL/fontTools attempt. `--propose <pkg>`: unreached-subtree prune candidates. Samples marked `# trace: skip` (deliberate tombstone probes, packed-artifact assertions) are excluded |
| `make-baseline.mjs` | `dist/baseline.snap` (det-env kit, `--repro` = G0 byte-identity — baked into the `baseline` script, restore-verify) + `builtin-modules.json`. HARD-ERRORS on missing staged zip (restage ⇒ recapture). The snapshot is a LOCK ARTIFACT: staged + published + budget-gated like the glue trio |
| `verify-stacking.mjs` | G-P3.0 (`pnpm verify:stacking`): capture-after-restore probe — boot `_loadSnapshot(baseline)`+`_makeSnapshot` → mount sqlite3+numpy → set imports → stacked capture → restore via the production `_preRestoreHook` port in-process → numpy/sqlite3/lazy-submodule asserts + blit probe. The one fork path the browser spike never ran; green = per-set generation may stack on a restored baseline |
| `run-corpus.mjs` | Corpus runner: child process per group (RAM-bounded), mounts the REAL bundle tars (512-byte meta parse → tarfile extract → loadDynlib per loadOrder), mpl groups add the font gates (no findfont, no fontManager rebuild) + PNG decode (`lib/png.mjs`) of `/tmp/corpus-out/*.png` |
| `compress.mjs` | Brotli q11 `.br` siblings for every servable artifact |
| `check-budgets.mjs` | G1: per-artifact + composite `.br` ceilings from `build.config.json`; `--update` stamps measured +5% |
| `stage.mjs` | dist → `web/public/py-dev/fork/` (+ `bundles/*.tar` + `manifest.json`, prunes strays) and REGENERATES `web/src/core/py/py-stdlib-modules.gen.ts` + `packages/py-loader/build-lock.json` (buildHash = 16-hex sha256 of the canonical sha tables). `--check` = drift gate (any artifact/codegen/lock divergence fails) |
| `run-harness.mjs` | Node verification harness (`pnpm harness`; Node ≥23.6 — type-strips the SHIPPED `py-harden.ts`/`py-harness.ts`/py-loader `verify.ts`): boots the staged fork per child section, mounts real tars in lock set order, re-enacts the exact executor boot (mounts → stdlib verify → scrub → harden → assert → harness), then drives the full board — scrub/freeze sweeps + negatives, 0008 closure probes, tombstones, sqlite3/numpy/seaborn+PNG post-freeze, staged-tree-vs-lock byte checks. Runs after any harden/verify/artifact change; never in Turbo/CI |
| `publish.mjs` | Staged artifacts → R2 under `<buildHash>/…` (every lock artifact + bundle tar, each with its `.br` sibling; manifest.json strictly LAST = completion marker). `--local` (default; `pnpm py:seed` from root) seeds the dev miniflare tree via `--persist-to <root>/.wrangler/state` (wrangler appends `v3`); `--remote` publishes to the real `avlo-py` bucket with a manifest divergence probe (absent→publish, identical→no-op, different→hash-bug hard error). Preflight re-hashes EVERY source byte against the build-lock + checks `.br` freshness (restage ⇒ reseed) |
| `lib/det-env.mjs` | Deterministic capture env (entropy/Date.now/performance.now stand-ins) — shared by baseline + prebake |
| `lib/png.mjs` | Minimal PNG decoder (filters 0-4) for corpus pixel assertions |

## Layout

`patches/pyodide/` (fork queue 0001-0007), `patches/emsdk/` (dsoBaseHook),
`patches/wheels/<pkg>/NNNN-*.patch` (unified diffs rooted at the unpacked
wheel; deletions are prune-list lines, never patches), `config/stdlib-prune.txt`
+ `config/pkg-prune/<pkg>.txt` (`# reason:` comments become tombstone text),
`overlay/stdlib/` (sitecustomize tombstone finder + `_avlo_runtime`
post-restore/tz-bridge + `_avlo_png` encoder),
`corpus/{basic,sqlite,numpy,pandas,mpl,all,seaborn}/` (self-asserting
samples; `# trace: skip` marks deliberate tombstone probes), `.cache/`
(wheels/stage/unpruned/trace — gitignored), `dist/` (raw fork
output + staged artifacts — gitignored).

Wheel pins live in `build.config.json` `recipes.wheels`; pins with a `url`
are PyPI universal wheels absent from the stock lock (seaborn) — `--stamp`
and the drift guard skip them, downloads go straight to the url (sha pin =
provenance), and their `depends` field feeds `bundle_requires` in place of
the lock's depends graph.

## Invariants

- **Restage ⇒ recapture.** Any staged-stdlib change poisons held snapshots
  (zipimport TOC offsets live in the heap); make-baseline refuses raw-zip
  fallback, stage `--check` flags drift. `baseline.snap` bytes are IN the
  lock's artifacts table, so a byte-different recapture rotates `buildHash`
  (identical inputs reproduce byte-identically ⇒ no-op) — and a rotated hash
  auto-invalidates every client's OPFS per-set snapshots (dir GC) + Cache API.
- **Restage ⇒ reseed.** Every restage mints a new `buildHash` in the committed
  build-lock (`packages/py-loader/`) — the app immediately fetches
  `<origin>/<newHash>/…`, so R2 must be reseeded (`pnpm py:seed` local,
  `publish:r2` remote) and the lock committed together. publish.mjs's
  preflight re-hashes every source byte against the lock, so a stale mix
  refuses loudly.
- **meta.json is the FIRST tar entry** — JS mounts read it with one 512-byte
  ustar header parse, no tar library (spike, corpus, supervisor all rely on it).
- **Deps-first set order = canonical cross-bundle DSO order**
  (`build.config.json` sets); within a bundle, `meta.loadOrder`
  (lexicographic). Snapshot replay (P3) depends on this order being stable.
- **Tombstone keys are exact dotted prune paths**; the sitecustomize finder
  walks prefixes longest-first and merges `_avlo_pruned` +
  `_avlo_pruned_<bundle>` registries discovered on site-packages.
- **traceOnly wheels (pillow, fonttools) never ship** — they exist so the
  tracer can catch residual import sites (the `--check` PIL/fontTools ban).

## Gate board (M2)

`pack:stdlib` double-run byte-identity · corpus basic 6/6 (G-M2.0) · per-tar
`--repro` (G-M2.R) · tracer `--check` (G3) · corpus numpy/pandas/mpl/all with
PNG + font gates (G2/G6) · `budgets` (G1) · browser spike board through
numpy.tar (G7) · `stage --check` · `pnpm typecheck`.
