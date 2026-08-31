# py-build — AVLO Python toolchain

> **Everything here is mutable and rapidly changing.** This doc describes
> TODAY's toolchain — none of it is a commitment. The "Hard gates" below are
> real correctness requirements; everything else (set shapes, caps, command
> topology, snapshot residence, compression levels) is a current choice the
> owner changes freely and often. Don't block a change because prose calls
> something an invariant — check WHY, then update the prose with the change.

Forked-Pyodide build + artifact packing for the in-browser Python runtime
(`web/src/core/py/`). Everything is pinned in `build.config.json`
(reproducibility root — schema + all knob documentation live in
`src/avlo_py_build/config.py`); cross-session state, measurement ledgers, and
hard-won learnings live in `NOTES.md` — **trust NOTES.md + the code over any
other prose where they conflict.**

**Toolchain:** Pyodide **314.0.2** / CPython **3.14** / emsdk **5.0.3**,
**MAIN_MODULE=2 closed world** — DSOs are NOT on the main link line; the only
effect we need from emcc's dynamic-lib processing is reproduced by
`.cache/link-sos/link.rsp` (one `-Wl,--export-if-defined=<sym>` per symbol
imported by the group DSOs; see NOTES for why the obvious alternative dies on
weak-COMDAT preemption). Side modules are **grouped 67→4**: each DSO-bearing
bundle ships ONE `.avlo/<bundle>.so` (numpy / mpl-deps / pandas / matplotlib)
linked by the recipes loop from committed manifests. Glue is
`pyodide.asm.mjs`. sqlite3 and `_zstd` are **static in the main module** (no
bundle, no set — `import sqlite3` / `import compression.zstd` work
everywhere). Sets = `{stdlib, numpy+pandas, numpy+matplotlib, all}` (the
standalone `numpy` set was dropped 2026-08 — `import numpy` rides
`numpy+pandas`). Snapshots are CLIENT-captured today (OPFS,
`web/src/core/py/`) — no snapshot artifacts are built or staged here YET
(build-time capture + shipping is an open owner direction; see NOTES Open
items); what the build owns is making every input byte-deterministic so a
rotated `buildHash` is the ONLY cache-invalidation signal anyone needs.

## Shape of the toolchain (post replatform phases 1–2, 2026-08-31)

Three layers, one plan (`toolchain-replatform-plan.md`; phases 3–6 pending):

1. **`avlo-build`** — a real Python package (`src/avlo_py_build/`, uv
   workspace member locked by the REPO-ROOT `uv.lock`; console script via
   `uv run avlo-build …`). One subcommand per pipeline stage; owns every
   host-side pack/verify/stage/publish step.
2. **Turbo** owns the pipeline DAG — tasks + inputs/outputs in root
   `turbo.json` (`@avlo/py-build#py:*`), commands in `package.json`. The old
   `board.mjs` serial runner is gone: **the board is `pnpm py:board` at the
   repo root** and it is incremental (a doc-only change no-ops in seconds).
   Gitignored build state (`dist/raw`, `dist/groups`, `.cache/trace`) enters
   the graph as explicit `inputs` globs — turbo hashes untracked files named
   by explicit globs (verified on 2.10).
3. **Docker lanes stay manual scripts** until phases 3/4: `run-build.mjs` +
   `build.sh` (fork), `run-recipes.mjs` + `recipes-build.sh` + 
   `harvest-links.py` + `link-groups.py` (recipes/groups). Never in Turbo/CI.

A `justfile` mirrors the human command surface (`just --list`) as THIN
aliases — no config parsing, no dependency edges in just (turbo owns the DAG).

## CLI (`uv run avlo-build <cmd>` — src/avlo_py_build/)

| Command | Module | Role |
|---|---|---|
| `config check` / `config schema` | `config.py` | Validate `build.config.json` (pydantic, extra=forbid, cross-refs) + assert installed fontTools == `hostTools.fonttools` + host minor == toolchain minor; emit JSON Schema. **All knob documentation lives in the model's field descriptions** — "where is the pyc -O level set" → `config.py` + the values in `build.config.json`, full stop (`pack` section: pyc -O levels, stdlib zip codec/level, brotli quality, budget headroom) |
| `fetch-wheels [--stamp] [--only a,b]` | `fetch_wheels.py` | Download + sha-verify pinned recipes wheels → `.cache/wheels/` (release asset → CDN mirror fallback; url pins go straight to source). `--stamp` re-pins from the stock lock (auto-fetched when absent/stale); drift guard hard-fails un-stamped divergence |
| `link-rsp` | `link_rsp.py` | Regenerate `.cache/link-sos/link.rsp` from the 4 group-DSO import unions (was fetch-wheels' second job). **Write-if-changed** — an identical regen preserves mtime, so build.sh no longer force-relinks after every fetch |
| `pack-stdlib [--repro]` | `pack_stdlib.py` | Pruned pyc-only stdlib zip + overlay + `_avlo_pruned` registry → `dist/stage/python_stdlib.zip` + `stdlib-modules.json`. `--repro` = build twice in-memory, byte-compare (replaces the board's ×2 double) |
| `pack-bundles <b>\|--all [--repro] [--stage-only\|--tar-only] / --unpruned [wheels]` | `pack_package.py` | Bundle tars: wheel patches → excludes → prune → pyc → [mpl: font subset via the IN-ENV pinned fontTools + `scripts/node/prebake-fontcache.mjs`] → grouped-DSO swap + registries → meta.json-first ustar. Same pipeline as ever, knobs from config |
| `trace check` / `trace propose <pkg>` / `trace record [--group g]` | `trace.py` | G3 analysis (trace ∩ prune = ∅, PIL/fontTools ban; prune-candidate rollup) in Python; `record` shells to `scripts/node/trace-record.mjs` (fork boot over unpruned trees) |
| `census [--check]` | `census.py` | DSO census + grouped-world audit over staged tars + main wasm → `.cache/dso-report.json`; `--check` = the dsos:check gate (census equality, finder-derivable inits, NEEDED empty, closed world vs main ∪ self ∪ {exit}, loadOrder shape, mixed-world fail) |
| `verify-groups [--spike b --pkgs a,b]` | `verify_groups.py` | Gate freshly linked `dist/groups/<b>.so` BEFORE packaging touches them (PyInit equality, closed world vs CURRENT main, spike lane vs upstream wheel censuses) |
| `verify-pytree [pkgs]` | `verify_pytree.py` | Rebuilt-vs-upstream `.py` byte equality per DSO package (allowlist `config/pkg-equality-allow.txt` with reasons) |
| `compress [--force]` | `compress.py` | Brotli `.br` siblings (quality from config; process pool). Skips up-to-date siblings by mtime |
| `budgets [--update]` | `budgets.py` | G1 ceilings; `--update` stamps measured × `pack.budgetHeadroom` into config (order-preserving raw-dict rewrite) |
| `stage [--check]` | `stage.py` | dist → `web/public/py-dev/fork/` (+ manifest.json, prunes strays), regenerates `py-stdlib-modules.gen.ts` + `pyodide-fork.gen.d.ts` + `packages/py-loader/build-lock.json` (buildHash = 16-hex sha256 of canonical sha tables); prestage glue liveness gates (dsoBaseHook marker, loadDynlib anchors, trampoline ≥2 occurrences). `--check` = byte drift gate |
| `publish [--remote] [--dry-run]` | `publish.py` | Preflight re-hashes EVERY byte vs the lock (+ `.br` freshness), uploads via wrangler (local miniflare seed default = `pnpm py:seed`; `--remote` probes the manifest completion marker first). Binding-put/boto3 upgrade lands with the publish/serving phase |
| `repro [--stdlib\|--bundles]` | `repro.py` | The determinism doubles, on demand — no longer on every board pass |

**Shared internals:** `packlib.py` (deterministic zip/ustar writers, prune
rules, tombstone keys, canonical JSON, tar-meta parse — the one sanctioned
non-web `parseTarMeta`), `wasmmeta.py` (LEB import/export/dylink.0 parser +
census filter — replaced `lib/wasm-parse.mjs`, native `WebAssembly.Module`
was measured SLOWER), `pyc_compile.py` + `_pyc_worker.py` (see the invariant
below), `paths.py`, `cli.py`.

> **Hermetic pyc workers — load-bearing.** Marshal encodes interned-string
> state, so **pyc bytes depend on which modules the compiling process
> imported first** (proven: compiling stdlib `argparse.py` before vs after
> `import argparse` yields different bytes). Every artifact pyc therefore
> compiles in `_pyc_worker.py` subprocesses whose import list is FROZEN (the
> legacy pack-script surface). Never compile artifact pycs in the CLI
> process, and never "clean up" the worker's import list outside a planned
> buildHash rotation. Registry `# GENERATED by pack-*.py` doc strings are
> frozen at the legacy names for the same reason (UNCHECKED_HASH pycs embed
> the source hash) — rename them with the next deliberate rotation.

## Remaining scripts (`scripts/`)

| Script | Role |
|---|---|
| `run-build.mjs` + `build.sh` | Docker fork build (pyodide 314.0.2 + patch queue) → `dist/raw/`. Flags: `--clone-only`, `--targets`, `--allow-undigested`. Replays pyodide patches from a clean tag checkout, stages `patches/cpython/*.patch`, direct-applies emsdk patches (AVLO-marker gated), force-relinks when `link.rsp` is newer than the built glue, stamps the queue hash. **Replatforms to a Dockerfile in phase 3** |
| `run-recipes.mjs` + `recipes-build.sh` | Docker recipe-rebuild loop: pinned recipes checkout + patch queues + byte-verified xbuildenv + per-package frozen constraints → serial no-deps builds → harvest → group links → `dist/groups/`. Flags: `--clone-only`, `--link-only` (`groups:link`), `--freeze-constraints`, `--force`, `--pkg <p>` (spike lane). **Replatforms to bake + uv in phase 4** |
| `harvest-links.py` / `link-groups.py` | Link records → per-bundle manifests; one `-sSIDE_MODULE=2` link per bundle (`--repro` double-link). Run inside the recipes lane — keep standalone |
| `scripts/node/dump-builtins.mjs` | Boots the fork on the RAW stdlib → `dist/stage/builtin-modules.json`. Folds into the fork Dockerfile at phase 3 |
| `scripts/node/prebake-fontcache.mjs` + `det-env.mjs` | D8 fontlist bake over the staged mpl set under the deterministic-env kit — the sanctioned Python→Node boundary (invoked by `pack-bundles`) |
| `scripts/node/trace-record.mjs` + `trace-imports.py` | Trace record mode: fork boot over unpruned trees, observe-only meta_path recorder → `.cache/trace/*.json` |

## Tests (phase 2, 2026-08-31 — the old run-corpus/run-harness runners are gone)

Two suites, one task name: **`pnpm test:py` at the repo root** = `turbo run
test:py`, fanning to both packages (cached on inputs; the DAG pulls pack/stage
first).

- **pytest corpus lane** (`tests/corpus/`, part of this package's plain
  `uv run pytest`): pytest-pyodide 0.59 node runtime over a tests-owned dist
  view (`.cache/pytest-dist` — raw fork glue + STAGED pruned stdlib + a
  one-line CJS `pyodide.js` shim + a `"type": "commonjs"` scope marker;
  rebuilt every configure, never the served tree). One test module per corpus
  group = one boot per group; bundle tars mount **pure-python**
  (`tarfile.extractall`, meta.json prefix-asserted) and DSOs load by NATURAL
  `import` through the sitecustomize group finder — zero JS in the mount
  path, equivalent to the shipped walker by the standing parity gate. Samples
  stay DATA (`corpus/<group>/*.py`, fresh namespace each); the font-log gate
  and the pillow pixel gate (≥2 colors, <99% dominant over
  `/tmp/corpus-out/*.png`) run as ordered tests per mpl-bearing group.
  Registry + plumbing: `tests/corpus/corpus_lib.py` (`GROUP_SET` — an
  unmapped corpus dir or missing `test_<group>.py` is a COLLECTION error).
  Units-only escape (no artifacts needed): `uv run pytest --rt host`.
  Never use `@run_in_pyodide`/`load_package` — they call the loadPackage
  surface patch 0006 removed.
- **web py-integration vitest project** (`web/tests/py-integration/`, own
  config; `pnpm --filter @avlo/web test:py`): the JS-contract gate — SHIPPED
  `web/src/core/py` modules + `@avlo/py-loader` against the staged serving
  tree, fork-per-file (three files scrub+freeze the realm). Five files map
  the old harness sections: `harden` (base board incl. trampoline census +
  post-freeze sqlite3), `harvest` (seaborn + figure-harvest protocol; PNG
  dims only — pixel quality moved to the pillow gate above), `snapshot`
  (capture→AVS2→verified read→dirty negative→restore; pure-codec negatives
  live in `src/core/py/py-snapshot.test.ts`, not re-proven), `mount-parity`
  (walker ≡ tarfile zero-diff — the theorem the pytest lane leans on),
  `lock` (staged tree vs committed lock ± corrupt negatives). Deliberately
  NOT in the root vitest `projects` array (artifact-gated, minutes-long) —
  `web#test` stays pure.

## Layout

`patches/pyodide/` (fork queue `0001` linkflags+memory exports+trampoline
`-u`+`-lzstd`, `0003` drop C-extensions — the list `config/stdlib-prune.txt`
mirrors, `0005` DSO snapshot support, `0006` drop the `pyodide.js`/
`package.json`/`pyodide-lock.json` boot crutch, `0007` owned-restore seam,
`0008` JS-bridge closure, `0008b` hiwire `getExpectedKeys`, `0009` fork API
types), `patches/cpython/` (AVLO cpython-source lane: `0010` trampoline arity
reorder), `patches/emsdk/` (`0006` dsoBaseHook + replay ctor/reloc skip —
mandatory), `bench/` (perf probes + ledgers — `README.md` there),
`patches/pyodide-build/` (link-record hook), `patches/recipes/` (recipe
source patches incl. the numpy legacy-rename the collision gate depends on),
`patches/wheels/<pkg>/NNNN-*.patch` (unified diffs rooted at the unpacked
wheel; deletions are prune-list lines, never patches),
`config/stdlib-prune.txt` + `config/pkg-prune/<pkg>.txt` (`# reason:`
comments become tombstone text), `config/dso-groups/` (`groups.json` census +
pins + the four harvest manifests), `config/pkg-equality-allow.txt`,
`config/recipes-constraints.d/`, `overlay/stdlib/` (exactly three files —
`sitecustomize.py`, `_avlo_runtime.py`, `_avlo_png.py`; **anything** dropped
here ships, and even a comment edit rotates `buildHash`),
`corpus/{basic 8, numpy 4, pandas 5, mpl 4, all 2, seaborn 6}`
(self-asserting samples; `# trace: skip` marks deliberate tombstone probes;
the sqlite group folded into `basic/b08_sqlite.py` when `_sqlite3` went
static; `tests/corpus/corpus_lib.py`'s `GROUP_SET` is a hard registry — an
unmapped corpus dir fails COLLECTION), `.cache/`
(wheels/stage/unpruned/trace/link-sos/pytest-dist + dso-report — gitignored),
`dist/` (raw fork output, staged artifacts, `groups/` — gitignored).

Python env: **workspace member of the repo-root uv workspace** —
`pyproject.toml` here (package `avlo-py-build`, requires-python `==3.14.*`,
deps pydantic/httpx/brotli/**fonttools pinned == `hostTools.fonttools`**;
dev group adds pytest-pyodide==0.59.0 (lockstep with pyodide) + pillow),
lock is the ROOT `uv.lock` (committed), venv at root `.venv/`. This
package's `test:py` script = `uv run pytest` (tests/: packlib units,
config-model gates, wasmmeta vectors + the corpus lane — see Tests above;
root `pnpm test:py` runs it through turbo alongside web's suite).
`.python-version` (3.14) pins the interpreter minor the pack commands
hard-require.

Wheel pins live in `build.config.json` `recipes.wheels`; pins with a `url`
are PyPI universal wheels absent from the stock lock (seaborn) — `--stamp`
and the drift guard skip them, downloads go straight to the url (sha pin =
provenance), and their `depends` field feeds `bundle_requires` in place of
the lock's depends graph. traceOnly wheels (pillow, fonttools) never ship.

## Hard gates (real correctness requirements)

- **Restage ⇒ recapture ⇒ reseed.** Any staged-artifact byte change mints a
  new `buildHash` in the committed build-lock (`packages/py-loader/`) — the
  app immediately fetches `<origin>/<newHash>/…`, so R2 must be reseeded
  (`pnpm py:seed` local, `publish:r2` remote) and the lock committed
  together. The rotated hash auto-invalidates every client's held state:
  OPFS per-set snapshots (dir GC), Cache API generations, SW eviction. A
  drifted stdlib under an unrotated hash is caught by the executor's
  as-mounted zip hash. `avlo-build stage --check` flags any drift; publish's
  preflight refuses a stale mix loudly. **The one-command flow is
  `pnpm py:board`.**
- **meta.json is the FIRST tar entry** — the executor, supervisor and the
  web py-integration suite read it via the one shared walker's 512-byte
  header parse (`web/src/core/py/py-mount.ts parseTarMeta`); the pytest
  corpus lane reads it python-side (`tarfile`, parity-gated) and the
  build-side twin is `packlib.parse_tar_meta` (build-graph isolation, never
  import web/src).
- **Deps-first set order = canonical cross-bundle DSO order**
  (`build.config.json` sets); within a bundle, `meta.loadOrder`. Snapshot
  replay depends on this order being stable.
- **Tombstone keys are exact dotted prune paths**; the sitecustomize finder
  walks prefixes longest-first and merges `_avlo_pruned` +
  `_avlo_pruned_<bundle>` registries discovered on site-packages.
- **`config/stdlib-prune.txt` mirrors patch 0003's `*disabled*` list.**
  Dropping a C extension orphans its pure-python wrappers; the standing
  check is the boot-and-import-everything sweep in NOTES session 18 —
  re-run it after any 0003 edit. Before pruning, prove no shipped package
  imports the target at TOP level and that it's absent from every
  `.cache/trace/*.json` `loaded` set.
- **Trampoline liveness** — the built glue must DEFINE
  `getWasmTrampolineModule` (stage's grep) and a 10k METH_NOARGS loop must
  cross into JS ~0 times (the py-integration boot census). Guards the
  MAIN_MODULE=2 lazy-archive regression (patch 0001's `-u`).
- **Hermetic pyc compilation** (see the invariant box above) — pyc bytes are
  a function of the worker's frozen import surface; compiling in any other
  process is a silent buildHash-rotation hazard.

## Current conventions (change freely, update prose with the change)

- **`overlay/stdlib/` sources ship inside the stdlib zip** — even a comment
  edit there rotates `buildHash` (same for the frozen registry doc strings
  and `_pyc_worker.py`'s import list). Batch such edits with a planned
  rotation; the next one is the 314.0.6 batch (plan §3), which should also
  rename the registry generator strings.
- Patch 0001 is the **single writer for `Makefile.envs`**; the cpython lane
  owns cpython-source changes.
- `jobs` in config = docker-lane make widths only; the CLI's own pools
  (fetch 8, brotli ≤4, pyc workers ≤8) are nproc-derived in code.
- Repro doubles are **on demand** (`pnpm --filter @avlo/py-build py:repro`),
  not part of every board run — run them when a toolchain/packer change is
  in question, and before publishing a rotation.

## Gate board

**`pnpm py:board` at the repo root** = `turbo run py:trace-check py:census
py:budgets py:stage-check test:py` (the DAG pulls
wheels/stdlib/bundles/builtins/compress/stage as needed, all cached on
inputs; `test:py` fans to BOTH suites — pytest units+corpus and the web
py-integration project) `&& pnpm typecheck && pnpm test && pnpm py:seed`.
Byte-identity doubles live in `py:repro` (see conventions). Last-green
stamps + ledgers live in `NOTES.md`. Docker lanes (fork/recipes) are run
manually before the board when patches/pins changed: `pnpm --filter
@avlo/py-build build:toolchain` / `recipes:build` (or `just fork` /
`just recipes`).
