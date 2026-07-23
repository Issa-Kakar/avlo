# py-build NOTES — cross-session state for the Python-runtime redesign

**What this file is:** durable, load-bearing knowledge for agents working the
py-runtime redesign — current state, the measurement ledgers every phase gate
compares against, hard-won learnings, and open items. It is NOT a changelog:
when a phase lands, append a compact entry to the phase log at the bottom and
fold its durable facts into the sections above it. Kill anything here that a
later phase makes false.

**Authoritative plan (P0–P5):**
`/home/issak/.claude/plans/docs-local-py-runtime-redesign-condense-parsed-piglet.md`
(carries per-phase checkboxes, targets table, risk register, rejected
alternatives — do not re-litigate those without new data).

---

## Current state — Phase 2 COMPLETE (uncommitted): owned dense snapshots, client capture + restore

- **Phase 2 landed** (Session 15): the pyodide `_loadSnapshot`/`_makeSnapshot`
  path is DELETED from the fork; snapshots are owned end-to-end. Every set
  (stdlib included) captures client-side at the pre-harden slot on its first
  cold boot (bake `BUNDLE_IMPORTS` → meta via fork APIs → dense `HEAP8.slice`
  transferred to the supervisor → AVS2 assembly → chunked OPFS write with a
  fused xxh32, fire-and-forget off the boot path) and restores via the fork's
  `_avloRestore.preBlit` seam: buildId assert → `Module.growMemory` → DSO
  replay at recorded bases (emsdk dsoBaseHook forces memBase / asserts
  tableBase; postInstantiation SKIPS apply_data_relocs+ctors under replay) →
  hard tableLen assert → chunked OPFS→HEAPU8 reads folding the hash →
  `finalizeBootstrap(hiwire)`. Restore boots extract tars WITHOUT the dlopen
  loop (extract-only; replayed groups are already LDSO-registered, the
  `.avlo/*.so` files still land for post-restore lazy C dlopens). Failure
  ladder: probe/pre-blit failure → `exec-snap-invalid` → supervisor deletes,
  boot continues COLD in the same worker (no respawn); post-blit pre-ready
  fatal (`restored:true`) → poison-delete + ONE noSnapshot cold respawn;
  first-run hard failure of a restored generation → poison-delete before the
  eager respawn (U6). `idleTeardownMs` 60 s → **15 s**. Kill-switch:
  `SNAPSHOTS_ENABLED` in py-supervisor.
- **P2 browser ledger (preview board, Chrome, SW active, local R2 —
  Session 15; click→ready = sup reqToReadyMs, boot in parens):**
  - stdlib restore **193 ms** (168) — target ≤450, old-world baseline restore 419
  - numpy+pandas cold+capture 3498 (2768; opfs-write 256 @65 MB off-path) →
    restore **828 ms** (730: snap-probe 14 hit · dso-replay 34 @2 ·
    heap-read 99 @65 MB · load-pyodide 207 · extract Σ~475)
  - all cold+capture 3934 (3056; capture-imports 1823, opfs-write 184 @79 MB)
    → restore **1123 ms** (982: snap-probe 22 · dso-replay 51 @4 (vs 428–464
    @67 in the 0.29 world) · heap-read 124 @79 MB · load-pyodide 257 ·
    extract Σ~660) — misses the ≤900 target on the EXTRACT slice alone
    (pytz 234, numpy 131, pandas 148; the flagged post-P2 double-copy lever)
  - warm runs on restored generations: pandas 75 ms, seaborn first-plot
    466 ms (imports baked — no re-import; mpl first-DRAW cost, measured-
    deferred) · teardown@15 s + respawn-restore proven · corrupt-OPFS
    self-heal proven live (4 flipped bytes in 79 MB → `heap hash mismatch` →
    in-boot cold fallback → delete → re-capture → next boot restores)
- **Phase 1.5 (committed): 4 grouped side modules, 67→4** — retained context
  below.

- **Phase 1.5 landed** (Session 14; commits `cb53dd4` Step 0, `44fd725`
  Step 1, `ae5806b` Step 2): every DSO-bearing bundle tar ships **ONE
  grouped side module** `.avlo/<bundle>.so` (numpy 4.85 MB / pandas 7.99 /
  matplotlib 1.44 / mpl-deps 0.37) linked by the recipe-rebuild loop
  (`run-recipes.mjs` — pinned pyodide-recipes checkout, link-record hook,
  harvest into committed `config/dso-groups/<bundle>.json` manifests,
  `--repro` group links, **byte-stable across independent pinned rebuilds**).
  Runtime: mount dlopens the group once; imports resolve via sitecustomize's
  `_AvloGroupFinder` (meta_path `[…, PathFinder, group, tombstone]`) →
  emscripten LDSO registry hit. Full board green vs the OLD main first
  (grouped imports ⊆ old union de-risking) then the relinked main.
  **Remaining (owner-gated, needs `pnpm dev` ack): browser dev board +
  cold-boot ledger re-record** with the `mount-extract`/`mount-dlopen` split.
- **Step 0 measurement** (Session 14 baseline): stub audit — **387 permanent
  lazy-stub closures** in the 67-DSO world — self env-func imports ∉
  mainExports under RTLD_LOCAL (libdylink.js 784-796) — kiwisolver `_cext`
  341, numpy `_multiarray_umath` 33, contourpy 13, matplotlib/pandas 0; +1
  glue-bound (`exit`). Self provider class (1,023) split env 394 / GOT.mem
  552 / GOT.func 77. Grouped world: same totals folded to 4 modules
  (mpl-deps 354 = kiwisolver 341 + contourpy 13; self 918 — self-GOT imports
  SURVIVE the group relink, emscripten#23107, exactly as the plan's
  Corrected Expectation #3 anticipated ⇒ link.rsp went 1,764 → **1,761**,
  not the estimated ~1,370; the incremental-GOT P2 item stays
  parked-contingent).

- **Toolchain:** Pyodide **314.0.2** / CPython **3.14.2** / emsdk **5.0.3** /
  ABI `2026_0`, **MAIN_MODULE=2** closed world (see next section). Image
  `pyodide/pyodide-env:20260211-chrome145-firefox146-py314` (digest pinned in
  `build.config.json`). Glue is **`pyodide.asm.mjs`** (ESM; renamed from
  `.asm.js` in 314).
- **buildHash `267194ca75197030`** (in `packages/py-loader/build-lock.json`,
  uncommitted P2 rotation — the only rotation in P2), seeded to local R2
  (23 keys). Commits: `c6db3ea` (P0 trace+ledger), `479b0f0` (P1 Loop A
  rebase), `8653e84` (P1 Loop B flip + lock + seed),
  `cb53dd4`/`44fd725`/`ae5806b` (P1.5 Steps 0–2).
- **Sets:** `{stdlib, numpy, numpy+pandas, numpy+matplotlib, all}` — stdlib is
  the implicit no-bundle set; the other four are `build.config.json` `sets`.
  sqlite3 is **static in the main module** (314 upstream) — its old wheel,
  bundle, and standalone set are gone; `import sqlite3` works on every set.
  `PySetKey` is codegen'd by `stage.mjs` into `py-stdlib-modules.gen.ts`
  (py-protocol re-exports it type-only); `bundlesOf`/`resolveImports` are
  fail-closed on unknown keys.
- **Snapshots are OWNED (P2): AVS2 dense container, OPFS-only, never on the
  wire.** At rest `opfs:/py/<buildHash>/<setKey>.snap` = `[u32 magic 'AVS2']
  [u32 headerLen] [u32 heapLen] [u32 crc32(headerJSON)] [header JSON
  zero-padded so heapOff = 16 + alignUp(headerLen, 4096)] [dense heap …EOF]`;
  header carries buildHash/setKey/buildId/dso bases/dsoHandles/hiwire/
  tableLenAtCapture/heapHash(xxh32). Parse cross-checks everything incl.
  `fileSize − heapOff == heapLen`; heap first + header LAST on write makes
  torn writes structurally invalid; ANY failure → delete → cold (self-heal
  proven live). Restore reads OPFS DIRECTLY into wasm memory (8 MB chunked
  sync reads into re-acquired HEAPU8 views — zero full-size intermediates).
  Codec + OPFS store live in `web/src/core/py/py-snapshot.ts`; restore driver
  in `py-loader.ts` (`PreBlitError` = the pre-blit/post-blit discriminator).
  Old AVS1 sparse codec / `PackedTree` / LRU / SHA-256 trailer / baseline.snap
  / make-baseline / verify-stacking are all DELETED. Stale-buildHash OPFS dirs
  GC on the write side's first touch.
- **Live fork patches:** pyodide `0001` (linkflags/memory/exports — the
  Loop-B link model; EXPORTED_RUNTIME_METHODS now also carries `growMemory`
  (the preBlit pre-grow — upstream INITIAL_MEMORY resize is a NO-OP against
  this glue, memory is wasm-exported) + the dylink trio
  `LDSO,newDSO,loadWebAssemblyModule` (closure-internal otherwise; 0005 reads
  them off Module)), `0003` (drop C extensions; 314 upstream now disables
  pwd/_ssl/_hashlib/_uuid itself and adds static `_hmac`+`_sqlite3`, both
  kept; we add `_zstd`; `_lzma` stays disabled), `0005` (AVLO DSO replay API
  on dynload.ts: get/setDsoLoadInfo, loadDynlibReplay, restore/recordDsoHandles,
  dsoReplayDone), `0006` (drop loader machinery), `0007` (owned-restore seam:
  `_avloRestore.preBlit` + noInitialRun; upstream prepareSnapshot/makeSnapshot/
  restoreSnapshot DELETED; serializeHiwireState/getExpectedKeys/
  syncUpSnapshotLoad1/2 kept), `0008` (js-bridge closure), `0008b`
  (expected-keys = the REAL 5-entry boot table). **One emsdk patch:** `0006`
  dsoBaseHook (record/replay of DSO memBase/tableBase in
  loadWebAssemblyModule + v2: postInstantiation SKIPS
  `__wasm_apply_data_relocs` + `__wasm_call_ctors` under replay — the heap
  blit supplies their capture-time effects; running them pre-blit against the
  fresh heap FAULTS on grouped-module init). `patches/parked/` is gone.
- **Wheel patches (all re-derived against current wheels):** matplotlib
  0001 rc-backend-agg / 0002 pillow-ectomy / 0003 lazy-plistlib; pandas
  0001 no-toplevel-ctypes / 0002 lazy-ctypes-interchange; dateutil 0001
  quiet-pruned-tzdata; seaborn 0001 lazy-urllib / 0002 pydoc→inspect.
  Wheels: numpy 2.4.3, **pandas 3.0.2**, matplotlib 3.10.8, seaborn 0.13.2
  (URL-pinned — absent from the stock lock), pillow/fonttools traceOnly.
- **Serving:** `workers/py` serves `<buildHash>/<file>` with brotli `.br`
  siblings **and an edge cache** (`caches.default` with synthetic
  per-encoding-class keys — this superseded the earlier "no edge cache,
  variant poisoning" stance; see `workers/py/src/index.ts` header). SW (P2
  verify-at-FILL model): every py entry the SW writes is lock-verified FIRST
  and stored with `x-avlo-verified: 1`. Core artifacts — marked hits serve
  as-is with pristine HTTP-cache identity (Cache-Control/ETag kept,
  Content-Encoding dropped with the decoded body) so **V8's disk wasm code
  cache** can engage for `pyodide.asm.wasm` (the old every-hit re-verify's
  synthetic Response defeated it; engagement itself still to be confirmed on
  the owner's repeat-reload board); unmarked legacy entries delete + refill;
  a failing network body is a 502, never cached. Tars — misses stream to the
  page unbuffered (progress intact), verify+marked-put on a clone in
  waitUntil; the supervisor's own miss-path put is marked too (it verified
  the bytes), and its HIT path takes the marker fast-path (skips re-hashing
  ~40 MB/boot; unmarked hits still re-verified). Stale generations evicted
  on activate. `.snap` never crosses HTTP.
- **Figures pipeline** (client, landed pre-redesign): `py-figures.ts`
  `placeRunFigures` — run-produced matplotlib PNGs ingest through the image
  pipeline, dedup by assetId vs the block's live `figureIds` (same plot =
  no-op; create-only, never update/move/delete), placed 400wu east of the
  block slid clear vertically, one user-origin transact per figure (image +
  elbow connector + figureIds append — undo-tracked; output text stays
  `PY_RUN_ORIGIN`, not undo-tracked).
- **Docs debt:** `packages/py-build/CLAUDE.md` and `web/src/core/py/CLAUDE.md`
  carry P1 interim banners; their prose (and the root CLAUDE.md py rows, e.g.
  the stale "no edge cache" claim) predates parts of the current tree. Full
  rewrites are Phase 5 — trust THIS file + the code over them where they
  conflict.

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
- **Numbers (Loop B vs Loop A / 0.29):** wasm 6,858,149 B (−13.8% vs Loop A's
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

Trace plumbing: `py-trace.ts` is always-on — one `console.info('py:trace',
json)` per boot/run per thread; worker consoles are invisible to automation so
executor traces relay exec→sup→main; `window.__avloPyTraces` (DEV) is a
100-line ring. `installWasmTimers()` wraps the WebAssembly compile surface
during boot only and MUST be uninstalled before scrub/harden.

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
- These are no-SW dev numbers — they cannot see the SW re-buffer cost P4
  removes. If the prod path needs its own before/after, re-baseline via
  `pnpm preview` at P4.

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

**P2 mid-phase verification metrics (2026-07-22 second-opinion pass — Node
v24/V8 13.6, 8-core WSL2, against the STAGED uncommitted P2 build
`e2b9ed6ec7b3ec12`; Chrome shares the V8 defaults, browser board re-measures
at landing):**
- Grouped DSO census: exports Σ986 (mpl 379 / mpl-deps 455 / numpy 105 /
  pandas 47), import entries 2,712 (env 1,784 · GOT.mem 716 · GOT.func 232),
  elem-segment table slots 12,940, dylink.0 = **9 bytes** per group
  (MEM_INFO only, `needed=[]`), **zero side→side imports** — every env/GOT
  import resolves to main, self, or JS `exit`.
- Compile (V8 lazy default): cold sync `new Module` numpy 12 / pandas 23 /
  mpl 4 / mpl-deps 2 / main 15 ms; eager-Liftoff ceiling Σ246 sides + 99
  main; parallel eager compile NOT faster (291 vs 246 serial);
  identical-bytes recompiles hit V8's in-process native-module cache.
- JS-link micro-census (4 grouped dlopens, record path; wrapped
  Global/`.value`/Table/Module surfaces + inspector profile — regenerable):
  dlopen Σ118–124 ms cold incl. what replay skips; replay-relevant JS link
  ≈ **30 ms** — table-map ~17 (13,425 `Table.get` / 12,940 slots) · rUS
  3.25 total (4 scans, 1,091→1,941 GOT entries) · Global traffic ~8 (1,389
  allocs, 9,392 `.value` crossings, 450 relocateExports probe-throws — 367
  matplotlib/pybind11) · GC 11.4 (~24 k allocations).
  `convertJsFunctionToWasm`: **0** during mounts, exactly 1 in main boot
  (the known preRun trampoline). MEMFS `.so` read 18.8 ms on the C-dlopen
  path (replay slices tar buffers instead). Main boot does 47,491
  `Table.get` of its own — inside the steady load-pyodide ~360–395.
- `all` owned capture: heapLen **78,512,128 B** (kills the ~200 MB planning
  assumption), tableLenAtCapture 21,526, zero pages 12.5 % @64 KiB (dense
  AVS2 stands), fused xxh32 ≈ 28 ms (inside the ≤40 ms budget). dso-replay
  projection **~80–95 ms** @4 (vs 428–464 @67); restoring→running ≈
  340–730 ms, extract-dominated — the mountBundle tar→MEMFS→tarfile double
  copy is the measured next lever (flagged in P2-HANDOFF.md).

## Security model (durable; the redesign does not change it)

- **Same-origin worker, no sandboxed iframe (owner-settled).** The executor is
  born with the origin's full ambient authority and the CSP inherits
  `'self'` + backend egress — so `scrubWorkerScope()` (py-harden.ts) is THE
  authority boundary, not defense-in-depth: network + fresh-realm escapes
  (Worker/SharedWorker/importScripts) + origin storage (indexedDB, caches,
  navigator incl. OPFS/locks/GPU) + BroadcastChannel + WebRTC (raw egress NOT
  governed by connect-src), own props AND prototype chain, strict-mode-safe.
- `hardenRealm()` deletes the WebAssembly compile surface (all DSO loads are
  boot-time; new set ⇒ new worker) and freezes protocol-bearing intrinsics +
  constructors. eval/Function stay: unblockable in-language, and post-scrub
  there is no I/O authority left to exfiltrate with — the posture is
  authority removal.
- **`assertRealmHardened()` is the fail-closed gate** — full re-sweep right
  after scrub+harden inside the exec-fatal try; any survivor aborts the boot.
  Never let a scrub become a silent no-op.
- `import js` is finder-level `ModuleNotFoundError` **independent of the
  harness guard** (fork patch 0008 removes the `register_js_module` call);
  the harness meta_path guard is defense-in-depth on top.
- Verification chain: SW verify-at-FILL (core artifacts AND tars — nothing
  the SW writes is unverified; `x-avlo-verified` marks it) · supervisor
  `ensureGlueVerified()` once per page (covers dev/no-SW) · tars sha-gated by
  the supervisor on fetch, marked hits fast-pathed, unmarked hits re-verified
  · `verifyStdlibZip` hashes the stdlib AS MOUNTED vs the boot manifest ·
  snapshots: buildHash dir key + header crc32 + buildId assert (pre-grow) +
  per-DSO tableBase asserts + hard tableLenAtCapture assert + fused xxh32
  over every heap byte read — ANY failure → delete → cold, and `exec-snapshot`
  is only accepted pre-ready (a forged capture can't reach OPFS), with the
  restored image landing BEFORE scrub/harden (a poisoned heap boots
  authority-less). `@avlo/py-loader`'s `./verify` subpath is the shared
  predicate (dependency-free; Node harness imports the exact shipped code).
- **Open residuals (accepted/deferred, do not rediscover):** (1)
  first-load-without-SW TOCTOU vs an ACTIVELY malicious origin — unclosable
  without a worse trade (`script-src blob:`); every realistic corruption
  fails closed. (2) MEMFS file mutations survive blit resets — a planted
  `_avlo_pruned_*.py` can be re-imported across runs within one generation
  (authority-free, contained); real fix is P3 WasmFS (FS rides the heap
  image, blit resets it). (3) `subprocess`/`multiprocessing` are blocked by
  wasm-syscall absence, not policy.

## Hard-won learnings (do not re-derive)

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
  API]`** (5 entries; upstream's 7-entry list was wrong post-0008) —
  empirically confirmed via `__hiwire_get` walk; the harness dumps the live
  table on any mismatch so future boot-sequence changes re-derive in one
  command.
- **Zombie-executor interrupt steal:** `Worker.terminate()` on a wasm busy
  loop closes ports but the thread spins until its next yield and keeps
  consuming SIGINT from a shared interrupt SAB — the next executor's first
  interrupt vanishes. Production supervisor already does both fixes: fresh
  interrupt SAB per spawn (never reuse across generations) + repeat SIGINT
  writes every 50 ms until exec-result.
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
- 0008's expected-keys list (`getExpectedKeys` in the fork's snapshot.ts,
  parked reference patch): hiwire slot expectations are **boot-allocation-
  order empirical**, not derivable — re-derive from a live table after any
  boot-sequence change. Post-0008 table was
  `[null, public_api, API, scheduleCallback, API]`.
- det-env (deterministic capture) must intercept THREE entropy/clock sources,
  found by byte-diffing: `node:crypto` randomFillSync/randomBytes (Emscripten
  PREFERS these over webcrypto under Node — a webcrypto-only shim sees 0
  draws), `Date.now` (MEMFS stamps every node), `performance.now`. Plus
  `PYTHONHASHSEED=0` via the loadPyodide env. P2's browser-worker capture
  needs a det-env variant sharing one source with the Node kit.

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
  files can't be ESM-imported (the `pyDevStatic`/staging split exists for
  this).
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

All from `packages/py-build/` via `pnpm --filter @avlo/py-build <script>`
(or root aliases where noted). None run in Turbo/CI.

- `pack:stdlib` ×2 → byte-identical zips · `bundles -- --all --repro` →
  byte-identical tars · `trace` + `trace:check` (G3: trace ∩ prune = ∅, no
  PIL/fontTools) · `corpus` (7 groups; child process per group; mounts REAL
  tars; mpl groups add font gates + PNG pixel decode) · `harness`
  (run-harness.mjs: Node ≥23.6 type-strips the SHIPPED
  py-harden/py-harness/verify.ts, re-enacts the exact executor boot, then
  drives scrub/freeze sweeps + negatives, 0008 closure probes, tombstones,
  post-freeze package boards, staged-tree-vs-lock byte checks) · `compress` →
  `budgets` (G1 ceilings) · `stage` + `stage:check` (drift gate; rotates
  buildHash) · `pnpm typecheck` · vitest (workers/py routes, py-loader
  verify) · `pnpm py:seed` (publish --local; preflight re-hashes every byte,
  manifest LAST).
- `run-harness.mjs --section snapshot` — the P2 exit gate: real capture boot
  (mounts + bake + fork APIs) → AVS2 assemble via the SHIPPED py-snapshot.ts
  → parse + hash positives/negatives → owned restore through the SHIPPED
  py-loader bootPyodide/preBlit (fd-backed SnapReadHandle) → extract-only
  remount → numpy/pandas/RandomState-pin/lazy-`_tri`-LDSO-hit/tombstone/
  blit-reset probes. `web/vitest.config.ts` runs the AVS2 codec unit suite
  (py-snapshot.test.ts, 14 tests); `e2e/py-snapshot.spec.ts` covers the
  browser lifecycle (needs the full `pnpm dev` stack — Playwright webServer
  alone can't serve /api/py).
- **Last-green (P2, buildHash `267194ca75197030`):** harness ALL sections
  incl. snapshot 18/18 on the shipped codec + driver · corpus 7/7 ·
  `dsos:check` · stage `--check` clean · typecheck 12/12 · vitest 19/19
  (py-loader 3 + workers/py 2 + web codec 14) · seed 23 keys · preview-board
  browser session (Chrome + SW): cold+capture → restore → warm × three sets,
  corrupt-OPFS self-heal, teardown@15 s + respawn-restore, figures pipeline,
  marker fast-path storage state (ledger in Current state above).
- **Last-green (P1.5, buildHash `bc46093ffa4fb5e8`):** stdlib repack ×2
  byte-identical · 7 tars `--repro` · corpus 7/7 vs the OLD main AND again
  vs the relinked main (n02 now pins RandomState(42) integer streams —
  randint/multinomial/binomial vs host numpy — proving mtrand's renamed
  legacy family bit-exact) · trace ∩ prune = ∅ · `dsos:check` v2 (census
  equality, closed world at N=4, loadOrder shape) · `groups:verify`
  (verify-groups 4/4 + verify-pytree 5 pkgs, 2 allowlisted meson stamps) ·
  budgets restamped (composites SHRANK: numpy-path 7.29 MB br / pandas-mpl
  14.41 vs 7.34/14.63 at 67 DSOs) · stage `--check` clean · harness ALL
  sections on the staged grouped world · typecheck 12/12 · vitest 3/3 + 2/2
  · seed 23 keys.
- **Browser dev board (Gate-B matrix, all green on the current build):**
  stdlib print/echo + sqlite3 `:memory:` CRUD · `import ctypes` +
  `import compression.zstd` → precise tombstones · numpy 4.0 · pandas
  groupby + `pd.read_sql` roundtrip · mpl figure placed with auto-connector ·
  seaborn scatterplot (all set) · `import requests` instant refusal (marquee
  bills sqlite3 via STDLIB_MODULES) · cancel mid-loop · 30 s soft timeout ·
  idle-teardown + eager respawn healthy.

## Open items / backlog

- **P2 owner tail (browser, at leisure):** V8 wasm code-cache ENGAGEMENT
  confirmation (repeat-reload load-pyodide deltas — the pristine-identity
  precondition is landed and storage-verified; the win itself is unmeasured)
  · multi-tab same-set concurrent restores (read-only sync handles; capture
  loser skips) · Chrome task-manager RAM (active ≈ 2× heap, idle beyond 15 s
  ≈ 0) · `import requests` refusal + cancel-mid-loop re-spot-checks (code
  untouched by P2, last green P1.5) · SW verified-route 502 negative +
  offline second-load.
- **The `all` restore ≤900 ms target is EXTRACT-bound** (measured 1123;
  extract Σ~660 of the 982 ms boot — pytz 234 alone). Next lever (NOT
  P2-gating, fresh session): kill the `mountBundle` double copy — the WHOLE
  tar is written into MEMFS then Python `tarfile` re-reads + extracts it
  (every byte crosses the FS layer twice + per-member interpreter overhead,
  cold AND restore). Candidate: JS-side ustar walk (`FS.mkdirTree` +
  `FS.writeFile` straight from the transferred buffer — three such walkers
  already exist in-repo). Constraints: byte- AND mtime-identical to
  `tarfile.extractall(filter='data')` (restore re-extract must reproduce
  capture mtimes — `FS.utime` per member; MEMFS = one ms timestamp per
  node), meta.json skipped, no surface/handle survives toward harden, and
  the Node harness re-enacts whatever the executor does.
- Prod CSP additions (`wasm-unsafe-eval`, py.avlo.io in script/connect-src)
  have never been exercised — verify on first prod deploy.
- Client polish (pre-redesign backlog, last known open): live stdout
  streaming into the DOM editing overlay (run-store already accumulates it);
  stop-square SVG centroid offset in the DOM button.
- pydoc is allowlisted but trips the `_pyrepl` tombstone at runtime
  (top-level import at pydoc.py:80; precise error — acceptable).
- FF/Safari sweep never done (Chrome-only verification to date).

---

## Phase log (compact; newest first — append here each session)

### Phase 2 — owned dense snapshots (Session 15, uncommitted)

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
length-preserving `build-env-XXXXXXXX` rewrite at stash time). Predicted
link.rsp shrink to ~1,370 did NOT materialize (1,764→1,761): self-GOT
imports survive grouping (emscripten#23107) per Corrected Expectation #3 —
incremental-GOT stays parked-contingent for P2. Prior session's handoff
bug found in review: `_AvloGroupFinder` was authored but never appended to
`sys.meta_path` (caught before any staging ran). Browser board + ledger
re-record remain owner-gated (`pnpm dev`).

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
