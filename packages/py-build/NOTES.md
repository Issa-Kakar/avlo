# py-build NOTES — durable state for the Python runtime

**What this file is:** the durable half of py-runtime knowledge — measurement
ledgers, hard-won learnings (don't re-derive), open items, and a compact
phase log. Current mechanics live in the CLAUDE.mds (`packages/py-build/`,
`web/src/core/py/`, `packages/py-loader/`) — don't restate them here. When a
change lands, fold in its durable facts and DELETE what it falsified.

**Everything here is mutable.** Only two classes are firm: **owner-settled**
decisions (labeled) and **hard-correctness** gates (artifact hash
verification, meta.json-first tars, deps-first DSO order, trampoline
liveness). Engage with proposed changes on the merits; never defend prose.

---

## Current state

- **buildHash `e92dd255c2de2df4`** — 2026-09-02 replatform phase-3 rotation
  (loader `BUILD_ID` only; wasm/glue/types = the 2026-08 perf batch's
  `7fdf68788eb8a2a4`, byte-identical); 23 keys seeded to local R2. Every rotation auto-invalidates clients' OPFS snapshots, Cache
  API generations and SW entries.
- **2026-08 perf batch (Session 19) — what changed and why it matters:**
  - **The wasm-gc trampoline was DEAD in every shipped build.**
    MAIN_MODULE=2 orphaned the archive member, so every
    METH_NOARGS/O/VARARGS call and getset access round-tripped wasm→JS→wasm
    (10,367 crossings /10k calls → 0; meth −48%, json −11%). The lesson
    generalizes past this bug: an optimization can be silently OFF with
    nothing failing — hence two permanent gates (stage glue grep,
    py-integration crossing census). Root cause + fix in learnings.
  - **-O2 is the ship state.** The apparent "-O3 ~30% win" was a CPU-boost
    policy artifact (clean same-policy A/B ~0–3%), and -O3 mints a
    157,736 B inlined function — 2× the megafunction — that lazy
    compilation pays for at first call. Both halves in learnings.
  - mimalloc REJECTED (+42 MB heap, perf ±5% noise) · interrupt disarmed,
    cancel = kill + eager respawn · figure PNG encode zlib L9→L1 streaming
    (big-figure savefig 906→160 ms) · matplotlib first-figure bake folded
    into capture (`all` heap flat at 65.4 MB) · standalone `numpy` set
    dropped.
- **Sets** `{stdlib, numpy+pandas, numpy+matplotlib, all}` — `import numpy`
  rides `numpy+pandas`.
- **Cold-restore attack (Session 16)** — mechanics are current-state in
  `web/src/core/py/CLAUDE.md`; the durable payoff: L1 direct-node mount
  walker 855 → ~11 ms for `all` (byte-identical; parity is a standing gate),
  L2 spawn-first topology hides bundle prep + ALL OPFS I/O in the spawn
  shadow, stdlib zip adopted rather than copied (`{canOwn:true}`, patch
  0007, −2.84 MB/boot), `freeDsoFileData` −14.7 MB (`all` capture heap
  78.5 → 65.4 MB).
- **Snapshots** — AVS2 dense heap container, client-captured, OPFS-only at
  `opfs:/py/<buildHash>/<setKey>.snap`. Heap first / header LAST on write
  makes torn writes structurally invalid; any failure → delete → cold
  (self-heal proven live). Codec + store: `web/src/core/py/py-snapshot.ts`
  (byte layout is the code's to own). The AVS1 sparse codec / PackedTree /
  LRU / baseline.snap lineage is DELETED.
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
    numpy+pandas 43.25 · stdlib 30 (the dropped standalone numpy set was
    30 too — stdlib-sized).
- **`PY_LIMITS.idleTeardownMs` = 15 s.** The re-decision is unblocked — the
  ledger above is the data the deferral waited on (restores 209–423 ms boot
  across sets) — but the knob moves with the executor-lifecycle rework
  (Open items), not alone.
- **Serving** — current state in `web/src/core/py/CLAUDE.md` + the
  `workers/py` header. The one fact stale prose elsewhere gets wrong: the
  edge cache (synthetic per-encoding-class keys) SUPERSEDED the earlier "no
  edge cache, variant poisoning" stance, and marked-hit pristine HTTP-cache
  identity exists so V8's disk wasm code cache can engage (engagement itself
  still unmeasured — Open items).

## MAIN_MODULE=2 closed world — how the link works (load-bearing)

The design that survived Loop B's two boot failures. Anyone touching the link
line, exports, or DSO handling must understand this:

- **DSOs are deliberately NOT on the main link line.** `avlo-build link-rsp`
  (`link_rsp.py`) scans the **grouped side modules** (`dist/groups/<bundle>.so`,
  4 DSOs since P1.5 — hard-error if any is missing, no wheel fallback;
  1,761 func/global/tag symbols, `invoke_*` excluded)
  and emits `.cache/link-sos/link.rsp` = one `-Wl,--export-if-defined=<sym>`
  per symbol. The fork build COPYs it to `/pb/.cache/link-sos/link.rsp`
  (the path patch 0001 @-consumes) and always links from a fresh tree, so
  "is the glue stale vs the rsp" is not a question any more — it is a
  content-keyed input of the `build` stage and of the `py:fork` turbo task.
  That reproduces the only effect we need from emcc's
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
  runtime throws on both unresolved surfaces; the corpus (every group) is the
  closed-world proof — every DSO dlopens, zero stub throws.
- **Two numbers that are assertions about the design, not trivia:** GOT
  imports **0** (a nonzero count means the closed world broke — that is the
  weak-COMDAT failure mode above) and main exports ~1,000 (EXPORT_ALL was
  8,015; the curated surface is what keeps metadce honest).
- Changing the pyodide tag / image is a config edit: `pyodide.{tag,commit}`
  and `image.{ref,digest}` are build-args of `docker/fork.Dockerfile`
  (`avlo-build fork` passes them; the clone hard-asserts the commit, `FROM
  ref@digest` pins the image). Nothing is stamped, nothing on disk needs
  clearing — `.work/pyodide` is not load-bearing since the phase-3
  replatform.

## Trace ledgers (phase gates measure against these — do not lose)

Trace plumbing lives in `py-trace.ts` (mechanics in the web CLAUDE.md file
table). `window.__avloPyTraces` (DEV) is the automation read surface
(100-line ring).

**Span glossary (cold-restore rev — the current ledger keys):**
- sup: `spawn` (worker construction → boot-prep posted) · `glue-preflight` ·
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
  the wasm-timer aggregates (`compile` entry), not as its own span. Sup boot
  `path` labels (the e2e read surface): `restored OPFS snapshot` / `cold boot
  + capture (no valid snapshot)` / `cold retry (snapshot poisoned)`.

Executor worker spin-up costs **35–51 ms** per generation (boot-wait −
bootMs) — a P0-era figure on the 0.29 fork, and still the only recorded cost
of constructing an executor.

**P1 cold-boot ledger — build `58ae9021763d19f0`, every boot `path=cold boot
(no snapshot)`** (dev, no SW, local R2; click→ready = sup reqToReadyMs, exec
boot in parens). The cold lineage's reference rows:
- **stdlib 574 ms** (451: load-pyodide 392 · stdlib-verify 8 · post-restore 16
  · harden 1 · harness 7 · reset-image 21 @31 MB)
- **numpy 1030** (624: +mount 206 @1 tar)
- **numpy+pandas 1341** (1168: mount 200 @4 tars, bundles-fetch 126)
- **numpy+matplotlib 1472** (1025: mount 179 @5 tars)
- **all 1854** (1362: mount 197 @7 tars, bundles-fetch 150)
- load-pyodide is a steady ~360–395 ms every boot (main compile + instantiate
  + CPython init).

**P2 mid-phase verification (2026-07-22 second-opinion pass — durable
residue only; the census is regenerable via `avlo-build census --check`, and
the levers it flagged all landed in Session 16):**
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

Current state: `web/src/core/py/CLAUDE.md` ("Security invariants"). What
this file adds is the decision record and the accepted residuals:

- **Same-origin worker, no sandboxed iframe, is OWNER-SETTLED** —
  `scrubWorkerScope()` is THE authority boundary, not defense-in-depth;
  eval/Function stay by design (authority removal, not code-execution
  prevention). Don't re-litigate without new data.
- **`assertRealmHardened()` is fail-closed by design** — never let a scrub
  become a silent no-op.
- **Open residuals (accepted/deferred, do not rediscover):** (1)
  first-load-without-SW TOCTOU vs an ACTIVELY malicious origin — unclosable
  without a worse trade (`script-src blob:`); every realistic corruption
  fails closed. (2) MEMFS file mutations survive blit resets — MEMFS is
  JS-side, so a planted `_avlo_pruned_*.py` can be re-imported across runs
  within one generation (authority-free, contained); any real fix has to put
  the FS inside whatever the reset rewinds. (3) `subprocess`/`multiprocessing`
  are blocked by wasm-syscall absence, not policy.

## Hard-won learnings (do not re-derive)

**Determinism + the build graph:**
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

**Perf + benchmarking:**
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
  of bug can never be silent again: `avlo-build stage`'s prestage occurrence
  count (≥2 in the glue) + the py-integration pre-harden own-property
  `wasmTable.get` census (≤16 crossings /10k). Snapshot-safe by construction: the preRun
  hook runs on EVERY boot (cold + restore), `addFunction` mints the same
  index both sides, `tableLenAtCapture` asserts are the tripwire.
- **`grep -c` on minified glue LIES** — it counts lines and both trampoline
  occurrences share one line; count with `grep -o X | wc -l` (stage splits
  on the needle). Cost a full false-regression investigation; the
  `EMCC_DEBUG=1` emcc-NN-*.js artifact chain is the debugging tool if a
  real emission failure ever appears.
- **Bench discipline: pin the CPU boost policy for the WHOLE session and
  stamp it in the ledger line.** A mid-session Windows processor-boost
  shift (efficient-aggressive → …-at-guaranteed → aggressive; ~2.9 vs
  ~4.2 GHz) contaminated every absolute number and manufactured a fake
  "~30% -O3 win" — the clean same-policy interleaved A/B read ~0–3% ⇒
  **-O2 stays**. Only `*-agg-*`/`V1-ship-agg` rows in
  `bench/ledger-2026-08.jsonl` are clean; always interleave A/B pairs.
- **The fork's interpreter baseline is ~2× stock CPython-emscripten**
  (fib 17.4 vs 34.3 ms, measured both ways on one box). Unbisected suspects:
  `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` vs default JS-based EH,
  MAIN_MODULE=2, and the pyodide link recipe. Two consequences that keep
  mattering: an interpreter-perf result measured against stock does NOT
  transfer here (the same A/B inverted between fork and standalone on one
  machine, and flipped again between hosts), and a published "+N% win" is
  usually against headroom this fork already banked — so name the baseline
  build or the number means nothing.
- **Tail-call dispatch was measured and REJECTED** (variant 0: geomean +25%
  steady-state, worse under Liftoff too; V8's per-bytecode
  `return_call_indirect` pays table-bounds + signature check + frame
  bookkeeping where the megafunction pays one `br_table` with everything in
  locals). Only re-open it with the gate in hand: **without `-mtail-call`,
  clang ignores `musttail` with a warning only**, so a "tail-call build"
  compiles fine and silently doesn't tail-call — `ceval.o` must carry
  `tail-call` in `target_features` (the LINKED wasm carries none — check the
  object). Kit + full data: `bench/v3-tailcall-patches/`,
  `bench/tailcall-bridge/`.
- **-O3 structural hazard (remote session 2026-08-03; reversion already
  stood on flat perf):** -O3 barely touches the eval loop (78,942 →
  78,485 B) but inlining mints a NEW 157,736 B function — 2× the
  megafunction — while code section grows 4.06 → 4.32 MB. Under lazy
  compilation that is a first-call latency spike on whatever path calls
  it, and `avlo-build budgets` cannot see per-function shape. -O2 stays;
  `bench/builds/v2-o3-ref/` retained for reference.
- **cpython staleness is a Dockerfile layer question now:** the `cpython`
  stage is keyed on `Makefile.envs` + `cpython/Setup.local` (both
  `COPY --from=patched`, content-addressed) + `patches/cpython/`, so a
  Makefile.envs-only change (e.g. OPTFLAGS) DOES rebuild cpython — the old
  build.sh silently didn't, and A/B'd stale objects against a fresh flag
  line. In a `fork --dev` volume the old make-level traps are back (make
  links against the INSTALL tree — nuking only `cpython/build/` relinks a
  stale libpython; a Makefile.envs edit rebuilds nothing): that lane is for
  iteration, canonical bytes come from the Dockerfile path only.
- **"Full cpython nukes are not byte-reproducible" — ROOTED and closed
  (2026-09-02).** The 13,912 scattered bytes at identical size were ONE
  string: `Modules/getbuildinfo.c` embeds `__DATE__`/`__TIME__`, wasm-ld
  tail-merges `.rodata` strings into a content-SORTED table, so a different
  `hh:mm:ss` lands at a different sorted position and every address after
  it shifts. Receipts (shipped vs the Aug-3 rebuild, bucketed per section):
  code 1,258 bytes in 280 functions = 1–2-byte `i32.const` immediates; data
  12,654 = the pointer at the tail of hundreds of small structs; after the
  divergence point the shipped bytes match the rebuild at exactly +9 =
  `strlen("07:13:27") + 1`, 3000/3000. `getbuildinfo.o` is rebuilt on EVERY
  libpython relink (it depends on all other objects), which is why even an
  unchanged tree never reproduced itself. Fix: `SOURCE_DATE_EPOCH` (clang
  ≥16 honors it for both macros — verified on the emsdk clang) as a config
  PIN (`fork.sourceDateEpoch`), with the shipped build's own instant read
  out of its wasm (`Aug  3 2026` + `05:27:00` UTC = 1785734820). The only
  other wall-clock input to `dist/raw` is the raw stdlib zip's entry
  mtimes (normalized in-build). Corollaries that stay true: byte-size
  equality is NOT byte equality; `bench/builds/v1-ship/` holds the exact
  `dist/raw` bytes behind `7fdf68788eb8a2a4` (wasm/glue/types still
  today's; only the loader constant + raw-zip normalization moved at the
  phase-3 rotation). Build A of the Dockerfile lane reproduced the shipped
  wasm byte-for-byte with the pin, and build B (cpython layer cached,
  ccache warm) matched A across all six exports. The ONE other
  non-determinism was upstream's BUILD_ID race (patch 0010).

**Boot / restore mechanics:**
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
  driver re-checks it after callMain (F4). The py-integration suite's uniform
  cold boot + identical hiwire expected-keys table is the standing
  equivalence proof.
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

  **Tag glossary** — the codes `core/py/` comments cite; grep the tag rather
  than trusting a line number. Live set (verified): F1–F7, F9–F16, U4, U6,
  U7, U9. F8, F17, U5 and U8 were folded away and appear nowhere.
  - **F1** — every detached task captures `w`/`token`/`gen`, never module
    vars; posts only behind a synchronous `live()` check.
  - **F2** — teardown/supersession bumps `spawnToken`; stale tasks go inert.
  - **F3** — mute `worker.onmessage = null` BEFORE `terminate()`.
  - **F4** — cold-main failures do NOT wrap in `DirtyRestoreError`; running
    cold over an ABORTed runtime is forbidden.
  - **F5** — a `DirtyRestoreError` retry boots WITHOUT the snapshot feeds:
    retrying the same failing cold boot would loop.
  - **F6** — every executor-side await has a guaranteed sup-side completion
    signal (boot-data / snap-header / snap-heap / teardown).
  - **F7** — the executor parks boot feeds in module-scope deferreds; any
    arrival order is legal.
  - **F9** — poison-deletes only off a LOCK-HOLDING open rung; the buffered
    getFile rung may see another tab's mid-write bytes.
  - **F10** — all snapshot-file mutations ride the per-set `snapOps` chain;
    reads await its head.
  - **F11** — pre-touching grown wasm pages must be a value-preserving RMW
    (`Atomics.or(x,0)`) with MessageChannel yields.
  - **F12** — DSO precompile must finish inside the window before
    `hardenRealm` deletes the WebAssembly compile surface (the same window
    replay uses).
  - **F13** — download-progress posts are live()-guarded.
  - **F14** — span closers are live()-guarded (stale closer → wrong trace line).
  - **F15** — transferred buffers are nulled at the post site, never retained.
  - **F16** — `gen.snapAbandoned`: after exec-snap-invalid the executor
    provably never awaits snap-heap; in-flight T3 reads stop posting.
  - **U4** — exec-snap-invalid ⇒ delete only, NO respawn (the cold boot's
    capture re-persists).
  - **U6** — a restored generation's first-run hard failure poisons the
    snapshot file BEFORE the eager respawn, chained on snapOps.
  - **U7** — replay uses the verbatim ABSOLUTE paths from the recorded
    loadOrder.
  - **U9** — the buildId assert runs PRE-grow: validate before mutating.

**Snapshots / capture:**
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
  confirmed via `__hiwire_get` walk, and the py-integration suite dumps the
  live table on any mismatch so a boot-sequence change re-derives in one
  command.
- **`Worker.terminate()` does not stop a wasm busy loop promptly** — the
  thread spins to its next yield, so a shared interrupt SAB keeps being
  consumed and the NEXT executor's first interrupt vanishes. Why a fresh SAB
  per generation still stands even though the interrupt is disarmed; if
  signal-based cancellation ever returns, 50 ms SIGINT repeats do too.
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
- **git-native patch editing:** the `fork --dev` volume IS the
  one-commit-per-patch tree (the Dockerfile's `patched` stage commits each
  queue entry with fixed dates, so ids are stable). Re-stack it via
  `git checkout <commit>` → edit → `commit --amend` → cherry-pick the rest
  (non-interactive), then regenerate each edited patch's diff body
  (`git diff parent commit`) and splice under the kept header; verify by
  replaying the whole queue from the tag and diffing against the restacked
  tree (`TREE IDENTICAL`). Never hand-edit a unified diff. The volume is
  disposable (`fork --dev --reset` reseeds it from the current build stage)
  — export edited patches into `patches/` before resetting.
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
- **Why patch 0001 exports what it does** (the list reads arbitrary
  otherwise, and dropping `EXPORT_ALL` is why it must be manual):
  `growMemory` — upstream's `INITIAL_MEMORY` resize is a NO-OP against this
  glue, memory is wasm-exported; the dylink trio
  `LDSO,newDSO,loadWebAssemblyModule` — closure-internal otherwise, and 0005
  reads them off `Module`; `callMain` — the uniform-boot driver's deferred
  cold main.
- **emsdk patches are inert on incremental builds** — the top-level make rule
  has no emsdk prereqs, so in a `fork --dev` volume a newly staged emsdk
  patch ships an unpatched glue until `make -C emsdk` reruns. The canonical
  path has no such state: the Dockerfile's `emsdk` stage is keyed on
  `patches/emsdk/` and greps the `AVLO` marker in the installed source; the
  `build` stage + `avlo-build stage` grep the built glue. Any future emsdk
  patch must embed `AVLO` in its added lines.
- **Reading a fork build log:** the Dockerfile `RUN` shell is dash (no
  `[[`, no `\>`); `TypeError: …` lines in the `emsdk` stage are upstream
  patch 0001's commit message echoed by `patch --verbose`; `em++: error:
  no input files` in the `cpython` stage is libffi's libtool configure
  probe — both benign. Exported files carry `SOURCE_DATE_EPOCH` as their
  mtime (BuildKit applies it to the `dist` export too) — cosmetic.
- Verify emsdk behavior against the **installed SDK build**, not the git tag
  — they differ (the "5.0.3 needs a stub-throw patch" plan item died this
  way; the released SDK already throws named errors).
- **Re-patching an already-applied emsdk patch in a dev volume:** a v2 that
  overlaps an installed v1 does not apply cleanly — reverse-apply the old
  patch first (`patch -R -p1 -d emsdk/emsdk/upstream/emscripten <
  old.patch`) or just `fork --dev --reset`. The canonical build never hits
  this (fresh emsdk install per layer).
- **py-trace span meta must never use the key `n`** — `{ n, at, ms, ...meta }`
  lets a meta `n` clobber the span NAME (burned once by mount-dlopen's DSO
  count; renamed `dsos`).
- **vitest `toEqual` on multi-MB typed arrays OOMs the worker** (per-element
  deep-equal diff) — compare with `Buffer.compare`.
- **Node ESM-scope traps in the test lanes:** the venv sits under a repo root
  whose package.json says `"type": "module"`, so CJS files below it —
  pytest-pyodide's `node_test_driver.js`, the dist-view `pyodide.js` shim —
  are misread as ESM. Each needs its own `{ "type": "commonjs" }` scope
  marker (the site-packages one is written at configure time and self-heals).
  And pytest-pyodide's driver pipes results through
  `.replace("undefined","null")`, so binary readback must use HEX, never
  base64.
- **We do NOT PGO**, despite appearances: `--enable-optimizations` is passed
  but pyodide's Makefile never runs `profile-opt` (verified — empty
  `PGO_PROF_USE_FLAG`, no profdata). Don't attribute perf to it.
- Wheel-patch workbench: unpack the pristine wheel twice (`a/`, `b/`), edit
  `b/`, `diff -ru a b`. **Delete `.orig` files before diffing** — fuzzy
  `patch` leaves them and they will SHIP inside the tar (caught by size once
  already).
- Vite public-dir files can't be ESM-imported — why staged artifacts are
  always fetched, never imported.
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
  up BEFORE any pandas tz op; the corpus lane and trace-imports mirror that
  contract. The pytz bundle's only remaining role is the TZif database.
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

The gate board and per-command detail live in `packages/py-build/CLAUDE.md`
(CLI table + Gate board); the fork build is a turbo task (`py:fork`, docker
BuildKit), the recipes lane is the part that never enters Turbo/CI. Two things that doc doesn't carry: `e2e/py-snapshot.spec.ts` needs
the full `pnpm dev` stack (Playwright's webServer alone can't serve
`/api/py`) and asserts only sup `boot` trace labels + OPFS placement; the
AVS2 codec unit suite rides `web/vitest.config.ts`, deliberately outside the
artifact-gated py-integration project.

- **Last green — build `e92dd255c2de2df4` on the current pipeline**
  (2026-09-02, the phase-3 rotation: `dist/raw` from `docker/fork.Dockerfile`
  via the turbo `py:fork` task, wasm/glue byte-identical to
  `7fdf68788eb8a2a4`): py-integration 83/83 · pytest 46/46 (11 units +
  29 samples + 6 gates) · census/groups/pytree/trace/budgets green ·
  `stage --check` clean · typecheck green · local seed 23 keys. Fork-side
  determinism receipt: build B ≡ build A across all six exports (the
  `fork --repro` ccache-off double is deferred to the 314.0.6 rotation);
  pack repro doubles last run green 2026-08-31 on unchanged packers. Budgets were restamped +5% at the perf batch
  (composites numpy-path 6.88 MB br / pandas-mpl 14.00 — under the
  P1.5-era ceilings despite wasm +5.5%); post-stage probes from that batch:
  big-figure savefig 160 ms (L1 encoder live), `all` capture heap 65.4 MB,
  capture-side mpl bake 569 ms.

## Open items / backlog

- **Never verified in a browser:** V8 wasm code-cache ENGAGEMENT (the
  pristine-identity precondition is landed and storage-verified; the win
  itself is unmeasured) · multi-tab same-set concurrent restores (read-only
  sync handles; capture loser skips) · Chrome task-manager RAM (active ≈ 2×
  heap, idle beyond 15 s ≈ 0) · SW verified-route 502 negative + offline
  second-load · FF/Safari (Chrome-only to date) · prod CSP additions
  (`wasm-unsafe-eval`, py.avlo.io in script/connect-src), which land on the
  first prod deploy.
- **Parked latency levers** (receipts in the Session-16 plan): full L3
  replay-as-data + main GOT hook · standalone `.so` artifacts +
  compileStreaming + V8-disk-cache measurement · supervisor prewarm on first
  code-block interaction · main-ctors skip under restore · reset-image
  blit-source RAM mode · an FS that rides the heap image.
- **Next work block** — the executor-lifecycle rework, standalone `.so`
  artifacts, and moving the FS. Mechanism research is in
  `replatform-findings.md`, the process replatform in
  `toolchain-replatform-plan.md`; the owner's design docs are authority and
  this file must not restate them. The durable facts measured here that feed
  it:
  - `writeSetSnapshot`'s 65 MB sync chunk loop has NO inter-chunk yield
    (`readSnapshotToBuffer` deliberately does), so the capture write can
    block the sup event loop exactly when the first run wants dispatching.
    The measured case: `capture-imports` 2,189 ms rides the boot pre-ready
    and the write landed at exec-ready with ~400 ms to dispatch — hence
    "run first, capture after".
  - First-visit pipeline: glue-preflight (1,389 ms of real network)
    serializes ahead of boot-prep, and the SW-install double-fetch pattern
    shows every artifact twice in the waterfall.
  - Build-time snapshot generation (ship instead of client-capture) would
    kill `capture-imports` (~2.2 s) and the OPFS write from every first
    visit, at the cost of wire bytes; det-env is the groundwork. Docs
    describe client-capture/OPFS-only as TODAY's state — never write "never
    on the wire" as policy.
  - Add/generate more types with the custom API (owner's wording).
- **Staging lives under `web/public/`:** `avlo-build stage` writes
  `web/public/py-dev/fork/`, which Vite serves unverified at `/py-dev/*` in
  dev AND copies into `web/dist` on build (~49 MB). Moving it out of
  publicDir touches stage, publish, and the py-integration suite's paths.
- **Checksum-verified R2 puts (researched 2026-07-29 on wrangler 4.106.0 —
  do not re-derive):** `wrangler r2 object put` has NO checksum flag, so
  nothing today guards the wire/storage leg of a seed/publish (the preflight
  hashes BEFORE upload only). The R2 Workers **binding** `put()` takes
  exactly ONE of `md5|sha1|sha256|sha384|sha512` — mismatch throws and
  nothing is stored, and the checksum persists for later `head()` audits.
  Miniflare accepts multiple algorithms; never rely on that looseness.
  Upgrade route: `getPlatformProxy({ configPath, persist: { path:
  '.wrangler/state/v3' } })` → `env.PY.put(key, buf, { sha256,
  httpMetadata })` with lock shas — NOTE the CLI's `--persist-to` appends
  `/v3` but getPlatformProxy's persist does NOT. Remote leg = the same
  script with `remote: true` in a publish-only config/env (dev's `PY`
  binding must stay local). One code path for local seed AND prod publish.
- Client polish (pre-redesign backlog): live stdout streaming into the DOM
  editing overlay (run-store already accumulates it); stop-square SVG
  centroid offset in the DOM button.
- `zoneinfo` imports on the bare `stdlib` set but has no tz database until the
  `pytz` bundle mounts, and the miss leaks Pyodide's own
  `loadPackage("tzdata")` message. `_avlo_runtime.ensure_tzpath` owns that
  bridge — worth a friendlier error there.

---

## Phase log (newest first)

One entry per session: what changed, the buildHash it minted, and THE
blocker. Mechanics belong in the CLAUDE.mds, traps in Hard-won learnings —
an entry here should be readable a year later without either.

### Session 23 — replatform phase 3: the fork build as a Dockerfile (`7fdf68788eb8a2a4` → `e92dd255c2de2df4`)

`run-build.mjs` + `build.sh` — the imperative `docker run` against a mutable
4.8 GB `.work/pyodide` whose validity was re-established every run by
stamps, mtime probes and tree nukes — are gone. `docker/fork.Dockerfile`
builds from a clean clone at a pinned commit, `avlo-build fork` drives it
with every pin from `build.config.json` as a build-arg and promotes the
exported `dist` stage into `dist/raw`, and `py:fork` sits in the turbo DAG
so `dist/raw` is a derived artifact of the patch lanes + config +
`link.rsp` rather than untracked state. The layer split is content-addressed
(`COPY --from` keys on bytes): a JS-only queue edit never rebuilds cpython;
ccache rides a BuildKit cache mount. `dump-builtins` runs inside the build
(`dist/raw/builtin-modules.json`); the stock `pyodide-lock.json` moved out
of `dist/raw` into `.cache/`. **THE finding:** the "cpython nukes are not
byte-reproducible" open item was `__TIME__` in `getbuildinfo.c` landing in
wasm-ld's content-sorted merged string table — one 9-byte string shifting
13,912 bytes of addresses (full receipts in learnings). `SOURCE_DATE_EPOCH`
is now a config pin (`fork.sourceDateEpoch`), set to the instant read out of
the shipped wasm. **Gate:** with that pin a clean from-scratch Docker build
reproduced the shipped `pyodide.asm.wasm`, `pyodide.asm.mjs`, `pyodide.d.ts`
and `builtin-modules.json` byte-for-byte and the staged stdlib zip packed
from its normalized raw zip is the shipped `df012867…`; the one drift was
`pyodide.mjs`'s 64-hex `BUILD_ID`, which upstream computes by piping two
read streams concurrently into ONE hash (a race — four runs, three values,
the container build losing every wasm chunk). Patch `0010` hashes
sequentially (`sha256(asm.mjs ‖ asm.wasm)`, stable), and adopting it is
THE rotation of this session: 60 loader bytes, nothing else. The dev loop lost with `.work` comes back
as `fork --dev` (a persistent volume seeded from the `build` stage; outputs
land in `dist/dev-raw`, which stage cannot read), and `fork --repro` is the
fork-side determinism double.

### Session 22 — replatform phase 2: tests (no build change, no rotation)

`run-corpus.mjs`, `run-harness.mjs` and `lib/{ts-resolve,png}.mjs` deleted
once their replacements went green on the SAME artifacts (`7fdf68788eb8a2a4`
untouched). Both suites are current-state in `packages/py-build/CLAUDE.md`:
a **pytest-pyodide corpus lane** (samples stay DATA, one module per group =
one boot, mounts are PURE PYTHON via `tarfile.extractall` with DSOs loading
by natural import through the sitecustomize finder — parity with the shipped
walker stays proven by `mount-parity.test.ts`) and the **web py-integration
vitest project** (the five old harness sections as five files, 83 tests,
fork-per-file, artifact-gated and deliberately out of the root `projects`
array). Count drops vs the old runners are deliberate, not lost coverage:
codec negatives stay in the `py-snapshot.test.ts` unit layer and pixel
QUALITY moved to the pytest pillow gate (py-integration asserts dims only).
vitest's forks pool tolerates `scrubWorkerScope` + `hardenRealm` with frozen
intrinsics — no framework breakage. The sqlite corpus group was deleted, its
unique axes (file-VFS reopen persistence, storage classes + Row + rollback)
folded into `basic/b08_sqlite.py`. Root `pnpm test:py` = `turbo run test:py`
fanning to both, both cached on inputs. Node ESM-scope landmines hit here
are in learnings.

### Session 21 — replatform phase 1: orchestration (bytes frozen, no rotation)

`buildHash 7fdf68788eb8a2a4` held constant as the total regression oracle
while everything around it moved: a repo-root **uv workspace**, `avlo-build`
as a real src-layout package with a pydantic config model (every former
`$comment` became a field description), fontTools moved INTO the env at the
`hostTools.fonttools` pin, every Node script ported under byte-or-verdict
gates, and `board.mjs` replaced by a **turbo DAG** (verified empirically:
explicit `inputs` globs DO hash gitignored files, which is what lets the
docker lanes stay manual). Repro doubles moved off the default board.
**THE finding:** pyc bytes are a function of the compiling process's import
history — a refactor-shaped time bomb that the port itself triggered. Killed
with hermetic `_pyc_worker.py` subprocesses on a FROZEN import surface; full
mechanism in learnings. Also fixed in passing: an off-by-one in the dylink.0
subsection walk (harmless on shipped MEM_INFO-only dylinks, wrong for
NEEDED-bearing ones; caught by a synthetic-module unit test).

### Session 20 — tail-call cross-verification (no build change)

Audited a remote session's standalone-CPython tail-call sweep (draft PR #16)
and ran bridge experiments. The report was internally honest but its verdict
did not transfer: the same A/B inverts between the fork and stock builds on
one machine. That is the durable finding, and it lives in learnings ("the
fork's interpreter baseline is ~2× stock CPython-emscripten"). Fork
variant-0 rejection re-confirmed on the remote's own suite. Data + protocol:
`bench/tailcall-bridge/`.

### Session 19 — 2026-08 perf batch (`e210f3a9a140f04b` → `7fdf68788eb8a2a4`)

One rotation carrying the whole batch. **A1** the dead wasm-gc trampoline
fixed (the smoking gun; post-mortem in learnings) plus two permanent gates.
**A2** a cpython patch lane (`patches/cpython/` staged ≥0010, auto-nuke of
build+installs on lane change) — first occupant `0010` trampoline arity
reorder. **A3** the experiment verdicts, all re-derived after a mid-session
CPU-boost-policy shift contaminated the first pass: -O2 ships, -O3 reverted,
tail-call variant 0 rejected, mimalloc rejected. **B** the interrupt
disarmed — cancel is now a blunt kill + eager respawn (the armed signal
check taxed every run 2–4.5%); the UI seam stays wired for a future real
cancellation. **C** `_avlo_png.py` rewritten to streaming zlib L1, and the
matplotlib bundle bakes a throwaway figure so Agg/font/encoder warmup lands
in the capture image. **D** the standalone `numpy` set dropped. **E** fork
API types (patch `0009`, type-only, wasm byte-identical) so `py-loader`'s
`Pyodide` is a real type. **F** script parallelism + the one-command board.
Epilogue: the post-experiment cleanup rebuild came back functionally correct
but NOT byte-identical (cpython-nuke non-reproducibility — learnings), so
`dist/raw` was restored from `bench/builds/v1-ship`, the exact bytes the lock
and seeded R2 reference.

### Session 18 — dead-on-import stdlib sweep (`e210f3a9a140f04b`)

Started at "`py-stdlib-modules.gen.ts` looks outdated". It wasn't — **the lie
was in the zip.** The reusable method: boot the fork on the STAGED zip and
`import_module` all 476 shipped modules. 49 failed, only 23 deliberately;
five were top-level allowlist entries that passed the click-time gate and
then died (`cProfile`, `plistlib`, `pdb`/`pydoc`/`doctest`), because the
prune list had drifted from patch 0003's `*disabled*` list — now a hard gate.
Swept those plus `multiprocessing/` whole, `urllib/{request,robotparser}`,
`logging/config`, 27 `encodings/` leaves and more into precise tombstones:
**zip 3.34 → 2.84 MB (−15.0%)**, wire AND resident. Safety proof per entry
was a `co_names`+`co_consts` scan over every shipped pyc followed by a source
check that each package hit is a LAZY in-function import — worth repeating
verbatim before any future prune.

### Session 17 — ledger re-record + doc/comment/dead-code cleanup

Recorded the owner's post-L2 browser board (the 2026-07-29 ledger in Current
state), rewrote all three py CLAUDE.mds to present-tense current state, and
swept stale comments and dead code on both the client and build sides. No
artifact bytes touched.

### Session 16 — cold-restore attack: L1 walker + L2 topology flip + knives

Attacked the `all`-set restore's 1,123 ms click→ready, where mounts ate ~70%
of every boot. **L1**: `py-mount.ts` grafts tar trees straight into MEMFS via
parent node refs with adopted subarray contents — 855 → ~11 ms, byte-identical,
and the zero-diff parity check became a standing gate. **L2**: the supervisor
spawns the executor FIRST and streams it boot-prep/boot-data/snap-header/
snap-heap, so glue, bundles and ALL OPFS I/O hide in the spawn shadow; boots
became uniform under `noInitialRun` with the async preBlit driver deciding
restore-vs-cold in flight. The F1–F17 task discipline came out of this and
closed three pre-existing live races (muted-terminate forged-capture window,
snapOps delete-vs-probe, unguarded download progress). **Knives**:
`freeDsoFileData` on cold boots, −14.7 MB. Build rev `f440369a4275be9a`.

### Phase 2 — owned dense snapshots (Session 15, `284d8a1`+`af14670`)

Deleted pyodide's `_loadSnapshot`/`_makeSnapshot` and owned the snapshot
end-to-end: the AVS2 dense container, client capture at the pre-harden slot,
restore through the new `_avloRestore.preBlit` seam. **THE blocker:** the
first grouped replay faulted OOB inside `__wasm_apply_data_relocs`/ctors —
`runtimeInitialized` is true pre-blit, so upstream ran a merged init set
against the fresh heap that READS captured state. Fix: skip both under replay
(the blit supplies their effects), landed as the emsdk 0006-v2 hunk after
reverse-applying v1 from the installed tree. buildHash → `267194ca75197030`.
Restore ledger: stdlib 193 ms / numpy+pandas 828 / `all` 1,123 click→ready
(vs 574/1,341/1,854 cold) — `all` missed its ≤900 target on the extract slice
alone, which is what Session 16 then attacked.

### Phase 1.5 — DSO grouping 67→4 (Session 14)

Recipe-rebuild loop → link records → harvest → one `-sSIDE_MODULE=2` link per
DSO-bearing bundle, plus the packaging/runtime swap to `.avlo/<bundle>.so` +
the `_AvloGroupFinder`. **THE blocker:** numpy's group link died on a
`random_multinomial` signature mismatch — mtrand compiles its own
`distributions.c` under `-DNP_RANDOM_LEGACY` (`RAND_INT_TYPE` = i32) while
`_generator` et al expect libnpyrandom.a's i64 copies, and in one link
mtrand's immediate object defs shadow the LAZY archive members (same-signature
cases would mis-bind SILENTLY — wasm-ld only errors on signature mismatch).
llvm-objcopy refuses all symbol ops on wasm objects, so the planned
harvest-time rename was impossible; fixed at COMPILE time instead, via 66
`#define x __avlo_legacy_x` lines under the existing legacy guard. harvest-links
now carries a permanent per-bundle duplicate-strong-def collision gate.
Constraints had to be frozen PER PACKAGE after a single-file design proved
unsatisfiable. Step-0 stub audit, for the parked incremental-GOT idea:
self-GOT imports SURVIVE the group relink (emscripten#23107), so the predicted
`link.rsp` shrink never materialized (1,764→1,761). buildHash →
`bc46093ffa4fb5e8`.

### Phase 1 — toolchain jump + link-model flip (Sessions 12–13)

Loop A: pure rebase 0.29.4 → 314.0.2 at MAIN_MODULE=1. Loop B: the
MAIN_MODULE=2 flip — the first attempt put all 67 DSOs on the link line and
died at boot on weak-COMDAT preemption (root cause and fix in the closed-world
section); the second failure class was the no-EXPORT_ALL Module surface.
buildHash `58ae9021763d19f0`. Corrections found en route: `mergeLibSymbols`
walks the SIDE module's exports (so `=2` doesn't shrink the per-dlopen merge);
non-relocatable main modules landed in emsdk 4.0.19, free via the jump;
`_lzma` was never enabled in our fork; zero emsdk patches were needed at this
stage; and 314 still ships the full loader machinery, so patch 0006 survived
nearly verbatim.

### Phase 0 — always-on trace + baseline ledger (Session 11)

`py-trace.ts` + marks through supervisor/executor/loader/snapshot + the
exec→sup→main relay. Confirmed the prediction that ~75% of the dso-replay
span is glue-side GOT/merge bookkeeping, not wasm work — the fact that made
DSO grouping the obvious next move.

### Pre-redesign milestones (0.29.4 era — superseded, kept as one paragraph)

Fork + patch queue + deterministic packing pipeline built (M1–M2) · canvas
runtime landed: protocol/sab/harness/run-store/supervisor/executor/manager,
play/stop UI, cancel/timeout, traceback with user source · worker serving +
build-lock + publish/seed (M3) · same-origin hardening: scrub, harden,
fail-closed assert, Node harness (Sessions 5–6) · fork patches 0006/0008
(Session 7) · lock-verified artifact serving via SW + constructor freeze
sweep (Session 8) · sqlite3+seaborn bundles (Session 8) · client-side OPFS
snapshot boots + py edge cache (`5abdf63`) · figures→canvas pipeline + output
WYSIWYG parity (Session 9) · py tooling moved into packages/py-build, uv
adoption, test scaffolding (Session 10). Durable knowledge from all of it
lives in the sections above; per-session gate boards are in git history
(commits 3ec5374…5abdf63) if archaeology is ever needed.
