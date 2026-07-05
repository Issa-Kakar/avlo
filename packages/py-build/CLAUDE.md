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
| `pack-package.py` | Bundle tars (D2-D6): wheel patches (`patches/wheels/<pkg>/`) → global excludes → prune (`config/pkg-prune/`) → [mpl: font subset via pinned host fontTools venv + fontlist prebake] → pyc `-o 1` → `_avlo_pruned_<bundle>` → meta.json-first deterministic ustar → `dist/stage/bundles/`. `--unpruned` materializes tracer trees; `--stage-only`/`--tar-only` split at the prebake seam |
| `prebake-fontcache.mjs` | Bakes `matplotlib/fontlist.json` over the SUBSET faces (fork boot on staged trees, det-env kit, canonical JSON). The wheel ships a stale 39-face list — deleted before the rebuild |
| `trace-imports.mjs` + `.py` | Import tracer (G3): runs package corpus groups over UNPRUNED trees (raw stdlib; pillow/fonttools mounted for mpl groups) recording attempts + loads. `--check`: trace ∩ prune = ∅ AND no PIL/fontTools attempt. `--propose <pkg>`: unreached-subtree prune candidates. Samples marked `# trace: skip` (deliberate tombstone probes, packed-artifact assertions) are excluded |
| `make-baseline.mjs` | `dist/baseline.snap` (det-env kit, `--repro` = G0 byte-identity, restore-verify) + `builtin-modules.json`. HARD-ERRORS on missing staged zip (restage ⇒ recapture) |
| `run-corpus.mjs` | Corpus runner: child process per group (RAM-bounded), mounts the REAL bundle tars (512-byte meta parse → tarfile extract → loadDynlib per loadOrder), mpl groups add the font gates (no findfont, no fontManager rebuild) + PNG decode (`lib/png.mjs`) of `/tmp/corpus-out/*.png` |
| `compress.mjs` | Brotli q11 `.br` siblings for every servable artifact |
| `check-budgets.mjs` | G1: per-artifact + composite `.br` ceilings from `build.config.json`; `--update` stamps measured +5% |
| `stage.mjs` | dist → `web/public/py-dev/fork/` (+ `bundles/*.tar` + dev `manifest.json`) and REGENERATES `web/src/core/py/py-stdlib-modules.gen.ts`. `--check` = drift gate (any artifact/codegen divergence fails) |
| `lib/det-env.mjs` | Deterministic capture env (entropy/Date.now/performance.now stand-ins) — shared by baseline + prebake |
| `lib/png.mjs` | Minimal PNG decoder (filters 0-4) for corpus pixel assertions |

## Layout

`patches/pyodide/` (fork queue 0001-0007), `patches/emsdk/` (dsoBaseHook),
`patches/wheels/<pkg>/NNNN-*.patch` (unified diffs rooted at the unpacked
wheel; deletions are prune-list lines, never patches), `config/stdlib-prune.txt`
+ `config/pkg-prune/<pkg>.txt` (`# reason:` comments become tombstone text),
`overlay/stdlib/` (sitecustomize tombstone finder + `_avlo_runtime`
post-restore/tz-bridge + `_avlo_png` encoder), `corpus/{basic,numpy,pandas,mpl,all}/`
(self-asserting samples), `.cache/` (wheels/stage/unpruned/trace/hosttools —
gitignored), `dist/` (raw fork output + staged artifacts — gitignored).

## Invariants

- **Restage ⇒ recapture.** Any staged-stdlib change poisons held snapshots
  (zipimport TOC offsets live in the heap); make-baseline refuses raw-zip
  fallback, stage `--check` flags drift.
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
