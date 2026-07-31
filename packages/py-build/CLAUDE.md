# py-build — AVLO Python toolchain

Forked-Pyodide build + artifact packing for the in-browser Python runtime
(`web/src/core/py/`). Everything is pinned in `build.config.json`
(reproducibility root); cross-session state, measurement ledgers, and
hard-won learnings live in `NOTES.md` — **trust NOTES.md + the code over any
other prose where they conflict.** Deliberately NO `build` script — the
toolchain needs docker and never runs in Turbo/CI. All pack scripts are
byte-reproducible (`--repro` builds twice and compares) and re-exec under
`PYTHONHASHSEED=0` (marshalled sets iterate in hash order).

**Toolchain:** Pyodide **314.0.2** / CPython **3.14** / emsdk **5.0.3**,
**MAIN_MODULE=2 closed world** — DSOs are NOT on the main link line; the only
effect we need from emcc's dynamic-lib processing is reproduced by
`.cache/link-sos/link.rsp` (one `-Wl,--export-if-defined=<sym>` per symbol
imported by the group DSOs; see NOTES for why the obvious alternative dies on
weak-COMDAT preemption). Side modules are **grouped 67→4**: each DSO-bearing
bundle ships ONE `.avlo/<bundle>.so` (numpy / mpl-deps / pandas / matplotlib)
linked by the recipes loop from committed manifests. Glue is
`pyodide.asm.mjs`. sqlite3 is **static in the main module** (no bundle, no
set — `import sqlite3` works everywhere). Sets =
`{stdlib, numpy, numpy+pandas, numpy+matplotlib, all}`. Snapshots are
CLIENT-captured today (OPFS, `web/src/core/py/`) — no snapshot artifacts are
built or staged here YET (build-time capture + shipping is an open owner
direction; see NOTES Open items); what the build owns is making every input
byte-deterministic so a rotated `buildHash` is the ONLY cache-invalidation
signal anyone needs.

## Scripts (`scripts/`)

| Script | Role |
|---|---|
| `run-build.mjs` + `build.sh` | Docker fork build (pyodide 314.0.2 + the patch queue) → `dist/raw/`. Flags: `--clone-only`, `--targets`, `--allow-undigested` (image digest drift gate). build.sh replays pyodide patches from a clean tag checkout (one commit each), direct-applies missing emsdk patches + hard-asserts the `AVLO` marker in the installed dylink glue, and force-relinks when `link.rsp` is newer than the built glue |
| `packlib.py` | Shared pack primitives: hashseed re-exec guard, `compile_pyc` (UNCHECKED_HASH), prune-rule parsing + EXACT dotted tombstone keys, deterministic zip/ustar writers (names ≤100 chars AND ASCII-only — the shipped walker's charCode contract), canonical JSON |
| `pack-stdlib.py` | Pruned pyc-only stdlib zip (`-O2`, DEFLATED 9) + overlay modules + `_avlo_pruned` registry → `dist/stage/python_stdlib.zip` + `stdlib-modules.json`. Refuses to run off the pinned python minor |
| `dump-builtins.mjs` | Boots the fork on the RAW stdlib → `dist/stage/builtin-modules.json` (sorted `sys.builtin_module_names`); hard-asserts `_sqlite3` is a static builtin. Required stage.mjs input |
| `fetch-wheels.mjs` | Two jobs: (1) download the pinned recipes wheels → `.cache/wheels/` (sha-verified; release asset → CDN mirror fallback; `--stamp` re-pins from the stock lock, `--only a,b` narrows); (2) ALWAYS regenerate `.cache/link-sos/link.rsp` from the 4 `dist/groups/*.so` import unions — the closed world's link input (hard-error if any group .so is missing) |
| `pack-package.py` | Bundle tars: wheel patches (`patches/wheels/<pkg>/`) → global excludes → prune (`config/pkg-prune/`) → grouped-DSO swap (drop per-extension `.so`s, assert dropped set == `groups.json` census AND census wheel shas == config pins — the stale-group gate — then inject `.avlo/<bundle>.so` + the `_avlo_groups_<bundle>` registry the sitecustomize finder reads) → [mpl: font subset via pinned `uvx --from fonttools` + fontlist prebake] → pyc `-O1` → `_avlo_pruned_<bundle>` → meta.json-first deterministic ustar → `dist/stage/bundles/`. `--unpruned` materializes tracer trees; `--stage-only`/`--tar-only` split at the prebake seam |
| `prebake-fontcache.mjs` | Bakes `matplotlib/fontlist.json` over the SUBSET faces (fork boot on staged trees, det-env kit, canonical JSON). The wheel ships a stale 39-face list — deleted before the rebuild |
| `trace-imports.mjs` + `.py` | Import tracer (G3): runs package corpus groups over UNPRUNED trees (raw stdlib; pillow/fonttools mounted for mpl groups) recording attempts + loads. `--check`: trace ∩ prune = ∅ AND no PIL/fontTools attempt. `--propose <pkg>`: unreached-subtree prune candidates. `# trace: skip` samples excluded (deliberate tombstone probes) |
| `run-corpus.mjs` | Corpus runner: child process per group (RAM-bounded), mounts the REAL bundle tars via the SHIPPED `py-mount.ts` walker (`mountBundleTree`/`parseTarMeta` — asserts `meta.prefix` == interpreter site-packages, dlopen per loadOrder, `ensure_tzpath` after mounts); mpl groups add the font gates (no findfont, no fontManager rebuild) + PNG pixel decode (`lib/png.mjs`) |
| `analyze-dsos.mjs` | DSO census + grouped-world audit over staged bundle tars + main wasm (imports/exports/dylink.0, import-provider table, lazy-stub audit). `--check` (`dsos:check`): PyInit census equality vs `groups.json`, finder-derivable init names, `needed==[]`, closed world vs main ∪ self ∪ `{exit}`, loadOrder shape, mixed-world hard fail (+ always: PyInit shortname uniqueness, no PyInit-less DSO). Census updates come from the recipes-loop harvest manifests |
| `run-recipes.mjs` + `recipes-build.sh` | Docker recipe-rebuild loop: pinned pyodide-recipes checkout + patch queues (`patches/recipes/` incl. the numpy legacy-rename; `patches/pyodide-build/` link-record hook) + byte-verified xbuildenv + per-package frozen constraints (`recipes-constraints.d/`; `--freeze-constraints` regenerates them from AVLO-PKG pip-log markers) → serial no-deps builds → harvest → group links → `dist/groups/`. `--pkg <p>` spikes one package (hand-only lane; outputs marked partial/`spike-*` so packaging can't consume them) |
| `harvest-links.py` | Link records → per-bundle manifests (`config/dso-groups/<bundle>.json`): (pkg, PyInit) matching, thin-archive repack, flag-tail reconciliation, content-addressed stash (build-env path normalization), per-bundle duplicate-strong-def collision gate (hard fail) |
| `link-groups.py` | One `-sSIDE_MODULE=2` link per bundle from its manifest; `--repro` double-link byte-compare; `--allow-partial` spike outputs named `spike-*.so` |
| `verify-groups.mjs` + `verify-pytree.py` | `groups:verify` — PyInit census equality + `needed==[]` + closed world vs the CURRENT main per group .so; rebuilt-vs-upstream `.py` byte equality per package (allowlist `config/pkg-equality-allow.txt` with reasons). `--spike`/`--pkgs` serve the hand-only spike lane |
| `compress.mjs` | Brotli q11 `.br` siblings for every servable artifact (`--force` overrides the up-to-date skip) |
| `check-budgets.mjs` | G1: per-artifact + composite `.br` ceilings from `build.config.json`; `--update` stamps measured +5% |
| `stage.mjs` | dist → `web/public/py-dev/fork/` (+ `bundles/*.tar` + `manifest.json`, prunes strays) and REGENERATES `web/src/core/py/py-stdlib-modules.gen.ts` + `packages/py-loader/build-lock.json` (buildHash = 16-hex sha256 of the canonical sha tables). Prestage liveness gate on the built glue (`snapshot DSO table drift` + `loadDynlib` markers). `--check` = drift gate (any artifact/codegen/lock divergence fails). Keeps the ONE sanctioned local `parseTarMeta` copy (build-graph isolation — never import web/src from here) |
| `run-harness.mjs` | Node verification harness (`pnpm harness`; Node ≥23.6 type-strips the SHIPPED `py-harden`/`py-harness`/`py-mount`/`py-snapshot`/`py-loader`/`py-protocol` + py-loader `verify.ts` via `lib/ts-resolve.mjs`). Five child sections: **base** (exact executor boot re-enactment → scrub/freeze sweeps + fail-closed negatives, 0008 closure probes, tombstones, sqlite3 post-freeze) · **seaborn** (`all` set: plots decode to real pixels, vendored KDE, font gates, pandas↔sqlite3, figure caps vs PY_LIMITS) · **snapshot** (uniform-boot cold probe via the SHIPPED feeds driver → dso-free knife → bake → fork-API capture → AVS2 assemble via the SHIPPED codec → sup-style `readSnapshotToBuffer` positives/negatives → `DirtyRestoreError` negative → precompiled-Module restore → walk-only remount + RNG-pin/blit-reset probes) · **parity** (walker-vs-tarfile zero-diff full-tree gate — the standing L1 proof) · **verify** (`matchesLockEntry` over every staged artifact + corrupt negatives). Runs after any harden/verify/artifact/mount change; never in Turbo/CI |
| `publish.mjs` | Staged artifacts → R2 under `<buildHash>/…` (every lock artifact + bundle tar with its `.br` sibling; `manifest.json` strictly LAST = completion marker; never fetched by clients — the SW's py fall-through branch exists for it). `--local` (default; `pnpm py:seed` from root) seeds the dev miniflare tree; `--remote` publishes to the real `avlo-py` bucket with a manifest divergence probe; `--dry-run` prints the plan. Preflight re-hashes EVERY source byte against the build-lock + checks `.br` freshness (restage ⇒ reseed). Uploads via wrangler CLI, which has NO checksum flag — the binding-put upgrade (sha256-verified, local+remote) is researched in NOTES Open items |
| `lib/ts-resolve.mjs` | Side-effect import, FIRST in harness + corpus: Node ≥23.6 guard + `registerHooks` resolve fallback appending `.ts` — the shipped extensionless-relative web TS imports verbatim |
| `lib/det-env.mjs` | Deterministic fork-boot env (entropy/Date.now/performance.now stand-ins). Sole consumer: `prebake-fontcache.mjs` |
| `lib/png.mjs` | Minimal PNG decoder (filters 0-4) for corpus pixel assertions |
| `lib/wasm-parse.mjs` | wasm import/export/dylink.0 parser + `censusImports` — shared by `analyze-dsos.mjs` and `verify-groups.mjs` |

## Layout

`patches/pyodide/` (fork queue `0001, 0003, 0005, 0006, 0007, 0008, 0008b`),
`patches/emsdk/` (`0006` dsoBaseHook + replay ctor/reloc skip — mandatory),
`patches/pyodide-build/` (link-record hook), `patches/recipes/` (recipe
source patches incl. the numpy legacy-rename the collision gate depends on),
`patches/wheels/<pkg>/NNNN-*.patch` (unified diffs rooted at the unpacked
wheel; deletions are prune-list lines, never patches), `config/stdlib-prune.txt`
+ `config/pkg-prune/<pkg>.txt` (`# reason:` comments become tombstone text),
`config/dso-groups/` (`groups.json` census + per-bundle harvest manifests),
`config/recipes-constraints.d/` (per-package frozen pins; the flat
`recipes-constraints.txt` is only the required-to-exist seed),
`overlay/stdlib/` (sitecustomize tombstone+group finders + `_avlo_runtime`
post-restore/tz-bridge + `_avlo_png` encoder), `corpus/{basic,sqlite,numpy,
pandas,mpl,all,seaborn}/` (self-asserting samples; `# trace: skip` marks
deliberate tombstone probes), `.cache/` (wheels/stage/unpruned/trace/
link-sos/link-inputs — gitignored), `dist/` (raw fork output, staged
artifacts, `groups/` recipe-loop output — gitignored).

Wheel pins live in `build.config.json` `recipes.wheels`; pins with a `url`
are PyPI universal wheels absent from the stock lock (seaborn) — `--stamp`
and the drift guard skip them, downloads go straight to the url (sha pin =
provenance), and their `depends` field feeds `bundle_requires` in place of
the lock's depends graph.

## Invariants

- **Restage ⇒ recapture ⇒ reseed.** Any staged-artifact byte change mints a
  new `buildHash` in the committed build-lock (`packages/py-loader/`) — the
  app immediately fetches `<origin>/<newHash>/…`, so R2 must be reseeded
  (`pnpm py:seed` local, `publish:r2` remote) and the lock committed
  together. The rotated hash auto-invalidates every client's held state:
  OPFS per-set snapshots (dir GC), Cache API generations, SW eviction. A
  drifted stdlib under an unrotated hash is caught by the executor's
  as-mounted zip hash (zipimport TOC offsets live in captured heaps — the
  corruption class BUILD_ID cannot see). `stage --check` flags any drift;
  publish.mjs's preflight refuses a stale mix loudly.
- **`overlay/stdlib/` sources ship inside the stdlib zip** — even a comment
  edit there rotates `buildHash` and forces a full restage + reseed. Batch
  overlay changes (including doc-wording fixes) with a planned restage.
- **meta.json is the FIRST tar entry** — every consumer (executor, harness,
  corpus, supervisor) reads it via the one shared walker's 512-byte header
  parse (`web/src/core/py/py-mount.ts parseTarMeta`; stage.mjs keeps the one
  sanctioned local copy).
- **Deps-first set order = canonical cross-bundle DSO order**
  (`build.config.json` sets); within a bundle, `meta.loadOrder`. Snapshot
  replay depends on this order being stable.
- **Tombstone keys are exact dotted prune paths**; the sitecustomize finder
  walks prefixes longest-first and merges `_avlo_pruned` +
  `_avlo_pruned_<bundle>` registries discovered on site-packages.
- **`config/stdlib-prune.txt` mirrors patch 0003's `*disabled*` list.**
  Dropping a C extension orphans its pure-python wrappers; if they keep
  shipping they pass the click-time gate and die at import with an error
  naming a module the user never typed. This drifted once (session 18:
  `_lsprof`→`cProfile`, `pyexpat`→`plistlib`, `_multibytecodec`→27
  `encodings/` leaves). The standing check is the boot-and-import-everything
  sweep in NOTES session 18 — re-run it after any 0003 edit. Before pruning,
  prove no shipped package imports the target at TOP level (lazy hits are
  fine) and that it's absent from every `.cache/trace/*.json` `loaded` set.
- **traceOnly wheels (pillow, fonttools) never ship** — they exist so the
  tracer can catch residual import sites (the `--check` PIL/fontTools ban).

## Gate board

`pack:stdlib` ×2 byte-identity · `bundles -- --all --repro` byte-identity ·
`trace:check` (G3) · `corpus` 7/7 (font + PNG gates) · `dsos:check`
(grouped-world v2) · `groups:verify` · `compress` → `budgets` (G1) ·
`stage` + `stage:check` · `harness` (all five sections) · `pnpm typecheck` ·
vitest (web AVS2 codec + py-loader verify + workers/py) · `pnpm py:seed`.
Last-green stamps + ledgers live in `NOTES.md`.
