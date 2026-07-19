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

## Current state — Phase 1 COMPLETE (committed), next up: Phase 2

- **Toolchain:** Pyodide **314.0.2** / CPython **3.14.2** / emsdk **5.0.3** /
  ABI `2026_0`, **MAIN_MODULE=2** closed world (see next section). Image
  `pyodide/pyodide-env:20260211-chrome145-firefox146-py314` (digest pinned in
  `build.config.json`). Glue is **`pyodide.asm.mjs`** (ESM; renamed from
  `.asm.js` in 314).
- **buildHash `58ae9021763d19f0`** (committed in `packages/py-loader/build-lock.json`),
  seeded to local R2 (23 keys). Commits: `c6db3ea` (P0 trace+ledger),
  `479b0f0` (P1 Loop A rebase), `8653e84` (P1 Loop B flip + lock + seed).
- **Sets:** `{stdlib, numpy, numpy+pandas, numpy+matplotlib, all}` — stdlib is
  the implicit no-bundle set; the other four are `build.config.json` `sets`.
  sqlite3 is **static in the main module** (314 upstream) — its old wheel,
  bundle, and standalone set are gone; `import sqlite3` works on every set.
  `PySetKey` is codegen'd by `stage.mjs` into `py-stdlib-modules.gen.ts`
  (py-protocol re-exports it type-only); `bundlesOf`/`resolveImports` are
  fail-closed on unknown keys.
- **Snapshots are PARKED — every boot is cold** (fetch + mount + in-run
  imports). Gate: `SNAPSHOTS_ENABLED = false` in `py-supervisor.ts` at the
  `useSnapshot` seam. Parked machinery (dormant, NOT deleted): client
  `py-snapshot.ts` (AVS1 sparse codec + OPFS wrapper) + capture legs in
  executor/supervisor; `patches/parked/` holds pyodide 0005 (DSO
  record/replay), 0007 (snapshot meta v1), 0008b expected-keys reference,
  emsdk dsoBaseHook. `package.json` `baseline`/`verify:stacking` are stubbed
  to loud errors; `make-baseline.mjs`/`verify-stacking.mjs` remain on disk as
  reference. **P2 replaces all of this** (container v2, build-side Playwright
  capture, client restore-only — the client capture path gets deleted, not
  revived). Stale OPFS snapshots on dev machines are inert (≤1 GB, GC'd by
  P2's buildHash rotation).
- **Live fork patches:** pyodide `0001` (linkflags/memory/exports — carries
  the whole Loop-B link model), `0003` (drop C extensions; 314 upstream now
  disables pwd/_ssl/_hashlib/_uuid itself and adds static `_hmac`+`_sqlite3`,
  both kept; we add `_zstd`; `_lzma` stays disabled — it was never enabled in
  our fork), `0006` (drop loader machinery — survived 0.29→314 nearly
  hunk-for-hunk), `0008` (js-bridge closure, api.ts one-liner only; its
  snapshot.ts expected-keys hunk is parked). **Zero emsdk patches** — 5.0.3
  already throws named errors on both unresolved-symbol surfaces (lazy stub
  and GOT), so the planned stub-throw patch is upstream behavior.
- **Wheel patches (all re-derived against current wheels):** matplotlib
  0001 rc-backend-agg / 0002 pillow-ectomy / 0003 lazy-plistlib; pandas
  0001 no-toplevel-ctypes / 0002 lazy-ctypes-interchange; dateutil 0001
  quiet-pruned-tzdata; seaborn 0001 lazy-urllib / 0002 pydoc→inspect.
  Wheels: numpy 2.4.3, **pandas 3.0.2**, matplotlib 3.10.8, seaborn 0.13.2
  (URL-pinned — absent from the stock lock), pillow/fonttools traceOnly.
- **Serving:** `workers/py` serves `<buildHash>/<file>` with brotli `.br`
  siblings **and an edge cache** (`caches.default` with synthetic
  per-encoding-class keys — this superseded the earlier "no edge cache,
  variant poisoning" stance; see `workers/py/src/index.ts` header). SW:
  `verifiedPyFirst` for the 4 core artifacts (byte-verified vs the lock on
  every hit AND before every write, 502 fail-closed), `cacheFirst` for tars
  (`avlo-py-<hash>` cache, supervisor is their verifier), stale generations
  evicted on activate. P4 will relax hit-verification to at-fill-only.
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
  link-sos block scans every post-prune DSO's dylink imports **in-memory from
  the wheels** (67 DSOs, 1,764 func/global/tag symbols, `invoke_*` excluded)
  and emits `.cache/link-sos/link.rsp` = one `-Wl,--export-if-defined=<sym>`
  per symbol. That reproduces the only effect we need from emcc's
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
- Verification chain: SW `verifiedPyFirst` (4 core artifacts, verify on every
  hit + before write) · supervisor `ensureGlueVerified()` once per page
  (covers dev/no-SW) · tars sha-gated by the supervisor, Cache-API hits
  RE-verified (the SW writes tars unverified) · `verifyStdlibZip` hashes the
  stdlib AS MOUNTED vs the boot manifest. `@avlo/py-loader`'s `./verify`
  subpath is the shared predicate (dependency-free; Node harness imports the
  exact shipped code).
- **Open residuals (accepted/deferred, do not rediscover):** (1)
  first-load-without-SW TOCTOU vs an ACTIVELY malicious origin — unclosable
  without a worse trade (`script-src blob:`); every realistic corruption
  fails closed. (2) MEMFS file mutations survive blit resets — a planted
  `_avlo_pruned_*.py` can be re-imported across runs within one generation
  (authority-free, contained); real fix is P3 WasmFS (FS rides the heap
  image, blit resets it). (3) `subprocess`/`multiprocessing` are blocked by
  wasm-syscall absence, not policy.

## Hard-won learnings (do not re-derive)

**Snapshots / capture (P2 must honor all of these):**
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
- **emsdk patches are inert on incremental builds** — the top-level make rule
  has no emsdk prereqs, so a staged patch ships an unpatched glue.
  `build.sh` direct-applies missing patches, force-relinks when one fires,
  and greps an `AVLO` marker in BOTH the installed source and the built glue.
  Any future emsdk patch must embed `AVLO` in its added lines.
- Verify emsdk behavior against the **installed SDK build**, not the git tag
  — they differ (the "5.0.3 needs a stub-throw patch" plan item died this
  way; the released SDK already throws named errors).
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
- **Last-green (P1):** Gate B on the =2 build — corpus 7/7 groups (basic 6 ·
  sqlite 3 stdlib-static · numpy 4 · pandas 5 · mpl 4 · all 2 · seaborn 6
  w/ 4 PNGs pixel-decoded) · budgets restamped (composites: numpy-path
  7,702,265 br / pandas-mpl 15,361,657 br ceilings; measured 7.34/14.63 MB) ·
  typecheck 12/12 · vitest 3/3 + 2/2 · seed 23 keys. Harness last recorded
  green at Gate A (Loop-A build: base 41 · seaborn 22 · verify 8) — it was
  not re-recorded on the Loop-B build, so run it before trusting it green
  there.
- **Browser dev board (Gate-B matrix, all green on the current build):**
  stdlib print/echo + sqlite3 `:memory:` CRUD · `import ctypes` +
  `import compression.zstd` → precise tombstones · numpy 4.0 · pandas
  groupby + `pd.read_sql` roundtrip · mpl figure placed with auto-connector ·
  seaborn scatterplot (all set) · `import requests` instant refusal (marquee
  bills sqlite3 via STDLIB_MODULES) · cancel mid-loop · 30 s soft timeout ·
  idle-teardown + eager respawn healthy.

## Open items / backlog

- **P2 SW change required:** `.snap` currently falls through to `cacheFirst`
  — per-set snapshots (~100 MB) would double-store in CacheStorage next to
  OPFS. Add the explicit passthrough branch when snapshots return.
- **Preview-board pass never done** (needs `vite preview` + SW, not the dev
  path): SW verified-route 502 negative + no-cache-write, offline
  second-load (nested-worker-under-SW validation), zero `/py-dev/fork/`
  product-fetch sweep, guard-stripped `import js` probe in real Chrome (the
  Node harness covers the closure board meanwhile).
- SW `cacheFirst` tar put races the supervisor's identity-normalized put on
  the same key — self-healing (hits are re-verified) but watch on the
  preview board.
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
