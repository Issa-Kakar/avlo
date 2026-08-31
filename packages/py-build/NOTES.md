# py-build NOTES — cross-session state for the Python-runtime redesign

**What this file is:** durable, load-bearing knowledge for agents working the
py-runtime redesign — current state, the measurement ledgers every phase gate
compares against, hard-won learnings, and open items. It is NOT a changelog:
when a phase lands, append a compact entry to the phase log at the bottom and
fold its durable facts into the sections above it. Kill anything here that a
later phase makes false.

**Everything here is mutable and rapidly changing.** Current-state sections
describe TODAY's implementation, never commitments — the owner pivots
surfaces (sets, caps, snapshot residence, compression, boot topology)
frequently and expects agents to engage with proposed changes on the merits,
not to defend prose. Only two classes are firm: **owner-settled** decisions
(explicitly labeled — e.g. the same-origin security posture) and
**hard-correctness** gates (hash verification, meta.json-first, deps-first
DSO order, trampoline liveness). When a change lands, UPDATE the prose it
falsifies — don't leave "invariants" describing the previous design.

**Redesign plan (P0–P5), historical:**
`/home/issak/.claude/plans/docs-local-py-runtime-redesign-condense-parsed-piglet.md`
(local-only). It has drifted meaningfully from what landed — treat it as
background reading, not authority; THIS file + the code are current. Its
rejected-alternatives register is still worth checking before re-proposing
something.

---

## Current state — 2026-08 perf batch (trampoline fix, -O2 confirmed, cancel=kill, L1 figures, board)

- **2026-08 perf batch landed (Session 19; buildHash `7fdf68788eb8a2a4` —
  the whole batch rode ONE rotation).** Headlines: the dead wasm-gc
  trampoline FIXED (0 JS crossings /10k METH_NOARGS, was 10,367; meth −48% /
  json −11% clean same-policy) + two permanent gates; **-O2 confirmed as
  ship state** (the apparent "-O3 ~30% win" was a CPU-boost-policy artifact;
  clean A/B ~0–3%); tail-call variant 0 REJECTED on clean redone data
  (geomean +25% regression, Liftoff worse too; cross-verified against the
  remote PR #16 sweep — `bench/tailcall-bridge/`, Session 20 — with
  `bench/v3-tailcall-patches/` keeping the kit for a fork-lane variant-4
  test); mimalloc REJECTED
  (+42 MB heap); interrupt
  disarmed — cancel = kill+respawn; figure PNG encode zlib L9→L1 streaming
  (big-figure savefig 906→160 ms measured on the staged fork); mpl
  first-figure bake in capture (569 ms capture-side, `all` heap flat at
  65.4 MB); standalone `numpy` set dropped; script parallelism + the
  one-command **`pnpm board`**; fork API types staged
  (`pyodide-fork.gen.d.ts`, patch 0009 — py-loader's `Pyodide` is a real
  type). Story + verdicts: Session-19 phase entry; raw probe rows:
  `bench/ledger-2026-08.jsonl` (only `*-agg-*`/`V1-ship-agg` entries are
  policy-clean — see the learnings entry on boost-policy pinning).
- **Cold-restore attack landed** (Session 16; commits `630b17f` L1 walker,
  `f332d90` build rev, `ba23635` L2 flip + knives; receipts in
  `docs(local)/ColdRestoreAttack.md`). The mechanics are now current-state
  documented in `web/src/core/py/CLAUDE.md` ("Boot topology" + file table);
  the story is in the Session-16 phase-log entry. Four layers, headline
  facts:
  - **L1 — direct-node mount walker** (`py-mount.ts`): tar trees graft
    straight into MEMFS, contents adopt tar subarray views — 855 → ~11 ms
    for `all`, byte-identical (harness `--section parity` is the STANDING
    zero-diff gate, 1,675 entries).
  - **L2 — topology flip + uniform boot**: executor spawned FIRST, fed
    `boot-prep`/`boot-data`/`snap-header`/`snap-heap` so bundle prep + ALL
    OPFS I/O hide in the spawn shadow (supervisor owns every OPFS handle);
    uniform noInitialRun boots with the async preBlit driver deciding
    restore-vs-cold in flight (deferred `Module.callMain()`; mutation-zone
    failures ⇒ `DirtyRestoreError` ⇒ fresh re-instantiate). F1–F17 task
    discipline closed three pre-existing races (muted-terminate
    forged-capture window, snapOps U6 delete-vs-probe, live-guarded
    download progress).
  - **DSO precompile** overlapped with the main instantiate;
    `loadDynlibReplay` accepts precompiled `WebAssembly.Module`s (0005).
  - **Knives**: stdlib zip `{canOwn:true}` (−2.84 MB/boot copy, 0007) ·
    `zoneinfo/_zoneinfo.py` pruned (−12.4 KB, tombstoned) · the session-18
    dead-on-import sweep (−502 KB, zip 3.34 → 2.84 MB) · cold-boot
    `freeDsoFileData` (**−14.7 MB; `all` capture heapLen 78.5 → 65.4 MB** —
    every restore reads/hashes/transfers/blits that much less).
- buildHash at the sweep was `e210f3a9a140f04b` (superseded — current is
  `7fdf68788eb8a2a4`, 2026-08 perf batch, seeded to local R2, 23 keys; every
  rotation auto-invalidates clients' OPFS snapshots + caches).
- **Preview-board ledger — RE-RECORDED by the owner (2026-07-29; production
  build @ localhost:3000, Chrome + SW active, local R2, no throttling;
  snapshots already in OPFS + tars SW-cached except the first-visit row;
  click→ready = sup reqToReadyMs, exec boot in parens):**
  - `all` restore: click→ready **364 ms warm-sup / 421–503 ms cold-page**
    (boot 335 / 282–423) vs 1,123 baseline — target ≤450 MET warm, grazed on
    cold pages, where sup startup dominates the delta (glue-preflight 77–137
    + spawn 78–137). click→result **1,135–1,426** (target ≤1,000): the
    remaining gap is pure `run-python` (710–917 ms for the
    numpy/pandas/mpl/seaborn snippets) — boot did its part; consistent
    sub-1,500 ms cold-restore execution of an all-set snippet is the
    headline result.
  - numpy+pandas restore: click→ready **310** (boot 209) vs 828 — ≤350 ✓;
    click→result 432 (exec 117, pandas+sqlite snippet).
  - numpy+matplotlib restore: click→ready **292** (boot 209); click→result
    598 (exec 302 — first mpl draw).
  - stdlib restore: click→ready **248** (boot 167) — ≤160 MISSED on a
    cold-page sup: boot is flat vs P2 (167 vs 168) and the whole miss is
    glue-preflight 79 + spawn 80.
  - `all` FIRST-VISIT cold+capture (incognito: SW installing, real
    downloads): click→ready 4,943 (boot 3,203 — capture-imports 2,189;
    sup glue-preflight 1,389 + bundles 1,397 are genuine network),
    click→result 5,412 (exec 467); opfs-write 388 @65 MB lands post-ready.
    NOT comparable to Session-15's 3,934 (that row was warm-HTTP-cache).
  - Boot internals across sets: dso-replay 18–32 ms (@2–4), heap-blit 7–21,
    mount-walk Σ 2–13, stdlib-verify 7–11, reset-image 9–31; sup snap-read
    86–191 (@31–65 MB) FULLY shadowed (exec snap-wait-header 0 ms,
    snap-wait-heap 0.2–0.5 ms). file_data knife held: `all` capture/restore
    heap 65.4 MB (was 78.5 pre-knife).
  - OPFS at rest: all.snap 62.4 MB · numpy+matplotlib 43.25 ·
    numpy+pandas 43.25 · numpy 30 · stdlib 30 (numpy ≈ stdlib-sized —
    look at this during the set-consolidation pass).
- **`PY_LIMITS.idleTeardownMs` is 15_000; the re-decision is now UNBLOCKED**
  — the re-recorded ledger above is the data the deferral was waiting on
  (restores 209–423 ms boot across sets). The owner's declared direction for
  the executor lifecycle (first-run-before-capture, longer-or-no idle
  window, a 1→N executor model with instant terminate replacing the blit
  reset) lives in Open items — expect this knob to move with that work, not
  alone.
- **Earlier landed phases** — P2 owned dense snapshots (Session 15) and
  P1.5 DSO grouping 67→4 (Session 14) are current-state documented in the
  CLAUDE.mds; their stories, blockers, and ledgers live in the phase log
  below. The P2 restore ledger (stdlib 193 / numpy+pandas 828 / `all`
  1,123 click→ready) is the baseline the 2026-07-29 ledger above compares
  against.

- **Toolchain:** Pyodide **314.0.2** / CPython **3.14.2** / emsdk **5.0.3** /
  ABI `2026_0`, **MAIN_MODULE=2** closed world (see next section). Image
  `pyodide/pyodide-env:20260211-chrome145-firefox146-py314` (digest pinned in
  `build.config.json`). Glue is **`pyodide.asm.mjs`** (ESM; renamed from
  `.asm.js` in 314).
- **buildHash history:** `267194ca75197030` (P2 rotation, committed
  `af14670`) → `f440369a4275be9a` (cold-restore attack rev) →
  `e210f3a9a140f04b` (dead-on-import stdlib sweep) →
  **`7fdf68788eb8a2a4`** (2026-08 perf batch, current).
  Commits: `c6db3ea` (P0 trace+ledger), `479b0f0` (P1 Loop A rebase),
  `8653e84` (P1 Loop B flip + lock + seed), `cb53dd4`/`44fd725`/`ae5806b`
  (P1.5 Steps 0–2), `284d8a1`/`af14670` (P2), `630b17f`/`f332d90`/`ba23635`
  (cold-restore attack).
- **Sets:** `{stdlib, numpy+pandas, numpy+matplotlib, all}` — stdlib is
  the implicit no-bundle set; the other three are `build.config.json` `sets`.
  The standalone `numpy` set was DROPPED 2026-08 (`import numpy` rides
  `numpy+pandas`; PySetKey/PACKAGE_TO_SET regenerated at stage).
  sqlite3 is **static in the main module** (314 upstream) — its old wheel,
  bundle, and standalone set are gone; `import sqlite3` works on every set.
  `PySetKey` is codegen'd by `stage.mjs` into `py-stdlib-modules.gen.ts`
  (py-protocol re-exports it type-only); `bundlesOf`/`resolveImports` are
  fail-closed on unknown keys.
- **Snapshots are OWNED (P2): AVS2 dense container, client-captured,
  OPFS-only** at `opfs:/py/<buildHash>/<setKey>.snap` — nothing crosses the
  wire TODAY, but that is the current implementation, not a design
  commitment: build-time capture + shipping the snapshot as a served
  artifact (the baseline.snap lineage) is still under active owner
  consideration (see Open items). Layout `[u32 magic 'AVS2'] [u32 headerLen]
  [u32 heapLen] [u32 crc32(headerJSON)] [header JSON zero-padded so
  heapOff = 16 + alignUp(headerLen, 4096)] [dense heap …EOF]`; header
  carries buildHash/setKey/buildId/dso bases/dsoHandles/hiwire/
  tableLenAtCapture/heapHash(xxh32). Parse cross-checks everything incl.
  `fileSize − heapOff == heapLen`; heap first + header LAST on write makes
  torn writes structurally invalid; ANY failure → delete → cold (self-heal
  proven live). Codec + OPFS store live in `web/src/core/py/py-snapshot.ts`;
  restore driver in `py-loader.ts`. The old AVS1 sparse codec / `PackedTree`
  / LRU / SHA-256 trailer / baseline.snap / make-baseline / verify-stacking
  are all DELETED (P2). Stale-buildHash OPFS dirs GC on the write side's
  first touch.
- **Live fork patches:** pyodide `0001` (linkflags/memory/exports — the
  Loop-B link model; EXPORTED_RUNTIME_METHODS now also carries `growMemory`
  (the preBlit pre-grow — upstream INITIAL_MEMORY resize is a NO-OP against
  this glue, memory is wasm-exported) + the dylink trio
  `LDSO,newDSO,loadWebAssemblyModule` (closure-internal otherwise; 0005 reads
  them off Module) + `callMain` (cold-restore rev — the uniform-boot driver's
  deferred cold main); since 2026-08 also
  `-Wl,-u,__em_js__getWasmTrampolineModule` (the trampoline fix — see
  learnings), `-lzstd`, and `OPTFLAGS=-O2` carrying the measured ship
  verdict), `0003` (drop C extensions; 314 upstream now disables
  pwd/_ssl/_hashlib/_uuid itself and adds static `_hmac`+`_sqlite3`, both
  kept; we add `_zstd`; `_lzma` stays disabled), `0005` (AVLO DSO replay API
  on dynload.ts: get/setDsoLoadInfo, loadDynlibReplay — now accepting
  `Uint8Array | WebAssembly.Module` for precompiled replay —
  restore/recordDsoHandles, dsoReplayDone), `0006` (drop loader machinery),
  `0007` (owned-restore seam: `_avloRestore.preBlit` + noInitialRun; upstream
  prepareSnapshot/makeSnapshot/restoreSnapshot DELETED; serializeHiwireState/
  getExpectedKeys/syncUpSnapshotLoad1/2 kept; + installStdlib
  `writeFile {canOwn:true}` — the stdlib zip buffer is adopted, not copied),
  `0008` (js-bridge closure), `0008b` (expected-keys = the REAL 5-entry boot
  table), `0009` (fork API types — `declare static _module`/`_api` on
  PyodideAPI_ + Module runtime exports + typed preBlit seam, so the emitted
  d.ts types the app surface; type-only, wasm byte-identical; consumed by
  stage.mjs → `web/src/core/py/pyodide-fork.gen.d.ts`). **NEW cpython lane**
  (2026-08): `patches/cpython/*.patch` staged into pyodide's
  `cpython/patches/` ≥0010 by build.sh (lane change nukes cpython
  build+installs — BOTH, see learnings); first occupant `0010` trampoline
  arity reorder (2,3,1,0 — the 2-arg wrapped forms first).
  **One emsdk patch:** `0006` dsoBaseHook (record/replay of DSO
  memBase/tableBase in loadWebAssemblyModule + v2: postInstantiation SKIPS
  `__wasm_apply_data_relocs` + `__wasm_call_ctors` under replay — the heap
  blit supplies their capture-time effects; running them pre-blit against the
  fresh heap FAULTS on grouped-module init). `patches/parked/` is gone.
  Patch-edit flow is git-native — see the learnings entry.
- **Wheel patches (all re-derived against current wheels):** matplotlib
  0001 rc-backend-agg / 0002 pillow-ectomy / 0003 lazy-plistlib; pandas
  0001 no-toplevel-ctypes / 0002 lazy-ctypes-interchange; dateutil 0001
  quiet-pruned-tzdata; seaborn 0001 lazy-urllib / 0002 pydoc→inspect.
  Wheels: numpy 2.4.3, **pandas 3.0.2**, matplotlib 3.10.8, seaborn 0.13.2
  (URL-pinned — absent from the stock lock), pillow/fonttools traceOnly.
- **Serving:** `workers/py` (brotli siblings + edge cache) and the SW
  verify-at-FILL routes are current-state documented in
  `web/src/core/py/CLAUDE.md` ("Serving & caching") + the
  `workers/py/src/index.ts` header. Timeline notes that matter here: the
  edge cache (synthetic per-encoding-class keys) SUPERSEDED the earlier
  "no edge cache, variant poisoning" stance; the marked-hit pristine
  HTTP-cache identity exists so **V8's disk wasm code cache** can engage
  for `pyodide.asm.wasm` (the old every-hit re-verify's synthetic Response
  defeated it; engagement itself still unmeasured — Open items).
- **Figures pipeline** (client, landed pre-redesign): `py-figures.ts`
  `placeRunFigures` — see the file-table row in `web/src/core/py/CLAUDE.md`
  (assetId dedup, create-only, undo-tracked figure transacts vs the
  non-undo-tracked output commit).
- **Docs: REWRITTEN current-state (Session 17).** `web/src/core/py/CLAUDE.md`,
  `packages/py-build/CLAUDE.md`, and `packages/py-loader/CLAUDE.md` are full
  rewrites with the interim banners gone — present-tense L2/owned-snapshot
  state only (no baseline.snap, no snap-probe, no pyDevStatic, no sqlite
  bundle). THIS file stays the home for history, ledgers, and learnings;
  the CLAUDE.mds carry none of it.

## MAIN_MODULE=2 closed world — how the link works (load-bearing)

The design that survived Loop B's two boot failures. Anyone touching the link
line, exports, or DSO handling must understand this:

- **DSOs are deliberately NOT on the main link line.** `fetch-wheels.mjs`'s
  link-sos block scans the **grouped side modules** (`dist/groups/<bundle>.so`,
  4 DSOs since P1.5 — hard-error if any is missing, no wheel fallback;
  1,761 func/global/tag symbols, `invoke_*` excluded)
  and emits `.cache/link-sos/link.rsp` = one `-Wl,--export-if-defined=<sym>`
  per symbol. `build.sh` force-relinks when link.rsp is newer than the built
  glue (it is @-consumed but not a make prerequisite). That reproduces the only effect we need from emcc's
  `process_dynamic_libs` (main-defined DSO-needed symbols survive metadce as
  exports) while cross-DSO symbols keep resolving lazily at dlopen.
- **Why not the obvious ".so files on the link line":** wasm-ld applies the
  ELF shared-def-beats-weak rule — a dylib's strong exports (kiwisolver's
  C++ `basic_stringbuf` dtors) preempt main's own weak COMDAT
  instantiations, turning them into hard startup GOT imports that
  `reportUndefinedSymbols` throws on before any bundle can mount. Not
  fixable with `-u` sweeps or `--whole-archive -lstdc++` (emcc maps
  `-lstdc++` to nothing; the symbols aren't in libc++.a).
- **No-EXPORT_ALL Module surface:** dropping `EXPORT_ALL` requires
  re-providing what the JS runtime reads off `Module`:
  `EXPORTED_RUNTIME_METHODS` = upstream's curated DISABLE_DYLINK list +
  `UTF8ToString,getPromise,promiseMap`; `EXPORTS` += `_dlerror` +
  `_emscripten_dlopen_promise` (musl dynlink.c — not KEEPALIVE-annotated).
  When changing exports, enumerate every `(Module|#module).prop` access
  across the fork's `src/js` against the built wasm's export list.
- **Tripwires:** `ERROR_ON_UNDEFINED_SYMBOLS=1` at link; 5.0.3's named
  runtime throws on both unresolved surfaces; corpus (all 7 groups) is the
  closed-world proof — every DSO dlopens, zero stub throws.
- **Numbers (Loop B vs Loop A / 0.29 — pre-2026-08 values; the trampoline
  `-u` + `_zstd` re-add moved wasm to 7,238,773 B raw, the within-row
  comparisons stay valid):** wasm 6,858,149 B (−13.8% vs Loop A's
  7,952,003; 0.29 was ~7.47 MB), exports 1,013 (Loop A EXPORT_ALL: 8,015;
  0.29: 9,651), glue 343,521 B (−60% — DSOs on the line had dragged ~290 KB
  of JS-library stubs in via `DEFAULT_LIBRARY_FUNCS_TO_INCLUDE`), GOT
  imports 0. Stdlib zip: 487 entries / 85 pruned / 29 tombstones; 77
  builtins incl. `_sqlite3`.
- **Build mechanics:** full Docker build **1,208 s** on the 2-core WSL2 pin
  (~9 GB RAM box — keep jobs at 2); incremental main-link rebuilds **~19 s**.
  `run-build.mjs` skips cloning when `.work/pyodide/.git` exists — changing
  the pyodide tag requires `rm -rf .work/pyodide`. Image digest is
  drift-checked: clear it to `""` when changing the image ref.

## Trace ledgers (phase gates measure against these — do not lose)

Trace plumbing lives in `py-trace.ts` (mechanics in the web CLAUDE.md file
table). Ledger-reading reminders: `window.__avloPyTraces` (DEV) is the
automation read surface (100-line ring); span meta key `n` is FORBIDDEN
(clobbers the span name — see learnings).

**Span glossary (cold-restore rev — the current ledger keys):**
- sup: `spawn` (worker construction → boot-prep posted — SEMANTIC CHANGE vs
  pre-L2 ledgers: no longer contains the bundle wait) · `glue-preflight` ·
  `bundles {count}` · `snap-open {hit}` (post-snapOps-chain open + parse) ·
  `snap-read {mb, aborted?}` (chunked read + fused hash, pre-transfer) ·
  `boot-wait` (boot-prep posted → exec-ready) · `req-to-dispatch` · `run` ·
  `opfs-write {mb}` (capture persist; still lands in the NEXT emit's line —
  known quirk, kept).
- exec: `glue-import` · `boot-pyodide` (wraps glue-import + load-pyodide —
  the only span that also covers the DirtyRestoreError in-worker second
  boot) · `load-pyodide` (contains the preBlit driver:
  `snap-wait-header {hit}` · `dso-replay {count}` · `snap-wait-heap
  {touchedMB}` · `heap-blit {mb}`) · `mount-walk {bundle}` · `mount-dlopen
  {bundle, dsos}` (cold only) · `stdlib-verify` · `post-restore` · `dso-free
  {mb, aborted?}` (cold only) · `capture-imports` · `capture-snapshot` ·
  `harden` · `harness` · `reset-image {mb}` · run-side `run-python` /
  `figures` / `blit {mb}` / `post-run-reset`. DSO precompile time shows in
  the wasm-timer aggregates (`compile` entry), not as its own span. DEAD
  span names: `mount-extract`, `snap-probe`, `heap-read` (pre-L2 ledgers)
  and `mount` (Session-17 cleanup — it was a byte-duplicate wrapper of
  `mount-walk`; Session-16/17 trace lines still contain it). Sup boot `path`
  labels: `restored OPFS snapshot` / `cold boot + capture (no valid
  snapshot)` / `cold retry (snapshot poisoned)` (Session 17 — the noSnapshot
  poison retry no longer mislabels as "snapshots off").

**P0 baseline — OLD 0.29.4 fork with client snapshots, buildHash
`01ba07e1133d0342`** (dev board: Chrome, local miniflare, no SW, WSL2). The
redesign targets table compares against these:
- stdlib, baseline restore (Cache API hit), cold page: click→ready **419 ms**
  = sup spawn 88 + spin-up ~51 + exec boot 279 (load-pyodide 186, post-restore
  54, harness 16).
- all, OPFS stacked hit, cold page: click→ready **1224–1252 ms** = sup spawn
  360–382 (opfs-read 191–196 @107 MB · sha-verify 106–135 · sparse-reconstruct
  25–29) + exec boot 803–877 (tree-write 104–108 @1553 files/40 MB ·
  **dso-replay 428–464 @67 DSOs, of which only 108–115 ms is real wasm
  compile+instantiate — ~75% of the replay span is glue-side GOT/merge
  bookkeeping**, the P2 incremental-GOT target · reset-image 20–24 @75 MB).
  Warm run 29 ms (python 12 · blit 8.6 · post-run-reset 6.9).
- all, client generation (OPFS miss): click→ready **4588 ms** (mounts
  Σ≈1518 ms — pytz alone 334, many-small-files extractall · capture-imports
  1777). This path is deleted; kept for the before/after story.
- Executor worker spin-up costs 35–51 ms per generation (boot-wait − bootMs).
- These are no-SW dev numbers; the 2026-07-29 preview ledger (Current
  state) is the SW-active successor.

**P1 cold-boot ledger — CURRENT build `58ae9021763d19f0`, every boot
`path=cold boot (no snapshot)`. THE P2 baseline** (dev, no SW, local R2;
click→ready = sup reqToReadyMs, exec boot in parens):
- **stdlib 574 ms** (451: load-pyodide 392 · stdlib-verify 8 · post-restore 16
  · harden 1 · harness 7 · reset-image 21 @31 MB)
- **numpy 1030** (624: +mount 206 @1 tar)
- **numpy+pandas 1341** (1168: mount 200 @4 tars, bundles-fetch 126)
- **numpy+matplotlib 1472** (1025: mount 179 @5 tars)
- **all 1854** (1362: mount 197 @7 tars, bundles-fetch 150)
- load-pyodide is a steady ~360–395 ms every boot (main compile + instantiate
  + CPython init). Context: old `all` OPFS-restore was 1224–1252 and old cold
  generation 4588 — pure cold mounts (1854) sit between; P2 restores attack
  the remaining gap.

**P2 mid-phase verification (2026-07-22 second-opinion pass — durable
residue only; the full census is regenerable via `dsos:check` /
`analyze-dsos`, and the levers it flagged all landed in Session 16):**
- Grouped DSO world: **zero side→side imports** (every env/GOT import
  resolves to main, self, or JS `exit`), dylink.0 = 9 bytes per group
  (`needed=[]`), elem-segment table slots 12,940.
- Replay-relevant JS link work ≈ **30 ms** of a Σ118–124 ms cold 4-group
  dlopen (table-map ~17 · GOT scans ~3 · Global traffic ~8) — why
  dso-replay @4 runs in the tens of ms where the 67-DSO world took 428–464.
  `convertJsFunctionToWasm`: 0 during mounts (1 known preRun trampoline in
  main boot — pre-2026-08: the wasm-gc trampoline fix adds a second preRun
  `addFunction`).
- `all` owned capture: tableLenAtCapture 21,526 (pre-2026-08 value —
  capture-relative, re-derives on the next capture; the extra preRun
  `addFunction` shifts it); zero pages only 12.5 %
  @64 KiB (why dense AVS2 stands, no sparse encoding); fused xxh32 ≈ 28 ms.

## Security model (durable decisions + residuals)

The authoritative current-state write-up is `web/src/core/py/CLAUDE.md`
("Security invariants") — scrub/harden/fail-closed-assert layering, the
five-leg verification chain, never-auto-run. What this file adds is the
decision record and the accepted residuals:

- **Same-origin worker, no sandboxed iframe, is OWNER-SETTLED** —
  `scrubWorkerScope()` is THE authority boundary, not defense-in-depth;
  eval/Function stay by design (authority removal, not code-execution
  prevention). Don't re-litigate without new data.
- **`assertRealmHardened()` is fail-closed by design** — never let a scrub
  become a silent no-op.
- **Open residuals (accepted/deferred, do not rediscover):** (1)
  first-load-without-SW TOCTOU vs an ACTIVELY malicious origin — unclosable
  without a worse trade (`script-src blob:`); every realistic corruption
  fails closed. (2) MEMFS file mutations survive blit resets — a planted
  `_avlo_pruned_*.py` can be re-imported across runs within one generation
  (authority-free, contained); real fix is P3 WasmFS (FS rides the heap
  image, blit resets it). (3) `subprocess`/`multiprocessing` are blocked by
  wasm-syscall absence, not policy.

## Hard-won learnings (do not re-derive)

**Replatform phase 1 (Session 21):**
- **pyc bytes are a function of the COMPILING PROCESS's import history.**
  Marshal writes interned-string state (flag bits + pointer-identity ref
  sharing), and whether equal strings are interned depends on what the
  process imported before `compile()` ran. Proven flip: compiling stdlib
  `argparse.py` (same source, same seed, same interpreter) yields different
  bytes before vs after `import argparse`; porting the pack scripts into a
  CLI that imports argparse/pydantic shifted exactly `argparse.pyc`,
  `typing.pyc`, `importlib/metadata/__init__.pyc` — precisely the
  newly-imported modules, nothing else (sensitivity is value-specific and
  self-import-shaped; enum/inspect/dataclasses imports shifted nothing).
  The committed lock's bytes therefore ENCODED the legacy scripts' import
  lists — a refactor-shaped time bomb. Durable fix: every artifact pyc
  compiles in `_pyc_worker.py` subprocesses whose import surface is FROZEN
  (the legacy pack-script set, asserted PYTHONHASHSEED=0); the worker's
  import list is part of the artifact definition — never "clean it up"
  outside a planned rotation.
- **UNCHECKED_HASH pycs still embed the 8-byte source hash** — "unchecked"
  is about import-time validation only. One comment character in a
  generated registry source changes shipped bytes ⇒ rotates buildHash;
  that's why the `# GENERATED by pack-*.py` strings stay frozen at their
  legacy names until the next deliberate rotation.
- **Turbo hashes gitignored files named by explicit `inputs` globs**
  (verified on 2.10.12 with a probe task: edit → miss, unchanged → hit).
  This is what lets dist/raw, dist/groups and .cache/trace be graph inputs
  while the docker lanes stay manual. Corollary: keep `.br` siblings OUT of
  input globs (compress outputs would self-invalidate consumers).
- **Python brotli ≠ node brotli byte-for-byte, and it doesn't matter**: .br
  bytes are transport-only (never in the lock — clients verify DECODED
  bytes; publish freshness is mtime; budgets have headroom). Sizes came out
  marginally SMALLER under the python binding at q11.

**2026-08 perf batch (Session 19):**
- **The wasm-gc trampoline was DEAD in every shipped build — root cause +
  fix:** patch 0001's MAIN_MODULE 1→2 flip left
  `emscripten_trampoline_wasm.o` — whose ONLY content is the
  `getWasmTrampolineModule` EM_JS, referenced from JS alone, never from C —
  unreferenced at link, so wasm-ld never pulled the archive member and the
  jsifier never emitted the EM_JS into the glue. `getPyEMTrampolinePtr()`
  swallowed the ReferenceError and returned 0, silently and forever: every
  METH_NOARGS/O/VARARGS call + getset access round-tripped wasm→JS→wasm
  (10,367 `table.get` crossings /10k calls; fixing it = meth −48% /
  json −11%, same-policy interleaved). Fix:
  `-Wl,-u,__em_js__getWasmTrampolineModule` in MAIN_MODULE_LDFLAGS — this
  `-u` extracts ONE defined symbol from ONE archive member and is NOT the
  forbidden "-u sweep" (promoting weak refs across the DSO import union —
  different mechanism, still forbidden). TWO permanent gates so this class
  of bug can never be silent again: stage.mjs prestage occurrence count
  (≥2 in the glue) + the harness pre-harden own-property `wasmTable.get`
  census (≤16 crossings /10k). Snapshot-safe by construction: the preRun
  hook runs on EVERY boot (cold + restore), `addFunction` mints the same
  index both sides, `tableLenAtCapture` asserts are the tripwire.
- **`grep -c` on minified glue LIES** — it counts lines and both trampoline
  occurrences share one line; count with `grep -o X | wc -l` (stage.mjs
  splits on the needle). Cost a full false-regression investigation; the
  `EMCC_DEBUG=1` emcc-NN-*.js artifact chain is the debugging tool if a
  real emission failure ever appears.
- **Bench discipline: pin the CPU boost policy for the WHOLE session and
  stamp it in the ledger line.** A mid-session Windows processor-boost
  shift (efficient-aggressive → …-at-guaranteed → aggressive; ~2.9 vs
  ~4.2 GHz) contaminated every absolute number and manufactured a fake
  "~30% -O3 win" — the clean same-policy interleaved A/B read ~0–3% ⇒
  **-O2 stays**. Only `*-agg-*`/`V1-ship-agg` rows in
  `bench/ledger-2026-08.jsonl` are clean; always interleave A/B pairs.
- **Tail-call interp: without `-mtail-call`, clang IGNORES `musttail` with
  only a warning** (confirmed 2026-08, incl. by a second remote session) —
  a "tail-call build" compiles fine and silently doesn't tail-call. Gates:
  `ceval.o` must carry `tail-call` in its `target_features` section (the
  FINAL linked wasm carries NO target_features — check the object, not the
  binary), and a Py_TAIL_CALL_INTERP=1 build that BOOTS proves real tail
  calls (fake ones nest a wasm frame per dispatched bytecode and overflow
  the engine stack almost immediately). The clean 2026-08-03 redo (gate
  passed, real tail calls) REJECTED variant 0: geomean +25% steady-state
  regression AND worse under Liftoff — V8's per-bytecode
  `return_call_indirect` path is just slow. Mechanism (V8 design doc +
  measurements): wasm tail calls shine for DIRECT, signature-matched,
  register-resident calls (the fib self-call ideal); variant 0 is the
  opposite — indirect through a 231-entry table with a wide shared
  signature, paying table-bounds + signature check + frame bookkeeping per
  dispatched bytecode where the megafunction pays one `br_table` branch
  with everything live in locals (fib_rec +48% was the worst probe —
  Python-level recursion hammers dispatch hardest). **Companion finding
  (remote session 2026-08-03, mechanism reproduced locally on V8 13.6):
  V8 compiles wasm LAZILY by default** — `WebAssembly.compile` of the full
  7.24 MB module is ~13–20 ms (decode+validate only; ~72 ms forced eager);
  function bodies compile on first call. It does NOT rescue variant 0:
  probe boots are fresh processes and bootMs was flat-to-worse (CPython
  init touches nearly the whole dispatch surface before any user code),
  steady state is paid every run, and the app amortizes first-touch
  compile anyway (snapshots + Chrome's disk wasm code cache). Kit +
  protocol: `bench/v3-tailcall-patches/README.md`.
- **Interpreter-dispatch perf verdicts do NOT transfer across builds or
  hosts (Session 20, `bench/tailcall-bridge/README.md` — the PR #16
  cross-verification):** the SAME variant-0-vs-goto A/B, same 11-benchmark
  suite, same V8 binaries, inverts between builds on one machine — fork
  +23–25% slower (both engines, and unchanged under `--no-liftoff` pure
  TurboFan) vs stock-standalone 7–17% FASTER on Zen 2 — and flips again
  between hosts on the same standalone build (Zen 2 0.83 vs the remote
  Xeon 1.02 geomean, V8 14.6). Mechanism: **tail-call dispatch runs at
  the same absolute speed in both builds** (fib 25.8 vs 26.4 ms) while
  **the fork's goto baseline is ~2× faster than stock CPython's
  emscripten build** (fib 17.4 vs 34.3 ms; unbisected suspects:
  `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` vs default JS-based EH,
  MAIN_MODULE=2 + the pyodide link recipe) — so "variant X wins N%" is
  meaningless without naming the baseline build; the remote's +20–27%
  variants-3/4/6 wins are against headroom the fork already banked.
  Emitted dispatch shape does NOT explain any of it (opcode censuses
  match: fork v0 1146 direct/300 indirect `return_call` vs standalone
  1248/302). Also verified: stock 3.14.2 cannot even build variant 0
  under emscripten (`preserve_none` hard-errors; PR #6122's 0010 patch or
  our 0011 is required). Rule: dispatch-style A/Bs are only valid in the
  fork lane, interleaved, on ≥2 uarchs.
- **-O3 structural hazard (remote session 2026-08-03; reversion already
  stood on flat perf):** -O3 barely touches the eval loop (78,942 →
  78,485 B) but inlining mints a NEW 157,736 B function — 2× the
  megafunction — while code section grows 4.06 → 4.32 MB. Under lazy
  compilation that is a first-call latency spike on whatever path calls
  it, and `check-budgets.mjs` cannot see per-function shape. -O2 stays;
  `bench/builds/v2-o3-ref/` retained for reference.
- **`PYTHONMALLOC=mimalloc` REJECTED on data:** perf ±5% noise, heap
  54→96 MB (+42 MB in every snapshot + resetImage). Do not set it.
- **cpython lane rebuilds nuke BOTH trees:** build.sh removes
  `cpython/build/Python-3.14.2` AND `cpython/installs` on any lane change —
  make links against the INSTALL tree, so nuking only build/ silently
  relinks stale libpython (bit us once). A Makefile.envs-only change
  (e.g. OPTFLAGS) triggers NEITHER — nuke manually or you A/B stale
  objects against a fresh flag line.
- **Full cpython nukes are NOT byte-reproducible** (found 2026-08-03: two
  identical-source -O2 builds differ by 13,912 scattered bytes at the SAME
  7,238,773-byte size — address-constant immediates shifted by small
  deltas, i.e. a data-segment layout shift; the raw stdlib zip differs too
  (pyc headers embed extraction-time mtimes), and BUILD_ID follows the
  wasm. Suspects: readdir/archive-order-dependent link inputs or an
  embedded `__DATE__`/`__TIME__`; unrooted — Open items). Consequences:
  byte-size equality is NOT byte equality (the earlier "byte-size-identical
  revert" comparisons proved nothing); expect a buildHash rotation on ANY
  cpython nuke even with identical sources; `bench/builds/v1-ship/` holds
  the exact bytes behind the current lock — restore from it rather than
  re-rotating for a semantically identical rebuild. JS-side outputs
  (glue, d.ts) ARE reproducible.

**Cold-restore attack (Session 16 — the L1/L2 mechanics):**
- **Direct MEMFS node creation facts (this glue, verified):**
  `MEMFS.createNode` delegates to `FS.createNode` → `FS.hashAddNode` (the
  nameTable insert is done for you) and ITSELF sets
  `parent.contents[name] = node` + stamps parent/node times — a walker must
  duplicate neither. Nodes carry split `atime`/`mtime`/`ctime` ms fields —
  there is NO `node.timestamp` on 3.1.45+ glue (older docs lie).
  `MEMFS.node_ops.lookup` ALWAYS throws (nameTable is the only lookup path),
  so probing `parent.contents` for dir reuse is safe and REQUIRED: bundles
  share prefixes (`.avlo/`), and re-creating an existing dir node orphans its
  children — the ONE bug the bench parity diff caught. `os.listdir` order =
  contents insertion order = tar order.
- **Deferred `Module.callMain()` is safe on this glue (receipted + proven):**
  with noInitialRun the factory resolves pre-main; `preMain` is empty,
  `postRun` drains nothing (no registrations), main's C-side runtime
  keepalive makes its exit tail self-contained — but a keepalive-less exit
  lands in `Module.exitCode` (Stage-5's check saw undefined pre-main), so the
  driver re-checks it after callMain (F4). The harness's uniform cold boot +
  identical hiwire expected-keys table is the standing equivalence proof.
- **The dirty boundary is the first `loadDynlibReplay` call:** pre-mutation
  failures (buildId/grow/compile) may cold-boot the SAME Module; from replay
  on, LDSO/table/GOT hold replay state a later cold dlopen would registry-hit
  (orphaned exports over a fresh sbrk) — mutation-zone failures MUST
  re-instantiate (`DirtyRestoreError`).
- **Why mounted files must exist even though restore never dlopens them:**
  CPython's ExtensionFileLoader fopen+fstats the path BEFORE dlopen
  (dynload_shlib.c); the C dlopen then short-circuits at `find_existing`
  (LDSO registry — heap state the blit restores). The old "stat/reads them
  from MEMFS" comment was the wrong mechanism. Corollary: restore boots never
  re-malloc `file_data`; only cold boots do — which is why the file_data
  knife is cold-only and shrinks the CAPTURE.
- **dso struct offsets (emsdk 5.0.3):** `HEAPU32[(h+28)>>2]` = file_data,
  `+32` = file_data_size (loadLibData writes +8 flags/+12 memBase/+16
  memSize/+20 tblBase/+24 tblSize). Knife sanity-checks and aborts itself —
  never the boot — on drift.
- **Macrotask-yield traps:** setTimeout(0) hits the 4 ms nesting clamp past
  5 levels — use MessageChannel (unclamped, shares the message task source so
  worker onmessage interleaves fairly). Under Node, a module-scope
  MessageChannel either pins the event loop open (ref'd) or lets the process
  exit MID-AWAIT (unref'd — "unsettled top-level await"); use setImmediate
  there (unclamped + ref'd-while-pending). Function-local channels that close
  after use are safe in both.
- **Pre-touching grown wasm pages must be a value-preserving RMW**
  (`Atomics.or(i32, off>>2, 0)`): replay already wrote active data segments
  at forced memBases inside the grown region — a zero-write clobbers them, a
  plain read can be dead-code-eliminated (and commits only read mappings).
- **`WebAssembly.compile` COPIES its input** — precompiling off adopted tar
  subarrays is safe; a precompiled Module flows through
  `loadWebAssemblyModule`'s three Module fast-path sites with zero
  revalidation; Modules are reusable across instantiations.
- **Detached spawn-task discipline (the F1–F17 model):** capture
  worker+token+gen per task; every post is a synchronous
  `if (!live()) return; w.postMessage(...)` pair; teardown bumps the token
  AND mutes `onmessage` before `terminate()` (already-queued messages from a
  dying worker otherwise still fire); span closers are token-guarded (a stale
  closer lands in the NEXT boot's trace line); posting to a terminated
  captured worker is benign. Serialize snapshot-file mutations on a per-set
  promise chain that reads AWAIT — deletes and probes race otherwise (U6).

  **Tag glossary** (the codes `core/py/` comments cite — reconstructed
  2026-08 from the citing sites; F8/F12/F17 and U5/U7-U9 were retired or
  folded during the session-16/17 rework and no longer appear in code):
  - **F1** — every detached task captures `w`/`token`/`gen`, never module
    vars; posts only behind a synchronous `live()` check.
  - **F2** — teardown/supersession bumps `spawnToken`; stale tasks go inert.
  - **F3** — mute `worker.onmessage = null` BEFORE `terminate()`.
  - **F4** — cold-main failures do NOT wrap in `DirtyRestoreError`; running
    cold over an ABORTed runtime is forbidden (py-loader.ts:144).
  - **F5** — a `DirtyRestoreError` retry boots WITHOUT the snapshot feeds:
    retrying the same failing cold boot would loop (py-executor.ts:319).
  - **F6** — every executor-side await has a guaranteed sup-side completion
    signal (boot-data / snap-header / snap-heap / teardown).
  - **F7** — the executor parks boot feeds in module-scope deferreds; any
    arrival order is legal (py-supervisor.ts:455).
  - **F9** — poison-deletes only off a LOCK-HOLDING open rung; the buffered
    getFile rung may see another tab's mid-write bytes (py-snapshot.ts:296).
  - **F10** — all snapshot-file mutations ride the per-set `snapOps` chain;
    reads await its head.
  - **F11** — pre-touching grown wasm pages must be a value-preserving RMW
    (`Atomics.or(x,0)`) with MessageChannel yields (py-loader.ts:72).
  - **F13** — download-progress posts are live()-guarded (py-supervisor.ts:232).
  - **F14** — span closers are live()-guarded (stale closer → wrong trace line).
  - **F15** — transferred buffers are nulled at the post site, never retained.
  - **F16** — `gen.snapAbandoned`: after exec-snap-invalid the executor
    provably never awaits snap-heap; in-flight T3 reads stop posting.
  - **U4** — exec-snap-invalid ⇒ delete only, NO respawn (the cold boot's
    capture re-persists).
  - **U6** — a restored generation's first-run hard failure poisons the
    snapshot file BEFORE the eager respawn, chained on snapOps.
- **git-native patch editing:** re-stack `.work/pyodide` one-commit-per-patch
  via `git checkout <commit>` → edit → `commit --amend` → cherry-pick the
  rest (non-interactive), then regenerate each edited patch's diff body
  (`git diff parent commit`) and splice under the kept header; verify by
  replaying the whole queue from the tag and diffing against the restacked
  tree (`TREE IDENTICAL`). Never hand-edit a unified diff.

**Snapshots / capture (P2 honors all of these):**
- **postInstantiation runs a DSO's `__wasm_apply_data_relocs` +
  `__wasm_call_ctors` IMMEDIATELY when `runtimeInitialized`** — true during a
  pre-blit restore (noInitialRun skips only `main()`), and grouped-module
  init code READS captured-heap state → OOB fault. emsdk 0006-v2 skips both
  under `dsoReplay` (the blit supplies their capture-time effects; they must
  not defer either — the deferral queues never drain post-init). Everything
  else in postInstantiation (updateTableMap/relocateExports/updateGOT/
  reportUndefinedSymbols) must keep running — that is the JS/table state the
  blit cannot supply.
- **Capture at the pre-harden slot, never at ready** — post-harness capture
  would bake installed-harness/armed-hook state and force an untested
  double-install on restore; pre-harden capture lets restore rebuild the tail
  (harden → hooks → harness → resetImage) identically to a cold boot.
- **Table determinism holds on real boots**: `updateGOT` addFunctions every
  non-internal export of every module at its instantiation, so imports are
  table HITS — fresh-boot `wasmTable.length` equals the recorded first
  tableBase and post-replay equals tableLenAtCapture (asserted hard; the
  emsdk drift-throw never fired across the whole board).
- **Expected-keys on 314.0.2 = `[null, public_api, API, scheduleCallback,
  API]`** (5 entries; upstream's 7-entry list was wrong post-0008) — hiwire
  slot expectations are **boot-allocation-order empirical**, not derivable;
  confirmed via `__hiwire_get` walk, and the harness dumps the live table on
  any mismatch so a future boot-sequence change re-derives in one command.
- **Zombie-executor interrupt steal (HISTORICAL since the 2026-08 disarm):**
  `Worker.terminate()` on a wasm busy loop closes ports but the thread spins
  until its next yield and keeps consuming SIGINT from a shared interrupt
  SAB — the next executor's first interrupt vanishes. The P0-B-era fixes
  were fresh SAB per spawn + 50 ms SIGINT repeats. The interrupt is now
  never armed (the armed signal check taxed every run 2-4.5%; cancel =
  immediate kill + eager respawn), so only the fresh-SAB-per-generation half
  survives (generation state isolation). If real cancellation ever re-lands
  on the signal path, BOTH fixes apply again.
- **numpy 2.x defers `numpy.random`:** `import numpy` does not seed the
  global RandomState — capture must bake `import numpy.random` explicitly or
  every restore re-seeds at first touch (breaks run determinism).
- Capture requires **primitive-only Python↔JS traffic** — a live PyProxy
  aborts `serializeHiwireState`.
- MEMFS-era capture: read the site-packages tree back **AFTER** imports
  (import-generated `__pycache__` pycs are heap-referenced) and restore with
  mtimes (`FS.utime`); MEMFS has one ms timestamp per node.
- **Restage ⇒ recapture:** stdlib zip byte-identity is NOT covered by
  BUILD_ID — zipimport TOC offsets live in the heap. `verifyStdlibZip`
  as-mounted is the anchor; a byte-different restage rotates buildHash which
  invalidates every downstream cache.
- det-env (deterministic capture) must intercept THREE entropy/clock sources,
  found by byte-diffing: `node:crypto` randomFillSync/randomBytes (Emscripten
  PREFERS these over webcrypto under Node — a webcrypto-only shim sees 0
  draws), `Date.now` (MEMFS stamps every node), `performance.now`. Plus
  `PYTHONHASHSEED=0` via the loadPyodide env. Build-time snapshot capture
  (if pursued — Open items) is what needs this kit; per-client capture
  doesn't care about determinism.

**Toolchain / build:**
- **llvm-objcopy has NO wasm symbol support** ("only flags for section
  dumping, removal, and addition") — wasm symbol renames must happen at
  COMPILE time (recipe source patch), never post-hoc on objects.
- **wasm-ld archive members are lazy; immediate object defs shadow them.**
  Same-signature shadowing is SILENT wrong-code (only signature mismatches
  error). harvest-links' per-bundle collision gate exists for exactly this —
  never link two distinct-content strong defs of one symbol into a group.
- **pip constraints are env-global** — per-package constraint files are the
  only way to freeze legitimately-conflicting backend deps; a prerelease
  UPPER bound (`<4.0.0a0`) silently enables prerelease candidates for that
  requirement (how pandas lands Cython 3.3.0a1 while numpy gets 3.2.8).
- **Cython embeds the resolved .pxd path in its file table** — for packages
  cimporting numpy that is pip's EPHEMERAL isolated-env dir
  (`/tmp/build-env-<rand>`), churning ~31 pandas objects per rebuild; the
  harvest stash normalizes the token length-preservingly. numpy/matplotlib/
  kiwisolver/contourpy proved rebuild-stable without it.
- RandomState streams are CONTRACTUALLY frozen across numpy versions —
  corpus value pins against host numpy are legitimate and catch legacy-path
  binding regressions (n02).
- **emsdk patches are inert on incremental builds** — the top-level make rule
  has no emsdk prereqs, so a staged patch ships an unpatched glue.
  `build.sh` direct-applies missing patches, force-relinks when one fires,
  and greps an `AVLO` marker in BOTH the installed source and the built glue.
  Any future emsdk patch must embed `AVLO` in its added lines.
- Verify emsdk behavior against the **installed SDK build**, not the git tag
  — they differ (the "5.0.3 needs a stub-throw patch" plan item died this
  way; the released SDK already throws named errors).
- **Re-patching an already-direct-applied emsdk patch:** build.sh only
  direct-applies when `patch -p1 -N --dry-run` SUCCEEDS — a v2 that overlaps
  an installed v1 dry-run-FAILS and is silently skipped (unpatched glue
  ships). Reverse-apply the old patch from the installed tree first
  (`patch -R -p1 -d …/emscripten < old.patch`), then the combined patch
  direct-applies and the apply itself forces the glue relink.
- **Node harness imports of shipped TS:** type-stripping rejects
  extensionless relative imports (`./py-trace`) — run-harness.mjs registers a
  `node:module` `registerHooks` resolve fallback appending `.ts`, so the
  shipped py-snapshot/py-loader import verbatim (no tsconfig flag, no source
  churn).
- **py-trace span meta must never use the key `n`** — `{ n, at, ms, ...meta }`
  lets a meta `n` clobber the span NAME (burned once by mount-dlopen's DSO
  count; renamed `dsos`).
- **vitest `toEqual` on multi-MB typed arrays OOMs the worker** (per-element
  deep-equal diff) — compare with `Buffer.compare`.
- Wheel-patch workbench: unpack the pristine wheel twice (`a/`, `b/`), edit
  `b/`, `diff -ru a b`. **Delete `.orig` files before diffing** — fuzzy
  `patch` leaves them and they will SHIP inside the tar (caught by size once
  already). Fork patches: git-native flow — commit in `.work/pyodide`,
  regenerate the diff body, splice under the committed patch header; never
  hand-edit a unified diff. `build.sh` replays from a clean tag checkout
  (`git checkout -f` discards local commits — export before rebuilding).
- `git apply` for fork patches must run from `.work/pyodide`. Vite public-dir
  files can't be ESM-imported (why staged artifacts are always fetched,
  never imported).
- Pack scripts derive the python minor from config/`sys.version_info` (pyc
  magic is per-minor); `zipfile.writestr` with an explicit ZipInfo ignores
  the archive-level compression default — pass `compress_type` per entry.
- 0006 tree-shake trap: `dynload.ts` is reachable only via a deliberate bare
  side-effect import in api.ts — without it, esbuild drops `API.loadDynlib`
  and the whole DSO surface from the shipped glue. Standing grep gate:
  `loadDynlib` present in the built glue.
- **V8 compile-cost model (Chrome/Node defaults — budget against THESE, not
  module sizes):** wasm lazy compilation is ON (`new Module`/`compile` ≈
  validation; per-function Liftoff is paid at first call — grouped sides
  cold Σ≈40 ms lazy vs Σ246 ms eager ceiling), an in-process byte-keyed
  native-module cache dedupes identical-bytes recompiles across workers of
  one process, and `Promise.all` over eager compiles is NOT faster — a
  single module's compilation already saturates all cores.

**Packages:**
- **pandas 3.0 dropped pytz as its tz backend** — everything rides zoneinfo,
  so the `ensure_tzpath` bridge (executor runs it after every mount) must be
  up BEFORE any pandas tz op; run-corpus/trace-imports mirror that contract.
  The pytz bundle's only remaining role is the TZif database.
- matplotlib fonts: the wheel SHIPS a stale 39-face `fontlist.json` —
  `prebake-fontcache.mjs` deletes and rebuilds it over the staged subset
  faces. The 5-face subset alone sprays ~20 findfont warnings (mathtext
  probes STIX/cm fallbacks) → the 25 mathtext faces ship UNSUBSET (~0.7 MB
  br; subsetting them is glyph-index-fragile). Corpus font gates assert no
  findfont + no "generated new fontManager".
- seaborn eager-import land mines (why patches 0001/0002 exist): top-level
  `urllib.request` (pulls the pruned http stack) and `import pydoc` (trips
  the `_pyrepl` tombstone). `seaborn.objects` + `_marks`/`_stats` extras are
  pruned (PIL-dead by construction); the vendored scipy-free
  `external/kde` keeps `kdeplot` working. Package additions considered and
  settled: openpyxl deferred (needs pyexpat revert + un-prune + no
  file-ingestion path exists), xlrd rejected (.xls-only), plotly rejected
  (HTML+plotly.js output model conflicts with the js-bridge closure + PNG
  figure pipeline).
- pandas io front doors (excel/html/xml/sql/sas) are EAGERLY imported by
  `pandas.io.api` — only lazy internals are prunable.

**Environment / ops:**
- TWO dev instances collide silently: a `dev:p` launched from the main repo
  fights the avlo-parallel one (workerd binds fail; curls hit the OTHER
  checkout's workers/state → phantom 404s). Check `ss -tlnp` pids before
  diagnosing "missing" R2 keys.
- workerd (and the prod edge) normalize inbound `Accept-Encoding` to
  `br, gzip` — the identity branch in workers/py exists for br-less direct
  clients and the manifest.
- Ask the owner before starting `pnpm dev` (repo rule).

## Verification surfaces + last-green stamps

The gate board and per-script detail live in `packages/py-build/CLAUDE.md`
(Scripts table + Gate board); none run in Turbo/CI. Notes the CLAUDE.md
doesn't carry: `e2e/py-snapshot.spec.ts` needs the full `pnpm dev` stack
(Playwright webServer alone can't serve /api/py) and asserts only sup
`boot` trace labels + OPFS placement; `web/vitest.config.ts` runs the AVS2
codec unit suite (py-snapshot.test.ts, 15 tests).

- **Replatform phase-1 validation (2026-08-31, build `7fdf68788eb8a2a4`
  UNCHANGED):** the full pipeline re-ran on the new `avlo-build` + turbo
  board — staged zip + 7 tars + lock byte-identical to this build's
  committed lock, `stage --check` clean, corpus 7/7, harness 5/5, census/
  groups/pytree/trace/budgets green, pytest 9, typecheck green, local seed
  23 keys. Same bytes, new pipeline.
- **Last-green (current build `7fdf68788eb8a2a4`, 2026-08 perf batch):**
  full `pnpm board --update-budgets` green 2026-08-02 — harness 5/5
  sections (base 45 — incl. the trampoline census — · seaborn 23 ·
  snapshot 24 · verify 8 · parity 3 @1,675 entries) · corpus 7/7 ·
  pack:stdlib ×2 + bundles `--repro` byte-identical · trace:check ·
  dsos:check · groups:verify · budgets RESTAMPED (+5%; composites
  numpy-path 6.88 MB br / pandas-mpl 14.00 — still under the P1.5-era
  ceilings despite wasm +5.5%) · stage + `--check` · typecheck 12/12 ·
  test:py · vitest 15 codec · seed 23 keys. Post-stage probes: big-figure
  savefig 160 ms (L1 encoder live), `all` capture heap 65.4 MB (mpl bake
  added ~0), capture-side mpl bake 569 ms.
- **Historical last-greens:** `e210f3a9a140f04b` (dead-on-import sweep) —
  harness 5/5 (base 41 · seaborn 22 · snapshot 24 · parity 3 · verify 8),
  corpus 7/7, full restage board, typecheck, vitest, seed 23 keys,
  preview-board ledger re-recorded 2026-07-29 (Current state). P2 (`267194ca75197030`) — full board + the
  Session-15 preview browser session (cold+capture → restore → warm × three
  sets, corrupt-OPFS self-heal, teardown@15 s + respawn-restore, figures,
  marker fast-path). P1.5 (`bc46093ffa4fb5e8`) — full board, corpus 7/7 vs
  the OLD main AND the relinked main, budgets restamped (composites SHRANK
  vs 67 DSOs: numpy-path 7.29 MB br / pandas-mpl 14.41 vs 7.34/14.63).
- **Browser dev functional matrix (Gate-B-era; spot-checked since):**
  stdlib print/echo + sqlite3 `:memory:` CRUD · `import ctypes` +
  `import compression.zstd` → precise tombstones · numpy 4.0 · pandas
  groupby + `pd.read_sql` roundtrip · mpl figure placed with auto-connector ·
  seaborn scatterplot (all set) · `import requests` instant refusal ·
  cancel mid-loop · 30 s soft timeout · idle-teardown + eager respawn
  healthy.

## Open items / backlog

- **P2 owner tail (browser, at leisure):** V8 wasm code-cache ENGAGEMENT
  confirmation (repeat-reload load-pyodide deltas — the pristine-identity
  precondition is landed and storage-verified; the win itself is unmeasured)
  · multi-tab same-set concurrent restores (read-only sync handles; capture
  loser skips) · Chrome task-manager RAM (active ≈ 2× heap, idle beyond 15 s
  ≈ 0) · `import requests` refusal + cancel-mid-loop re-spot-checks (code
  untouched by P2, last green P1.5) · SW verified-route 502 negative +
  offline second-load.
- ~~The `all` restore ≤900 ms target is EXTRACT-bound — kill the
  `mountBundle` double copy~~ **DONE (cold-restore attack, Session 16):**
  the L1 direct-node walker (`py-mount.ts`) grafts trees straight into MEMFS
  from the transferred buffers (~11 ms Σ, byte-identical; harness parity is
  the standing gate). Remaining latency levers are PARKED with receipts in
  the session plan: full L3 replay-as-data (+ main GOT hook, owner-parked) ·
  standalone `.so` artifacts + compileStreaming + V8-disk-cache measurement ·
  supervisor prewarm on first code-block interaction · main-ctors skip under
  restore · reset-image blit-source RAM mode · WasmFS (P3).
- **Owner direction (declared 2026-07-29, post-ledger — the next work
  block; not yet designed, do not treat as specced):**
  - **First-run-before-capture:** a first-time execution should not wait on
    snapshot generation — run first, capture/persist after (or off) the
    first run. Measured motivation (first-visit trace): `capture-imports`
    2,189 ms rides the boot pre-ready, and the capture write landed right at
    exec-ready with ~400 ms between ready and dispatch — `writeSetSnapshot`'s
    65 MB sync chunk loop has NO inter-chunk yield (readSnapshotToBuffer
    deliberately does), so the write can block the sup event loop exactly
    when the run wants dispatching.
  - **Executor lifecycle rework:** tweak run wall-clocks + teardown
    duration; explore a **1→N executor-worker pool with instant terminate**
    replacing the blit/heap reset (isolation via fresh workers instead of
    heap rewind — and without the idle ~2× heap, the idle window could
    lengthen or go away; `idleTeardownMs` moves with this, see Current
    state). Possibly a third ephemeral worker for more boot parallelism.
  - **First-visit pipeline:** glue-preflight (real network on first visit,
    1,389 ms) serializes ahead of boot-prep; the SW-install double-fetch
    pattern shows every artifact twice in the waterfall. Room to overlap
    once the lifecycle rework lands.
  - ~~**Set consolidation:** drop or merge one of numpy-standalone /
    numpy+matplotlib~~ — DONE 2026-08: the standalone `numpy` set is gone;
    `import numpy` rides `numpy+pandas`.
  - **Build-time snapshot generation (ship, don't client-capture) — still
    under heavy consideration:** generate per-set snapshots at build time
    and serve them as artifacts (the baseline.snap lineage) instead of /
    alongside client-side capture — kills `capture-imports` (~2.2 s) and
    the OPFS write from every first visit at the cost of wire bytes. The
    det-env learnings (deterministic capture env) are the groundwork.
    Docs describe client-capture/OPFS-only as TODAY's state, never as a
    commitment — do not write "never on the wire" as policy.
  - Add/generate more types with the custom API (owner's wording).
- **Staging dir under `web/public/` (flagged Session 17, deferred):**
  `stage.mjs` stages into `web/public/py-dev/fork/`, which Vite serves
  unverified at `/py-dev/*` in dev AND copies into `web/dist` on build
  (~49 MB). Move staging out of publicDir (touches stage.mjs, run-harness,
  publish, analyze-dsos paths) — needs a harness re-run to land safely. The
  dead P0-era stock-pyodide files that sat beside `fork/` were deleted.
- **publish.mjs checksum-verified R2 puts (researched 2026-07-29 on
  wrangler 4.106.0 — facts verified, do not re-derive):** `wrangler r2
  object put` has NO checksum flag, so today nothing guards the
  wire/storage leg of a seed/publish (the preflight hashes BEFORE upload
  only). The R2 Workers **binding** `put()` does take exactly ONE of
  `md5|sha1|sha256|sha384|sha512` — mismatch throws and nothing is stored;
  the checksum persists for later `head()` audits; MD5 is auto-stored on
  every single-part put (etag == md5 hex). Miniflare validates identically
  (though it's looser than prod — it accepts multiple algorithms; never
  rely on that). No checksums on multipart (irrelevant — single put caps
  at ~5 GiB); S3-API checksums are remote-only (miniflare has no S3
  endpoint). Upgrade route when wanted: `getPlatformProxy({ configPath,
  persist: { path: '.wrangler/state/v3' } })` → `env.PY.put(key, buf,
  { sha256, httpMetadata })` with lock shas (hash `.br`/manifest
  in-script) — NOTE the CLI's `--persist-to` appends `/v3` but
  getPlatformProxy's persist does NOT, so point it at `…/v3` explicitly;
  remote leg = same script with the binding `remote: true` in a
  publish-only config/env (remote bindings are GA; dev's `PY` binding must
  stay local). One checksum-verified code path for local seed AND prod
  publish — the intended no-brainer at deploy time.
- ~~**`overlay/stdlib/` comment staleness deferred on purpose**~~ — DONE
  2026-08: all three "baseline snapshot/warmup" references reworded in the
  perf-batch restage (_avlo_png also rewritten wholesale: level 1,
  streaming compressobj).
- Prod CSP additions (`wasm-unsafe-eval`, py.avlo.io in script/connect-src)
  have never been exercised — verify on first prod deploy.
- Client polish (pre-redesign backlog, last known open): live stdout
  streaming into the DOM editing overlay (run-store already accumulates it);
  stop-square SVG centroid offset in the DOM button.
- FF/Safari sweep never done (Chrome-only verification to date).
- **Non-functional but UNPRUNABLE (session-18 sweep, deliberate keeps).**
  Import fine, do nothing, but a load-bearing chain imports each at TOP
  level: `threading` (spawn → `can't start new thread`, no pthreads; `Lock`
  DOES work and every package holds one), `concurrent.futures.thread` (same;
  pandas/seaborn import ThreadPoolExecutor eagerly), `socket`
  (`create_connection` → Host is unreachable; asyncio needs it), `ssl`
  (Pyodide's pure-py stub over the upstream-disabled C ext —
  `asyncio.sslproto` try/excepts it, so it IS prunable for ~20 KB; judged not
  worth the boot risk), `subprocess` (emscripten has no processes;
  `asyncio.subprocess` + `font_manager` import it). Also kept: the CPython
  test-support builtins (`_testcapi`/`_xxtestfuzz`/`xxsubtype`/…) — they live
  in the wasm, not the zip, so only patch 0003 can drop them.
- `zoneinfo` imports on the bare `stdlib` set but has no tz database until the
  `pytz` bundle mounts, and the miss leaks Pyodide's own
  `loadPackage("tzdata")` message. `_avlo_runtime.ensure_tzpath` owns that
  bridge — worth a friendlier error there.

---

## Phase log (compact; newest first — append here each session)

### Session 21 — toolchain replatform PHASE 1 (bytes frozen; no rotation)

Plan: `toolchain-replatform-plan.md` §4 phase 1 — orchestration + scripts,
`buildHash 7fdf68788eb8a2a4` held constant as the total regression oracle.
Everything landed and gated in one session:

- **uv workspace at the repo root** (virtual root `pyproject.toml` +
  committed root `uv.lock`; py-build's old pytest-only project + local lock
  deleted). `avlo-py-build` is a real src-layout package: `avlo-build` CLI
  (stdlib argparse, lazy handlers, whole-process PYTHONHASHSEED=0 re-exec),
  pydantic config model carrying every former `$comment` as a field
  description (`config check`/`config schema`), knobs centralized in the new
  config `pack` section. fontTools moved INTO the env at the exact
  `hostTools.fonttools` pin (uvx call gone; `config check` + pack-time assert
  guard the pin; mpl tar byte-identity proved equivalence).
- **Ports, all byte/verdict-gated:** pack-stdlib + pack-package (absorbed,
  logic intact — staged zip + all 7 tars byte-identical to the lock),
  fetch-wheels (httpx, pool 8), link.rsp generation decoupled to
  `avlo-build link-rsp` (wasmmeta LEB parser replaces lib/wasm-parse.mjs +
  the native-API scan; output byte-identical, now write-if-changed so an
  identical regen no longer triggers build.sh's mtime relink), census/
  verify-groups (dso-report semantically identical old-vs-new; all gates same
  verdicts), verify-pytree (absorbed verbatim), trace check/propose (record
  stays Node: `scripts/node/trace-record.mjs`), compress (python brotli,
  process pool — .br bytes are NOT lock-hashed; budgets margins unchanged,
  composites 6.88/14.00 MB), budgets, stage (byte-identical lock/manifest/
  staged tree; gen.ts/d.ts diffs = generator-name header lines only),
  publish (wrangler transport kept; 23-key plan + preflight identical).
- **board.mjs deleted → turbo DAG** (`@avlo/py-build#py:*` tasks, root
  `pnpm py:board` alias). Verified empirically: explicit turbo `inputs`
  globs DO hash gitignored files (plan §8.7 resolved) — dist/raw,
  dist/groups, .cache/trace enter the graph as declared inputs while the
  docker lanes stay manual. Repro doubles moved OFF the default board to
  `py:repro`. Node keepers under `scripts/node/`; `justfile` added (thin
  aliases only). Docs: CLAUDE.md rewritten, TESTING.md python section
  updated, stale script mentions swept.
- **NEW DETERMINISM LANDMINE FOUND + KILLED** (see learnings): pyc bytes
  depend on the compiling process's import history. All artifact pycs now
  compile in hermetic `_pyc_worker.py` subprocesses with a FROZEN import
  surface; the orchestrator can grow any dependency without touching bytes.
  Registry `# GENERATED by pack-*.py` strings frozen at legacy names until
  the next rotation (UNCHECKED_HASH pycs embed the source hash).
- Also fixed in the port: latent off-by-one in the dylink.0 subsection walk
  (mjs `s.p + leb(buf,s)` anchored the sub-end one byte short; harmless on
  shipped MEM_INFO-only dylinks, wrong for NEEDED-bearing ones — caught by
  a synthetic-module unit test, verified no real-artifact effect).
- **Gate results:** buildHash unchanged (lock byte-identical, git-diff
  clean) · stage --check clean · pack repro doubles green · corpus 7/7 ·
  harness 5/5 · census/groups/pytree/trace/budgets green · pytest 9 ·
  typecheck green · second turbo run = cache-correct (hits on unchanged,
  re-runs only where src/** changed).

### Session 20 — PR #16 cross-verification (no build change, no rotation)

The remote Codespaces session published its independent tail-call/-O3 sweep
as draft PR #16 (`packages/py-build/bench/tailcall/` on
`claude/codespaces-python-builds-73xnm8`: standalone CPython 3.14.2 builds,
10 variants × 11 benchmarks × V8 13.6/14.6, headline "variants 3/4/6 win
+20–27%, variant 0 fails, take variant 4"). This session audited it and ran
bridge experiments — full data + protocol in `bench/tailcall-bridge/README.md`,
durable rule in the learnings ("verdicts do not transfer across builds or
hosts"). Compact outcomes:
- Report internally honest (every geomean recomputes from its raw JSON;
  v1/v2 controls isolate direct-vs-indirect `return_call` cleanly); its
  transferability caveat is the failure — the fork/standalone verdict
  INVERTS on one machine, because the fork's goto baseline is ~2× stock
  while tail-call dispatch speed is build-insensitive.
- Fork v0 rejection RE-confirmed on the remote's own suite: +23–25%
  geomean, both engines, flat iteration curves, unchanged under
  `--no-liftoff` — no tier rescues it.
- Remote-report corrections found: AVLO does NOT PGO
  (`--enable-optimizations` is passed but pyodide's Makefile never runs
  `profile-opt` — verified empty `PGO_PROF_USE_FLAG`, no profdata);
  `raw-sweep.log` cited but absent from the PR; the −54 ms bare-startup
  "lazy-compile" attribution fails a 10× back-of-envelope; cold table flat
  once its (self-flagged) contaminated baseline cell is excluded.
- Verdict on variant 4: promising ONLY as a fork-lane experiment
  (`-DTAIL_CALL_DISPATCH_MODE=4`, PR's 0010 + our 0011, kit protocol,
  ≥2 uarchs); two independent projections put v4-in-fork ≈ wash vs the
  fork baseline. PR comment posted with the split: remote re-runs its
  sweep with the fork's EH flags vs the strong baseline; fork-lane build
  stays local/owner-gated.

The `prompt.md` analysis batch (owner-confirmed findings), one rotation.
What landed, in causal order:

- **A1 trampoline fix (the smoking gun).** MAIN_MODULE=2 had orphaned the
  `getWasmTrampolineModule` EM_JS archive member since the original flip —
  every C-method call crossed into JS through `wasmTable.get` (10,367
  crossings /10k METH_NOARGS). One `-Wl,-u` in patch 0001 + two permanent
  gates (stage grep, harness census). Full post-mortem in Hard-won
  learnings.
- **A2 cpython patch lane** (`patches/cpython/` staged ≥0010 by build.sh,
  auto-nuke of build+installs on lane change, queue-hash stamp forcing the
  main relink) — first occupant `0010` trampoline arity reorder (2,3,1,0).
- **A4 `_zstd` re-add** (static in main, `-lzstd`, prune dropped, corpus
  `b07_zstd.py`; tombstone probe moved to `compression.lzma`).
- **A3 experiments — verdicts re-derived after the CPU-boost-policy
  contamination** (mid-session policy shift ≈30% — see learnings; ledger
  carries a POLICY CONTAMINATION note, only `*-agg-*` rows are clean):
  | variant | verdict | clean evidence (run2, ms) |
  |---|---|---|
  | V1 ship (-O2 + tramp + arity + zstd) | **SHIPS** | crossings 10,367→0 · meth_noargs 129→61 (−48% vs V0-agg) · json 8,655→7,775 (−11%) · heap 54 MB · `V1-ship-agg` row |
  | V2 `-O3` | **REVERTED** | shim-isolated same-policy A/B ~0–3% (V2-agg vs V0shim-agg); the "30% win" was the policy switch. wasm +3% not paid |
  | V3 tail-call v0 | **REJECTED (clean redo 2026-08-03)** | first bench was void (policy shift); redone same-policy interleaved ×3: geomean **+25%** (meth +38%, meth_o +46%, fib +48%, json +7%); Liftoff-only ALSO worse, bootMs flat, wasm +11 KB; ceval.o `target_features` carried `tail-call` (real tail calls — the silent-musttail gate passed). Kit stays at `bench/v3-tailcall-patches/` for variants 3/4/6 |
  | V4 `PYTHONMALLOC=mimalloc` | **REJECTED** | heap 54→96 MB, perf ±5% noise |
  Saved builds: `bench/builds/v1-ship/` (THE ship bytes + V3-redo baseline),
  `bench/builds/v2-o3-ref/`.
- **B interrupt disarmed, cancel = blunt kill.** `setInterruptBuffer` never
  called; `killRun` posts `cancelling` then immediately fails the run with
  respawn (warm ~1 s); soft timeout 30 s same path; partial stdout
  discarded (owner-OK'd). SAB u8[0]/i32[6] documented reserved; UI seam
  (CancelMsg/phase/buttons) untouched for a future real cancel.
- **C figures.** `_avlo_png.py` rewritten: zlib L9→L1, streaming
  compressobj over memoryview slices (~1× peak, was ~3×). Measured staged:
  1920×1440 savefig 906→160 ms (that buffer: L9 535 ms vs L1 29 ms; size
  355→453 KB accepted). Matplotlib BUNDLE_IMPORTS bakes a throwaway
  figure→savefig→close so Agg/font/encoder warmup lands in the capture
  image (bake 569 ms capture-side; `all` heap FLAT at 65.4 MB).
- **D standalone `numpy` set dropped** (rides `numpy+pandas`); harness/
  corpus/tracer/e2e re-pointed; runtime code needed zero edits.
- **E fork API types.** Patch `0009` (type-only, wasm byte-identical):
  `declare static _module`/`_api` on PyodideAPI_, Module gains
  wasmTable/growMemory/callMain, preBlit seam params typed. stage.mjs
  stages the emitted d.ts → `web/src/core/py/pyodide-fork.gen.d.ts`
  (drift-gated, NOT in buildHash, biome-ignored; the `node:stream/web`
  import is deterministically stripped — lib.dom covers it). py-loader:
  `Pyodide = PyodideInterface`, all three `any` params gone; the one
  fallout was `loadDynlib`'s now-mandatory `global` arg (passed `false` =
  the old undefined behavior).
- **F parallelism + the board.** Async brotli pool, link-groups
  ThreadPool, pack-package pyc process pool + concurrent font subsetting,
  2-wide harness/corpus pools, 4-wide wheel downloads, top-level
  `make -j`; recipes loop deliberately serial (PIP_CONSTRAINT + AVLO-PKG
  log protocol are load-bearing serializers). **`pnpm board`** runs the
  whole gate sequence; `--update-budgets` restamped 11 ceilings.
- **G docs** — mutability banners, invariants split into Hard gates vs
  conventions, interrupt→cancellation rewrite, F1–F17/U4–U9 glossary
  written, stale-claims sweep, this fold.
- **Rotation:** ONE buildHash `e210f3a9a140f04b` → `7fdf68788eb8a2a4`,
  board green end-to-end (see last-green stamp), local R2 seeded (23
  keys). Tail-call epilogue: the clean redo (2026-08-03, same-policy ×3 +
  liftoff pair, musttail gate passed) REJECTED variant 0 decisively —
  geomean +25%, no compile/tier-up consolation; patches deleted. The
  cleanup rebuild came back functionally correct but NOT byte-identical
  (cpython-nuke non-reproducibility — see learnings), so dist/raw was
  restored from `bench/builds/v1-ship` (the exact bytes the lock + staged
  tree + seeded R2 reference); `stage --check` clean. Cloudflare
  PR #6122's dispatcher variants 3/4 (`return_call` switch) + 6
  (`br_table`) were subsequently measured standalone by the remote
  session (PR #16) — see Session 20 for why those numbers don't decide
  anything for the fork. Browser support note for any future tail-call
  ship: wasm tail calls need Chrome 112+ / Firefox 121+ / Safari 18.2+.

### Session 18 — dead-on-import stdlib sweep (buildHash `e210f3a9a140f04b`)

Started at `py-stdlib-modules.gen.ts` ("looks outdated"). It wasn't —
`stage --check` clean, and it faithfully mirrors zip tops ∪ builtins ∪
tombstoned tops. **The lie was in the zip.** Reusable method: boot the fork on
the STAGED zip, `import_module` all 476 shipped modules — 49 failed, only 23
deliberately. Five were TOP-LEVEL allowlist entries that passed the click-time
gate then died: `cProfile` (`_lsprof`), `plistlib` (`pyexpat`),
`pdb`/`pydoc`/`doctest` (`_pyrepl/` collateral, error naming a module the user
never typed). Root cause: the prune list had drifted from patch 0003's
`*disabled*` list — now an invariant in CLAUDE.md.

**Swept** → precise tombstones: those 5 + `bdb` + `multiprocessing/` whole
(even `.dummy` routes through the disabled `_multiprocessing`) +
`concurrent/{interpreters/,futures/process.py,futures/interpreter.py}` +
`asyncio/windows_{events,utils}` + `urllib/{request,robotparser}.py` +
`logging/config.py` + 27 `encodings/` leaves (CJK/mbcs/oem/bz2 —
`search_function` swallows the ImportError, so `codecs.lookup` still gives the
normal "unknown encoding"). **Zip 3.34 → 2.84 MB (−502,657 B, −15.0%)** — wire
AND resident, it's MEMFS-live for the runtime's life; composites 7.70 → 6.78
and 15.36 → 13.91 MB br.

**Safety proof per entry:** `co_names`+`co_consts` scan over every shipped pyc
(packages AND stdlib) → source check that each package hit is a LAZY
in-function import (`np.info`→pydoc, `font_manager`→plistlib,
pandas/mpl/numpy/seaborn/six→urllib.request); `logging` reads multiprocessing
via `sys.modules.get`, and `compileall`/`concurrent.futures.__getattr__`/
`asyncio.__init__` are lazy or platform-guarded. None in any `.cache/trace`
`loaded` set, so `trace:check` ∩ prune stayed ∅. Post-repack re-probe: zero
regressions.

**Forced follow-ups:** `load_dataset` now refuses with the `urllib.request`
tombstone, not `http` — assertion fixed in BOTH
`corpus/seaborn/sb05_load_dataset_refusal.py` and `run-harness.mjs`.
`py-stdlib-modules.gen.ts` came out byte-identical (pruned tops moved
`modules`→`tombstoned`; the generator unions both). Also killed
`web/src/core/py/CLAUDE.md`'s false "the build strips `_ssl`".

Board: pack:stdlib ×2 byte-identical · trace:check (138 rules) · corpus 7/7 ·
harness 5/5 · dsos:check · groups:verify · compress · budgets · stage +
`--check` · typecheck 12/12 · vitest 20 · py:seed 23 keys. Bundles untouched.

### Session 17 — live ledger re-record + full doc/comment/dead-code cleanup

Recorded the owner's post-L2 browser board (preview build @ localhost:3000,
Chrome + SW — ledger in Current state): `all` restore 364 warm-sup /
421–503 cold-page click→ready (vs 1,123), numpy+pandas 310, stdlib 248
(misses ≤160 on sup startup, boot flat), first-visit cold+capture 4,943
(network + SW install + 2.19 s capture-imports); sub-1,500 ms cold-restore
execution of all-set snippets confirmed. **Docs:** full current-state
rewrites of `web/src/core/py/CLAUDE.md`, `packages/py-build/CLAUDE.md`,
`packages/py-loader/CLAUDE.md` (banners gone; baseline.snap / snap-probe /
pyDevStatic / sqlite-bundle prose purged; root CLAUDE.md SW lines gain the
py routes). **Client code:** stale comments fixed (snap-probe ×2, "the
spike" ×3, P3 phase refs, wrong scrubNetworkScope/0006 claim in py-harness,
inverted bootDescription attribution, e2e snap-probe narration); dead code
removed (`sup-ready` message, `abortSpawn` status param, `pyArtifactBase`,
workers/py `.snap` MIME row, py-harness file-name exports, sqlite3 in the
refusal marquee, the byte-duplicate `mount` span, py-imports'
untested-injectable param); py-harden's compile-surface list de-duplicated
(writer + gate share WASM_COMPILE_SURFACE); `mountBundle` param renamed
`extractOnly`→`replayed`; HEARTBEAT/EPOCH SAB slots annotated
diagnostic-only; new boot label `cold retry (snapshot poisoned)`.
**py-build:** analyze-dsos de-legacied (--mint-groups + pre-grouping group
simulation + in-group dupe audit removed; `dsos:check` re-run green); dead
publish MIME rows (`.js`/`.snap`), det-env `entropyDraws`, compress export
dropped; stale help/comments fixed (freeze-constraints output path, "8
tars", sqlite-DSO framing, tarfile claims, build.sh emsdk block, 0006/0008
patch-header prose, stage.mjs snapshot note); stale `__pycache__`/
`.cache/hosttools` + the `web/public/py-dev` stock-pyodide drop deleted.
No artifact bytes touched — buildHash unchanged (overlay comment fixes
deferred to the next restage; see Open items).

### Session 16 — cold-restore attack: L1 walker + L2 topology flip + knives (committed)

Attacked the `all`-set restore's 1,123 ms click→ready (≤900 target missed on
the extract slice; mounts ate ~70% of every boot). Landed in three commits
against receipts verified in-session (plan + `docs(local)/ColdRestoreAttack.md`,
bench scripts in `docs(local)/bench/`): **L1** `py-mount.ts` direct-node
walker — tar trees graft into MEMFS via parent node refs with adopted
subarray contents (855 → ~11 ms, zero-diff parity gate now a standing harness
section; four drifting parseTarMeta copies + walkTarSos collapsed into the
one shipped module; packlib ASCII guard). **Build rev** `f440369a4275be9a` —
0001 `callMain` export, 0005 `loadDynlibReplay(Uint8Array |
WebAssembly.Module)`, 0007 stdlib `{canOwn:true}`, `zoneinfo/_zoneinfo.py`
prune; git-native patch restack; full restage board green; tars byte-stable.
**L2** — supervisor spawns the executor FIRST and feeds it via
boot-prep/boot-data/snap-header/snap-heap (glue/bundles/OPFS open+read+hash
all in the spawn shadow; verified heap TRANSFERRED, hash verdicts
pre-transfer); UNIFORM noInitialRun boots with the async preBlit driver
deciding restore-vs-cold in flight (deferred `Module.callMain()`, F4
exitCode re-check; pre-mutation failures → same-Module cold;
`DirtyRestoreError` mutation zone → fresh re-instantiate); executor
precompiles group DSOs overlapped with main instantiate and pre-touches
grown pages (value-preserving Atomics.or) while awaiting the heap; F1–F17
race closures incl. three pre-existing live bugs (muted-terminate
forged-capture window, snapOps-chained U6 delete-vs-probe race, live-guarded
download progress). **Knives** — `freeDsoFileData` on cold boots (−14.7 MB;
`all` capture heapLen 78.5 → 65.4 MB). Harness snapshot section reshaped to
the feeds driver (uniform cold boot probe, sup-style reader ± corrupt/abort,
DirtyRestoreError negative, precompiled-Module restore, dso-free check —
24 checks); parity section added; vitest 15. `idleTeardownMs` kept 15 s
(owner-binding; re-decide after the preview-board re-record — slots in
Current state). Parked with receipts: L3 replay-as-data + main GOT hook,
standalone-`.so` compileStreaming, sup prewarm, main-ctors skip, blit-source
RAM mode, WasmFS, FF/Safari.

### Phase 2 — owned dense snapshots (Session 15, committed `284d8a1`+`af14670`)

Deleted the pyodide `_loadSnapshot`/`_makeSnapshot` path and owned the
snapshot end-to-end: AVS2 dense container (heap-only, OPFS-only), client
capture at the pre-harden slot (fork APIs getDsoLoadInfo/recordDsoHandles/
serializeHiwireState + dense HEAP8 slice, supervisor assembles + chunk-writes
with fused xxh32 off the boot path), client restore through the new
`_avloRestore.preBlit` seam (buildId → growMemory → DSO replay at recorded
bases → hard table asserts → chunked OPFS→HEAPU8 blit → finalizeBootstrap).
Fork patches: 0001-v2 (growMemory + dylink-trio runtime exports), 0005
(replay API, context-rebased from parked), 0007-v2 (owned seam, upstream
container deleted), 0008b (empirically-confirmed 5-entry expected-keys),
emsdk 0006 (dsoBaseHook + the v2 postInstantiation skip). THE blocker: first
grouped replay faulted OOB inside `__wasm_apply_data_relocs`/ctors —
`runtimeInitialized` is true pre-blit so upstream ran a merged init set
against the fresh heap that READS captured state; fix = skip both under
replay (blit supplies their effects), landed as the emsdk v2 hunk after
reverse-applying v1 from the installed tree (dry-run gotcha). Client: five
files rewritten/reshaped (py-snapshot AVS2 codec + OPFS store, py-loader
restore driver + PreBlitError + collectSoBytes, executor snap-probe/
extract-only/in-boot cold fallback/owned capture, supervisor uniform spawn +
restored-keyed poison ladder + U6 first-run-failure delete, protocol
buildHash/trySnapshot/restored + snap-invalid + 15 s teardown); harness
snapshot section imports the SHIPPED codec + driver via a registerHooks
`.ts` resolve fallback; new web vitest codec suite (14) + e2e spec; SW
verify-at-fill for core artifacts AND tars (`x-avlo-verified` marker,
pristine hit identity for the V8 wasm code cache, supervisor marker
fast-path); spike files + pyDevStatic + make-baseline/verify-stacking/
baseline-imports deleted. buildHash → `267194ca75197030`. Full gate board +
preview-browser board green (ledger + self-heal proof in Current state).
Restore ledger: stdlib 193 ms / numpy+pandas 828 / all 1123 click→ready (vs
574/1341/1854 cold) — `all` misses its ≤900 target on the extract slice
alone (the flagged double-copy lever); dso-replay 51 ms @4 vs 428–464 @67.

### Phase 1.5 — DSO grouping 67→4 (Session 14, committed)

Steps 0–2 (`cb53dd4`, `44fd725`, `ae5806b`): recipe-rebuild loop → link
records → harvest → one `-sSIDE_MODULE=2` link per DSO-bearing bundle;
packaging/runtime swap (`.avlo/<bundle>.so` + `_avlo_groups_*` registry +
`_AvloGroupFinder`); full gate board green; buildHash → `bc46093ffa4fb5e8`.
THE blocker: numpy's group link died on `random_multinomial` signature
mismatch — mtrand compiles its own `distributions.c` with
`-DNP_RANDOM_LEGACY` (`RAND_INT_TYPE` = long/i32) while `_generator` et al
expect libnpyrandom.a's int64/i64 copies; in one link mtrand's immediate
object defs shadow the LAZY archive members (same-signature cases would
mis-bind SILENTLY — wasm-ld only errors on signature mismatch).
llvm-objcopy refuses ALL symbol ops on wasm objects, so the planned
harvest-time rename was impossible — fixed at COMPILE time instead:
recipes patch 0004 adds 66 `#define x __avlo_legacy_x` lines under the
existing `NP_RANDOM_LEGACY` guard in distributions.h (all three mtrand TUs
include it; rename set == the legacy TU's full strong-def list, verified
closed by nm enumeration). harvest-links now carries a permanent
per-bundle duplicate-strong-def collision gate (any symbol with strong
defs in >1 distinct-content input hard-fails). Corpus n02 pins
RandomState(42) integer streams bit-exact. Constraints frozen PER PACKAGE
(`recipes-constraints.d/`, AVLO-PKG pip-log markers) after the single-file
design proved unsatisfiable (numpy Cython 3.2.8 vs pandas 3.3.0a1 — its
`<4.0.0a0` bound enables prereleases; matplotlib meson-python 0.16 vs
0.20). Cross-rebuild byte-determinism achieved after normalizing the
ephemeral pip build-env path Cython embeds in its file table (pandas-only;
length-preserving `build-env-XXXXXXXX` rewrite at stash time). Step-0 stub
audit (the parked incremental-GOT context): 387 permanent lazy-stub
closures in the 67-DSO world (kiwisolver `_cext` 341), self-provider
imports 1,023 (env 394 / GOT.mem 552 / GOT.func 77); self-GOT imports
SURVIVE the group relink (emscripten#23107), so the predicted link.rsp
shrink to ~1,370 did NOT materialize (1,764→1,761) — incremental-GOT stays
parked-contingent. Prior session's handoff bug found in review:
`_AvloGroupFinder` was authored but never appended to `sys.meta_path`
(caught before any staging ran).

### Phase 1 — toolchain jump + link-model flip (Sessions 12–13, committed)

Loop A: pure rebase 0.29.4 → 314.0.2 at MAIN_MODULE=1 (Gate A green: docker
1,208 s, all boards, interim hash `ca1a27d668ff97b5`). Loop B: MAIN_MODULE=2
flip — first attempt put the 67 DSOs on the link line and died at boot on
weak-COMDAT preemption (see the closed-world section for the root cause +
fix: `--export-if-defined` union, DSOs off the line); second failure class
was the no-EXPORT_ALL Module surface. Gate B green, buildHash
`58ae9021763d19f0`, browser board + cold-boot ledger recorded above.
Corrections vs the plan discovered en route (now folded into the master
doc): mergeLibSymbols walks the SIDE module's exports (=2 doesn't shrink
per-dlopen merge; the GOT scan is the P2 target) · non-relocatable main
modules landed in emsdk 4.0.19 (free via the jump) · `_lzma` was never
enabled in our fork · zero emsdk patches needed in P1 · 314 still ships the
full loader machinery (0006 survived nearly verbatim).

### Phase 0 — always-on trace + baseline ledger (Session 11, committed)

`py-trace.ts` + marks through supervisor/executor/loader/snapshot + the
exec→sup→main trace relay. Baseline ledger recorded (see Trace ledgers).
Both plan predictions confirmed: pre-spawn ≈ OPFS read + SHA + reconstruct;
~75% of dso-replay is glue-side GOT/merge bookkeeping, not wasm work.

### Pre-redesign milestones (0.29.4 era — heavily superseded, kept as one
paragraph)

Fork + patch queue + deterministic packing pipeline built (M1–M2) · canvas
runtime landed: protocol/sab/harness/run-store/supervisor/executor/manager,
play/stop UI, cancel/timeout, traceback with user source (old P1) · worker
serving + build-lock + publish/seed (M3) · same-origin hardening: scrub,
harden, fail-closed assert, Node harness (Sessions 5–6) · fork patches
0006/0008 (Session 7) · lock-verified artifact serving via SW + constructor
freeze sweep (Session 8) · sqlite3+seaborn bundles (Session 8; sqlite3
bundle since deleted — static in 314) · client-side OPFS snapshot boots +
py edge cache (commit `5abdf63`, never had a NOTES entry; that snapshot
machinery is now parked) · figures→canvas pipeline + review sweep + output
WYSIWYG parity (Session 9) · py tooling moved into packages/py-build, uv
adoption, test scaffolding (Session 10). Durable knowledge from all of this
lives in the sections above; per-session gate boards and numbers are in git
history (`git log --oneline` — commits 3ec5374…5abdf63) if archaeology is
ever needed.
