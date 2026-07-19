# py-build working notes (in-flight state)

Redesign plan (P0–P5, authoritative):
/home/issak/.claude/plans/docs-local-py-runtime-redesign-condense-parsed-piglet.md
Master plan (pre-redesign): /home/issak/.claude/plans/prompt-md-i-copied-my-synthetic-octopus.md

## Session 11 — Redesign Phase 0 DONE: boot trace + baseline ledger

- **Landed**: `web/src/core/py/py-trace.ts` (always-on span buffer →
  `performance.measure` + ONE `console.info('py:trace', json)` per boot/run
  per thread; dependency-free) with marks threaded through py-supervisor
  (spawn/glue-preflight/snapshot-read/baseline/bundles/boot-wait/req-to-
  dispatch/run), py-executor (boot-pyodide/mount/stdlib-verify/post-restore/
  capture-* /harden/harness/reset-image; run-python/figures/blit/post-run-
  reset), py-loader (glue-import/load-pyodide/tree-write/dso-replay with
  per-DSO max), py-snapshot (opfs-read/snap-verify-sha/snap-reconstruct/
  snap-encode/snap-seal-sha/opfs-write). `installWasmTimers()` shims the
  WebAssembly compile surface for the boot window only (uninstalled BEFORE
  scrub/harden — `Instance` isn't on harden's delete list and must not stay
  wrapped) → splits side-module compile/instantiate out of replay without
  touching the glue.
- **Trace relay** (pulled forward from the P2 e2e plumbing): worker console
  is invisible to automation, so `traceEmit` routes through a sink —
  executor→`exec-trace`→supervisor→`trace`→main; py-manager owns the single
  visible console line + a 100-line ring buffer exported as `pyTraceLines`
  (`window.__avloPyTraces` in DEV). Protocol grew `ExecTraceMsg`/`TraceMsg`.
- **BASELINE LEDGER** (dev board: Chrome via local miniflare workers, no SW,
  WSL2; buildHash `01ba07e1133d0342`, fork 0.29.4. The redesign targets
  table compares against THESE numbers per phase gate):
  - **stdlib, baseline restore (Cache API hit), cold page** (n=1):
    click→ready **419 ms** = sup spawn 88 (baseline read+verify 68 ∥ glue
    preflight 87) + spin-up ~51 + exec boot **279** (glue-import 4 ·
    load-pyodide 186 [main instantiateStreaming 36 · 8 side Modules 0.7] ·
    stdlib-verify 11 · post-restore 54 · harden 0.8 · harness 16 ·
    reset-image 5 @21 MB). Warm run 13 ms (python 4.6 · blit 2.4 ·
    post-run-reset 5.1).
  - **all, OPFS stacked hit, cold page** (n=2, + 1 warm-sup sample):
    click→ready **1224–1252 ms**, click→result 1257 = sup spawn **360–382**
    (opfs-read 191–196 @107 MB · snap-verify-sha 106–135 · snap-reconstruct
    25–29 @1011 pages→75 MB; glue preflight 77–82 overlapped) + spin-up
    ~35 + exec boot **803–877** (tree-write 104–108 @154 dirs/1553 files/
    40 MB · dso-replay **428–464** @67 DSOs [side compile: Module n=75
    82–86 + Instance n=74 26–29; max single replay _multiarray_umath
    18–22] · main instantiateStreaming 40–43 · stdlib-verify 12 ·
    post-restore 8 · harness 23 · reset-image 20–24 @75 MB). Run 29 ms
    (python 12 · blit 8.6 · post-run-reset 6.9).
  - **all, generation (OPFS miss, Cache-API-warm tars), cold page** (n=1):
    click→ready **4588 ms**, click→result 4609 = sup spawn 683 (bundles
    fetch+re-verify 611 · baseline 67 · preflight 71 · OPFS miss probe 10)
    + exec boot **3735** (baseline restore 239 · mounts Σ≈1518: pandas 519,
    pytz 334, numpy 315, matplotlib 142, sqlite3 91, mpl-deps 66, dateutil
    30, seaborn 21 [async instantiate n=68 = 120 ms] · **capture-imports
    1777** · capture-snapshot 39 · pack-tree 86 · reset-image 23); sup
    post: snap-encode 48 + snap-seal-sha 124 @107 MB (opfs-write completed
    off-trace). Self-heal verified live: deleted `all.snap` → generation →
    reload → clean stacked restore.
- **Prediction 1 CONFIRMED (structure)**: pre-spawn = OPFS read + SHA +
  reconstruct (322–355 of the 360–382 ms spawn) + glue hashing overlapped.
  Magnitude on THIS box is ~360–380 ms, not the plan-context ~670 — the
  trace is the arbiter; deltas measure against this ledger.
- **Prediction 2 CONFIRMED (first order)**: of dso-replay 428–464 ms, real
  wasm work is only 108–115 ms (compile+instantiate) → **~320–350 ms is
  glue-side bookkeeping** (mergeLibSymbols + reportUndefinedSymbols + LDSO
  registration) ≈ 40% of the whole boot, ~75% of the replay span.
  Per-function attribution needs a worker CPU profile (automation can't
  reach nested workers); Loop-B's incremental-GOT patch proves causality by
  delta instead.
- **Surprises worth keeping**: `all` tree is 1553 files/40 MB (the "~380
  writes" in the plan context was the numpy set) · pytz mount is 334 ms —
  wildly disproportionate to its size (many-small-files extractall) — dies
  with P2/P3 anyway · the baseline stdlib restore replays 8 side Modules
  (baseline's own dso list, 0.7 ms) · executor worker spin-up costs
  35–51 ms per generation (boot-wait − bootMs) · no-SW dev numbers can't
  see the SW re-buffer cost the P4 overhaul removes — re-baseline via
  `vite preview` at P4 if the prod path needs its own before/after.
- **Gate**: `pnpm typecheck` 12/12 · trace JSON captured for stdlib +
  all-set boots (hit, generation, warm-run, blit) · ledger committed.
Pickup plan (session 3): /home/issak/.claude/plans/original-prompt-was-here-graceful-cocke.md
Slice plan (session 4): /home/issak/.claude/plans/packages-py-build-notes-md-view-the-two-zazzy-pascal.md
Session-4 tasks: #1-3 Commit 1 (P1 hardening), #4-13 Commit 2 (M2 Steps 0-9).
Slice plan (session 7): /home/issak/.claude/plans/packages-py-build-notes-md-home-issak-c-scalable-quiche.md
Slice plan (session 8): /home/issak/.claude/plans/home-issak-claude-plans-prompt-md-i-cop-toasty-flask.md

## Session 10 — tooling/test cleanup (pre-314 rewrite) + direction grounding
- **Repo hygiene**: Python project config moved OFF the repo root INTO
  `packages/py-build/` (`pyproject.toml` scoped to pytest-only + its config,
  `.python-version`, regenerated `uv.lock`). Root no longer reads as a Python
  project. `pnpm test:py` → `uv run --directory packages/py-build pytest`.
  Leftover root `.venv` removed.
- **uv put to work correctly**: (1) the mpl-font subset's determinism-critical
  fontTools switched from `venv`+`pip` to `uvx --from fonttools==<hostTools pin>`
  in `pack-package.py` — SAME exact pin (byte-repro unaffected — the pin, not
  the installer, fixes the subset bytes), now cache-deduped across worktrees;
  `hosttools_python()` + the `.cache/hosttools` venv are deleted. (2)
  `scripts/subset-{museomoderno,schibsted}.py` fixed (`client/`→`web/` paths,
  dead `.venv` refs dropped) + made PEP-723 self-contained (`uv run
  scripts/subset-x.py`; `fonttools[woff]` inline). (3) numpy dropped from any
  committed env — it was never a subset-script dep; ad-hoc via `uv run --with
  numpy` when pixel-debugging renders.
- **Test scaffolding kept as-is** (vitest node + pool-workers, playwright,
  pytest; TESTING.md): sound and survives the rewrite.

### 314 rewrite direction (researched this session — NOT yet acted on)
- **Target**: pyodide `0.29.4 → 314.x` (CPython 3.13→**3.14.2**, Emscripten
  4.0.9→**5.0.3**, ABI `2025_0`→**2026_0**, wheel tag `pyemscripten_2026_0`).
  New scheme: major = CPython minor (314=3.14, next 315=3.15, ~annual).
- **Own the snapshot like workerd** (`dev/workerd/src/pyodide/snapshot.ts`):
  do NOT call pyodide `_loadSnapshot`. Drive raw Emscripten — memcpy heap →
  `Module.HEAP8`, then **`Module.API.finalizeBootstrap(fromSnapshot,
  deserializer)`** (hiwire captured via `Module.API.serializeHiwireState`).
  Their container = magic + JSON-meta + heap-copy (≈ our `baseline.snap`). DSO
  record/replay (`recordDsoHandles`/`getMemoryPatched`/`preloadDynamicLibs`) is
  what our patch 0005 + emsdk dsoBaseHook + `_preRestoreHook` already do;
  baseline vs dedicated snapshot = our baseline vs per-set stacked.
- **Patch-friction fix**: workerd string-patches `pyodide.asm.mjs` post-download
  (`src/pyodide/helpers.bzl` `_REPLACEMENTS`) over a fetched release
  `pyodide-core-<ver>.tar.bz2` — NO source fork / docker for
  sandboxing/dynlib/entropy/module-format. Only the C-extension drop (our 0003)
  truly needs the rebuild. Candidate: collapse most of 0001/0005/0007/0008 into
  glue string-patches, keep docker for 0003 only.
- **314 base changes that delete our work**: sqlite3 + lzma now bundled in base
  → **drop the set-riding sqlite3 bundle AND its snapshot** (owner call — too
  small to warrant a snapshot regardless); `ssl` is a stub; no builtin package
  lock (vendored `.so`s via `loadDynlibFromVendor`); the full tarball ships a
  top-level `fonts/` but for *matplotlib-pyodide* (canvas backend) — our Agg
  mpl-data DejaVu subset likely still stands (VERIFY during the rewrite).
- **Versions**: fonttools latest 4.63.0; 314 bundles 4.62.1; our hostTools pin
  4.56.0 (bump during the rewrite if the subset gate stays green). CF's Pyodide
  lead = Hood Chatham (also CF Python Workers); CF's `pywrangler` packaging is
  uv-based — validates the uv direction here.

## Session 9 — figures → canvas images + connectors, review sweep, WYSIWYG fixes
- **P4 figure pipeline LANDED** (client-side only, no rebuild/restage): harness
  `_harvest_figures` (Gcf via `sys.modules['matplotlib._pylab_helpers']` —
  never imports mpl; dpi-scaled to maxFigurePx, first maxFigures, PNGs to
  `/tmp/_avlo_figN.png`, `destroy_all()` UNCONDITIONAL + start-of-run sweep,
  skip-dump-on-interrupt, `plt.show()` UserWarning filtered at module level;
  caps are LOCAL literals — py-harness must stay import-free for the Node
  harness's type-strip, drift pinned by PY_LIMITS-driven board checks) →
  executor `FS.readFile().slice()` fresh buffers + unlink + TRANSFER lists on
  exec-done AND the sup→main relay → NEW `py-figures.ts`:
  `placeRunFigures` — ingest via the image pipeline, assetId dedup vs the
  block's live `figureIds` images (owner semantics: same plot = NO-OP,
  create-only, never update/move/delete), east placement 400wu wide
  (drag-drop parity) slid vertically by `slideClear`, ONE user-origin
  transact per figure (insertImage + elbow insertConnector code-E→image-W
  none→arrow + figureIds append — UNDO-TRACKED, owner decision; output text
  stays PY_RUN_ORIGIN), per-block stale-batch guard.
- **Reuse extractions** (behavior-identical): `slideClear` + scratches →
  `core/spatial/clear-placement.ts` (connector-flow imports it; core/py must
  not import tools/); `insertImage(r, frame, z)` out of createImageFromBlob
  (mirror of insertConnector); py-loader gained a lock-free `./verify`
  subpath export (executor's inline sha256 deleted — the stdlib as-mounted
  gate now shares THE verification predicate without carrying the lock JSON).
- **Review sweep (code-review high, 8 finder angles + verify pass; 10
  findings, 9 fixed)**: supervisor `beginInterrupt` — UserCancel now OUTRANKS
  an armed SoftTimeout (re-arms the kill on the 2 s cancel grace; closures
  read `run.cancelKind` live so forced-kill labels match exec-done; was: ??=
  kept the 5 s timer + stale closure kind → Stop during grace reported
  'timeout' up to 5 s late) · py-manager `invalidateBlock` guards
  `hasActiveRoom()` (ticker/result paths outlive the room; getBbox throws
  bare → wedged queue) · DOM run button seeds from the current run store
  (editor opened on a running block showed Play that actually cancels) ·
  executor drains the streaming TextDecoders at run end (mid-character final
  chunk lost its glyphs) · py-imports splits compound `import a; import b`
  statements on the STRIPPED line (gate gap; string-safe by construction) ·
  SW verified-route put now rides `event.waitUntil` (multi-MB write could die
  with the SW → offline boot silently lost artifacts) · cold-boot I/O
  parallelized (glue preflight ∥ bundle fetches; tar misses via Promise.all —
  sum→max) · dead isRunActive + stale /py-dev/fork/ comments dropped.
  REFUTED (documented): SIGINT-in-finally boundary race (only reachable
  under active cancellation), SW non-ok passthrough (fail-visible — module
  import/instantiateStreaming/preflight all reject non-ok), re-verify-on-
  every-hit costs (THE fail-closed invariant). Deferred note: SW cacheFirst
  tar put races the supervisor's identity-normalized put on the same key —
  self-healing (hits re-verified), watch on the preview board.
- **Output-panel WYSIWYG fixes**: DOM ok-path text now `palette[S.DEFAULT]`
  (#F8F8F2) like canvas — vestigial `chrome.outputText` (#AEAEAE) deleted ·
  canvas clips the output-line loop to the frame (long tracebacks painted
  past `totalWidth` outside the published bbox → dirty-rect ghosts; vertical
  was never broken — 12-line cap shared by height+paint) · DOM panel height
  now EXPLICIT `min(logicalLines,12)×outputLH` with `white-space: pre` (no
  wrap — canvas never wraps) + sep at -1 px flow height ⇒ equals
  `outputPanelHeight` exactly, >12 lines scroll in the fixed box ·
  `.is-runnable` retoggles live on language switch (handler always wired,
  runnability re-checked at click).
- **Verified**: typecheck 12/12 · harness base 42/42 + seaborn 23/23 (+5
  figure-harvest checks: triple+decode, plt.show filter, cross-run Gcf empty,
  cap=PY_LIMITS.maxFigures, dpi-scale ≤ maxFigurePx) + verify 8/8 · Chrome
  dev board pending this session (figures on canvas, dedup no-op rerun,
  undo, clip/height parity).

## Session 8 — Commit 2: client-side artifact verification + freeze hardening
- **The gap (owner-flagged)**: pyodide.mjs / pyodide.asm.js / pyodide.asm.wasm
  were NEVER byte-verified against the committed lock — they ride pyodide's
  internal indexURL fetches and could be served from an unverified SW cache
  write. (Tars were verified incl. cache-hit re-verify; stdlib post-mount.)
- **Design (owner picked, correctness-argued)**: the SW is the ONLY point
  that binds verified-bytes-to-execution for every artifact type INCLUDING
  the JS glue — a fork boot-from-bytes patch can't verify the JS that would
  receive the bytes, so it adds ~nil security and is DEFERRED to P3 (where
  executor boot inputs get reworked anyway).
  1. `sw.ts` `verifiedPyFirst`: the 4 core artifacts (lock `artifacts`
     table) are buffered + `matchesLockEntry`-checked before EVERY cache
     write AND on every hit; mismatch = 502 fail-closed, never cached.
     Synthetic Response carries Content-Type ONLY (a `.br` body's
     Content-Encoding/Length must not ride decoded bytes — closes the old
     sanitize-headers nit). Tars/manifest stay streaming cacheFirst (the
     supervisor is their verifier; buffering would collapse download
     progress). Wrong-hash URLs fall through untouched.
  2. Supervisor `ensureGlueVerified()`: fetch+verify the glue trio vs the
     lock once per page load (memoized on SUCCESS only), first line of
     spawnExecutor's try — covers dev/no-SW for drift/corruption, warms the
     verified cache under a SW; failures flow the existing
     downloadFailureMessage path (offline stays friendly, drift says
     "drifted from the committed build-lock — refusing to boot").
  3. `@avlo/py-loader` grew `sha256Hex`/`matchesLockEntry` in a NEW
     dependency-free `src/verify.ts` (index re-exports; separate file so the
     Node harness imports the exact shipped code without index's JSON lock
     import, which Node ESM rejects without import attributes). Supervisor's
     local sha helper deleted.
  Residual (documented): first-load-without-SW TOCTOU against an ACTIVELY
  malicious origin — unclosable without script-src blob: (worse trade); every
  realistic corruption (bad seed, stale mix, poisoned cache) fails closed.
- **Freeze hardening (owner-requested)**: `hardenRealm` now freezes the
  Function/String/Number/Boolean/RegExp/Error constructors (+ ArrayBuffer/
  SharedArrayBuffer/Uint8Array/TextDecoder/TextEncoder — same additive
  class; prototypes were already frozen). Refactor: one labeled
  `freezeTargets()` list (call-time built — SAB absent in non-isolated
  realms) shared by hardenRealm AND assertRealmHardened, whose freeze check
  went from a 4-object sample to a FULL sweep naming survivors (fixes the
  under-sampled gate). Prop-tamper protection only — call/new/subclass all
  still work; eval/Function posture unchanged.
- **Node harness COMMITTED**: `scripts/run-harness.mjs` (`pnpm harness`;
  Node ≥23.6 type-stripping imports the shipped py-harden/py-harness/
  verify.ts directly; never in Turbo/CI). The session-5/6/7 scratchpad board
  is now permanent, three child sections: **base 42/42** (numpy set — which
  now mounts sqlite3 FIRST — scrub sweep + planted-fetch negative, compile
  surface, FULL freeze sweep, frozen-ctor functional probes
  (expando-write throws / Error subclasses / RegExp exec / per-run
  TextDecoder), 0008 guard-stripped closure board, tombstones, protocol
  sabotage, sqlite3 CRUD+MEMFS-file post-freeze) · **seaborn 18/18** (all
  set: every tar lock-verified at mount, import+scatter→PNG pixel decode,
  vendored-KDE scipy-free, load_dataset http tombstone, seaborn.objects
  tombstone, pandas↔sqlite3 roundtrip, font gates — ALL post-freeze) ·
  **verify 8/8** (gate names unfrozen intrinsics pre-harden; staged tree ==
  lock for all 4 artifacts; flipped-byte + truncated-buffer negatives).
- `pnpm typecheck` 12/12 green with all of the above.
- **Browser/dev board (run post-commit, same session)**: canvas sqlite3 run
  (Python block → downloads only sqlite3.tar → `(6, 3)` output) + seaborn
  figure VERIFIED by the owner on the live dev instance; the orchestrator
  R2 wiring proven end-to-end (py worker on :8794 → bad hash 400 / glue 200
  with exact lock size + immutable/ETag/sandbox-CSP/CORP headers /
  sqlite3.tar byte-exact through the Vite proxy). Preflight POSITIVE is
  implicit in every successful canvas boot (spawn happens only after
  ensureGlueVerified); preflight NEGATIVE observed live: a real 404 on the
  glue surfaced as "Python runtime download failed: pyodide.mjs: HTTP 404"
  error-tinted with NO executor spawn and clean retry on next click.
  Debugging artifact worth keeping: TWO dev instances were up (main repo on
  base ports + avlo-parallel on dev:p's +10) — a THIRD dev:p from the main
  repo collides with the parallel one silently (workerd binds fail, curls
  hit the OTHER checkout's workers + state → phantom 404s). Check
  `ss -tlnp` pids before diagnosing "missing" R2 keys.
- **Still deferred to the next preview pass** (needs `vite preview` + SW,
  not the dev path): SW verified-route 502 negative + no-cache-write,
  offline second-load (the nested-worker-SW-control validation), zero
  `/py-dev/fork/` product-fetch sweep, guard-stripped `import js` re-probe
  in real Chrome (Node harness covers the closure 43-board meanwhile).

## Session 8 — Commit 1: sqlite3 + seaborn bundles (scope-guard relaxation)
- Owner decisions: packages = sqlite3 + seaborn; sqlite3 bundle RIDES EVERY
  SET (first position, prefix-consistent DSO order for P3 stacking) + a
  standalone `sqlite3` set; seaborn joins `all` only. openpyxl DEFERRED
  (needs the pyexpat revert in patch 0003 + un-pruning xml/parsers/ = docker
  rebuild reversing a deliberate prune, and no file-ingestion path exists);
  xlrd rejected (.xls-only); plotly rejected (HTML+plotly.js output model
  conflicts with the js-bridge closure + PNG figure pipeline).
- **sqlite3**: stock-lock unvendored wheel (1 top-level `_sqlite3.so` 1.43MB
  + 4-file pure-py pkg) — rode the existing pipeline untouched; loadOrder
  picked up the DSO, provides=['sqlite3'].
- **seaborn 0.13.2**: NOT in the stock lock → new per-wheel pin fields in
  build.config.json: `url` (PyPI wheel URL; --stamp SKIPS url pins and the
  drift guard ignores them; download goes straight to the url — the sha pin
  keeps provenance equivalent) + `depends` (hand-pinned direct deps feeding
  the new `wheel_depends()` in pack-package.py; lock wheels stay loud on a
  miss).
- **seaborn eager-import land mines** (both would have killed `import
  seaborn` on the pruned stdlib; found by static sweep, confirmed by gates):
  wheel patch 0001 lazifies `from urllib.request import urlopen/urlretrieve`
  (utils.py top-level; urllib.request pulls the pruned http stack) into the
  two dataset functions; 0002 swaps `import pydoc` → inspect.getdoc in
  _docstrings.py + external/docscrape.py (pydoc trips the _pyrepl tombstone
  at import — the known pydoc nit, now load-bearing).
- **seaborn prune** (tracer --propose confirmed every entry unreached):
  objects.py + _core/{plot,subplots,moves,properties,exceptions}.py +
  _marks/ + _stats/{aggregation,order,regression}.py + _testing.py —
  seaborn.objects is PIL-dead by construction (plot.py imports PIL at top;
  pillow never ships) and tombstones precisely (sb06). KEPT: _core/{data,
  typing,rules,groupby,scales}, _stats/{base,counting,density} (classic API
  reaches them), external/appdirs (EAGER via utils), external/kde (the
  vendored scipy-free gaussian_kde — kdeplot works, sb03 asserts scipy
  never enters sys.modules).
- Corpus: new `sqlite/` group (set sqlite3 — :memory: CRUD, MEMFS file-db
  reopen, types/rollback/Row; NB legacy isolation: commit before a rollback
  probe or the implicit tx swallows prior inserts) + `seaborn/` group (set
  all — scatter/heatmap/kde/theme PNG-gated + font gates; sb05/sb06 are
  `# trace: skip` tombstone probes) + all/a02_read_sql (pandas↔sqlite3
  DBAPI2 roundtrip, no sqlalchemy). GROUP_SET wired in run-corpus +
  trace-imports.
- Client: PySetKey += 'sqlite3' (py-protocol.ts — the CAST-SHADOWED union;
  comment now warns), marquee += seaborn/sqlite3 (py-imports.ts).
- **Gate board GREEN**: fetch (2 new wheels sha-ok) · unpruned 15 trees ·
  trace 6 groups · G3 (93 rules, ∩=∅, no PIL/fontTools) · bundles ×8 --repro
  byte-identical (sqlite3.tar 1.46MB/0.44br, seaborn.tar 1.00MB/0.31br) ·
  corpus 7 groups (sqlite 3/3, seaborn 6/6 w/ 4 PNGs pixel-decoded, all 2/2)
  · budgets --update diff = 2 new ceilings + benign ratchet-downs (session-7
  glue rebuild shrank core artifacts; ceilings never re-stamped) · composites
  numpy-path 7.44MB / pandas-mpl 14.38MB vs 12.58/16.78 ceilings · stage →
  buildHash `6d447a5ba051a748` (PACKAGE_TO_SET sqlite3→'sqlite3',
  seaborn→'all' auto-derived) · typecheck 12/12 · stage:check clean · seed
  25 keys (was 21).

## Session 7 — M3+P2 Commit 1: fork patches 0006 + 0008 landed
- **0006 (drop loader machinery)**: severed load-package's two import edges
  (api.ts/types.ts) + deleted the pyodide.ts lockfile plumbing — esbuild
  tree-shakes load-package/installer/packaging-utils out of both bundles; the
  pyodide.js/package.json/pyodide-lock.json boot crutch is GONE (stage.mjs
  ARTIFACTS → 4 entries + stray-prune of the gitignored fork dir).
- **0008 (js-bridge closure)**: the one-line `register_js_module("js",
  jsglobals)` deletion in finalizeBootstrap — `import js` is now
  finder-level ModuleNotFoundError INDEPENDENT of the harness guard.
  webloop deps kept (register_js_finder + pyodide_js registration).
- **Two rebuild regressions found + fixed** (both invisible to `tsc`, both
  would've shipped without the gate board):
  1. snapshot.ts `getExpectedKeys()` hardcodes the first hiwire-table slots
     in boot-allocation order; the "js" registration was what interned
     jsglobals (slot 1) + a trailing `{}` (slot 6). makeSnapshot died in
     checkEntry stringifying public_api (circular Module.FS root) vs the
     stale jsglobals expectation. 0008 now also rewrites the list to the
     empirical post-0008 table `[null, public_api, API, scheduleCallback,
     API]` (stable across warmups+gc; capture/restore share it; BUILD_ID
     gates reject pre-0008 snaps).
  2. dynload.ts was reachable ONLY via load-package→installer — 0006's
     severing tree-shook it out, killing API.loadDynlib + the whole DSO
     record/replay surface (0005) in the shipped glue. 0006 now re-anchors
     it with a bare side-effect import in api.ts (src/js has no sideEffects
     flag). New standing grep gate: `loadDynlib` present in the glue.
- **Gate board GREEN**: A3 greps (js-reg 0 / pyjs-reg 1 / finder 1 / lockfile
  0 / cdn 0 / drift 1 / loadDynlib 8) · pack:stdlib byte-identical (raw zip
  unchanged by the JS-only rebuild) · baseline --repro G0 byte-identical +
  restore-verify (21.0MB, builtin-modules refreshed, 63 builtins) · corpus
  all groups (basic 6/6, numpy 4/4, pandas 5/5, mpl 4/4, all 1/1) ·
  compress + G1 budgets (glue 0.13MB br) · stage + stage:check clean
  (11 files staged; pruned stray package.json/pyodide-lock.json/pyodide.js)
  · Node harness **43/43** (was 33): +webloop-alive, +guard-STRIPPED
  `import js`/importlib → ModuleNotFoundError (the load-bearing closure
  proof), +sys.modules sweep, +run_js dies at the lazy `from js import
  eval`, +documented residual (pyodide_js reachable guard-stripped,
  jsglobals.fetch scrubbed), +guard-restored re-refusals ·
  `pnpm typecheck` 11/11.
- **NOT yet done**: Chrome spike board + canvas smoke for Commit 1 (needs
  dev server) — folded into the Commit 2 verification pass (same session).
- Stdlib prunes of now-dead `from js import …` code (webbrowser/antigravity/
  pyodide.http/pyodide._run_js) remain a documented follow-up, not this slice.

## Session 7 — M3+P2 Commit 2: worker serving + P2 runtime swap
- **New worker `workers/py/`** (`avlo-py`, dev :8794, prod `py.avlo.io`
  commented like the fleet): anonymous immutable `GET /:hash/:file` +
  `/:hash/bundles/:name` (worker-shared `pyArtifactParam`/`pyBundleParam`,
  16-hex hash ≠ 64-hex assetKey), brotli via `.br` sibling keys +
  `encodeBody:'manual'`, `application/wasm` MIME, asset-body CSP + CORP
  cross-origin, NO caches.default (br↔identity variant poisoning), app-type
  exempt (binary artifacts; documented beside sync's exemption).
- **`packages/py-loader/`** (`@avlo/py-loader`): committed generated
  `build-lock.json` + deep-frozen typed `BUILD_LOCK`/`PY_BUILD_HASH` —
  stage.mjs now computes `buildHash` (16-hex sha256 of canonical sha tables;
  this stage: `bd8afa4e8f07f324`), writes + byte-gates the lock (`--check`),
  stamps the real hash into manifest.json (still the R2 completion marker).
  biome excludes the lock (formatter would break the byte-compare).
- **`publish.mjs`**: preflight re-hashes EVERY source byte vs the lock +
  `.br` mtime freshness → 21-key sequential upload, manifest LAST;
  `--local` → `--persist-to <root>/.wrangler/state` (wrangler appends v3 —
  verified: 21 blobs in the live tree); `--remote` probes the manifest
  (absent/identical/different → publish/no-op/hard error). Root `py:seed`.
- **P2 supervisor swap**: `ARTIFACT_BASE = PY_ORIGIN/<lock.buildHash>/`;
  manifest fetch/validate/memory-cache DELETED — lock import replaces it;
  `ensureBundles` → Cache API `avlo-py-<hash>` (hits RE-verified vs lock —
  the SW writes unverified; corrupt → delete → refetch), misses stream with
  progress + size-abort + sha gate, `cache.put` then TRANSFER the buffer
  (38 MB resident 'all' heap gone). Offline UX: TypeError/!onLine →
  "connect once to download (~X MB)" on both the bundle-fetch and
  exec-fatal boot paths. Executor/manager/imports/UI untouched.
- **SW**: `isPyRequest → cacheFirst(PY_CACHE)` (covers pyodide's internal
  indexURL fetches — glue/wasm/stdlib offline), activate evicts stale
  `avlo-py-*`. `_headers` CSP: script-src += 'wasm-unsafe-eval'
  https://py.avlo.io (NEVER exercised in dev — verify on first prod
  deploy), connect-src += py.avlo.io. Dev wiring: dev-ports `py:8794`,
  miniflare NAME map, Vite `/api/py` proxy + `@avlo/py-loader` alias.
- **Verified**: typecheck 12/12 · stage:check clean (lock byte-gated) ·
  seed dry-run = exact 21-key plan · real seed → 21 blobs ·
  `pnpm build` + SW isolation grep EMPTY (py-loader/lock SW-safe) ·
  G5 curls on :8794 (standalone worker vs the seeded tree): wasm+br → 200 +
  application/wasm + Content-Encoding:br + Vary + CORP + sandbox CSP +
  nosniff + immutable + ETag; **.br sibling proven byte-exact** (size ==
  .br file, ETag == its md5); `curl --compressed numpy.tar | sha256sum` ==
  lock sha (encodeBody:'manual' round-trip); manifest+br → identity object;
  bad hash 400 / unknown 404 / If-None-Match 304 / encoded-`/` traversal 400.
  Note: workerd normalizes inbound Accept-Encoding to "br, gzip" (prod edge
  does the same) — the identity branch exists for br-less direct clients and
  the manifest; the edge re-encodes per client.
- **PENDING (needs dev-server restart — it was running mid-session and
  predates the py worker)**: canvas demo via `/api/py/<hash>/…` (zero
  `/py-dev/fork/` product fetches), Cache Storage `avlo-py-<hash>` +
  no-refetch rerun, offline second-load via `vite preview`, offline-UX
  message, PORT_OFFSET=10 smoke, Commit-1 browser board (guard-stripped
  `import js` in real Chrome). Restart `pnpm dev` (picks up workers/py +
  the Vite proxy) and run the board.

## Session 6 — verify Session 5 + fail-closed hardening + full-stack audit DONE
- Owner decision: staying SAME-ORIGIN (no sandboxed iframe). That makes the
  `py-harden.ts` scrub THE authority boundary, not defense-in-depth — reinforced
  by the CSP: the app's `connect-src 'self' … wss://sync.avlo.io` is inherited
  by same-origin worker scripts, so even in prod the executor CSP permits
  `'self'`+backend egress; only the scrub actually stops it. So the enumeration
  model must (a) be exhaustive and (b) fail closed.
- **Fail-closed gate**: new `assertRealmHardened()` (py-harden.ts), called in
  py-executor `boot()` right after scrub+harden, inside the exec-fatal try. Re-
  reads the realm: every SCRUBBED_GLOBALS name undefined, WebAssembly compile
  surface gone, protocol intrinsics frozen — THROWS on any survivor ⇒ boot
  aborts (no harness, no runs) instead of running unconfined on a silent
  scrub no-op (e.g. a non-configurable accessor on some engine).
- **Scrub gap closed**: added `RTCPeerConnection`/`RTCDataChannel` (WebRTC — raw
  egress NOT governed by connect-src, per the M3 exploration's platform verdict
  #7) + `SharedWorker` (realm-mint escape alongside Worker). Window-only today
  ⇒ absent-and-skipped in a worker; free future-proofing.
- **Full-stack security audit (no rebuild needed — C surface confirmed solid):**
  `_ctypes` double-dead (not compiled + `ctypes` tombstoned) ⇒ no in-wasm FFI;
  `_ssl`/http gone; `_socket` compiled but `-lwebsocket.js` dropped ⇒ transport-
  less; `pyexpat`/`_elementtree` dropped (C XML parser gone; ElementTree pure-py
  stays); 2 GB mem cap. matplotlib pillow-ectomy fully severs untrusted-image
  decode (`imread`→hard raise). Python overlay/wheel patches add no capability.
- **Documented residuals (deferred, NOT fixed this session):** (1) `js` proxy
  reachable-if-guard-stripped until fork patch 0006 (the definitive FFI closure,
  M3, needs docker rebuild) — but authority-free post-scrub (postMessage-spoof
  reaches only the user's own block). (2) `subprocess`/`multiprocessing` blocked
  by wasm-syscall-absence, not policy — explicit prune is build-side + risks
  benign transitive imports. (3) `sitecustomize` registry `__import__` of an
  attacker-planted `_avlo_pruned_*.py` across runs in a generation — contained
  (no authority), real fix is P3's per-run MEMFS/blit reset. (4) build-side
  niceties: `DISABLE_DYLINK` dead 4GB/host-FS Makefile block (CI-assert unset),
  `ssl`/`sqlite3` bare (non-tombstoned) errors.
- **Verified GREEN.** Node harness (scratchpad, exact shipped code vs real fork +
  numpy mount): 33/33 — reproduces Session-5's 22 + the gate passes clean/THROWS
  on a restored global + WebRTC scrubbed + ctypes tombstoned + subprocess/os.fork
  inert. **Browser smoke (the Session-5 untested gap — NOW DONE, Chrome via the
  real supervisor→executor chain + a canvas run):** guard-stripped `js` proxy ⇒
  all 16 authority names unreachable (incl. `navigator` deleted — the thing Node
  can't validate); `print(1+1)`→2 on canvas; numpy 4.0/24; matplotlib Agg→valid
  PNG; cancel mid-`while True`→"Run cancelled."; import-gate refuses `requests`.
  Fail-closed assert did NOT false-trip a real boot. `pnpm typecheck` (10/10),
  biome (clean), `stage --check` (clean — no generated files touched).

## Session 5 — same-origin realm hardening (pre-M3) DONE
- Threat-model finalized for the no-iframe reality: the executor is a
  SAME-ORIGIN worker with the origin's full ambient authority at birth.
  New `web/src/core/py/py-harden.ts` (dependency-free, Node-verifiable):
  - `scrubWorkerScope()` supersedes scrubNetworkScope — network (fetch/XHR/
    WS/WebSocketStream/ES/WebTransport) + fresh-realm escapes (Worker,
    importScripts) + origin storage (indexedDB=room docs, caches=SW cache,
    cookieStore, navigator=OPFS/locks/GPU) + BroadcastChannel; own props AND
    prototype chain; strict-mode-safe (configurable→delete, else
    writable→undefined — bare `delete` THROWS on non-configurable props).
  - `hardenRealm()` — deletes WebAssembly compile surface (compile/
    instantiate/*Streaming/Module; all DSO loads are boot-time, new set ⇒ new
    worker) and freezes protocol-bearing intrinsics (Object/Array/Function/
    String/typed-array/Promise prototypes, JSON, Atomics, Math, Reflect,
    Date, WebAssembly). eval/Function stay: unblockable in-language, no I/O
    authority left to exfiltrate with — posture is authority removal.
- Executor: one-boot-per-generation guard; postMessage captured at module
  load (result delivery survives global tampering); whole boot body in the
  exec-fatal try; verifyStdlibZip — hashes python_stdlib.zip AS MOUNTED in
  MEMFS vs the boot-msg manifest sha (spike's standing guard productionized;
  restage ⇒ recapture; the anchor P3 snapshots key on).
- Supervisor: manifest now REQUIRED for every spawn (stdlib sha rides boot),
  shape-validated (hex64 + positive int sizes) + deep-frozen; tar meta
  prefix/loadOrder path-validated (absolute-into-root / relative, no
  ..//empty segs) + frozen; bundle streaming aborts past manifest size
  (bounds memory before the sha check would catch it); frozen cache entries;
  non-crossOriginIsolated contexts refused with a precise run result.
- Frozen constants: PY_LIMITS, PyExecState, PyCancelKind, SET_KEYS_BY_SIZE;
  stage.mjs codegen now emits Object.freeze for PACKAGE_TO_SET/SET_BUNDLES
  (gen file hand-mirrored; `stage --check` byte-parity CLEAN). NB Sets are
  NOT frozen — Object.freeze can't reach Set internals; ReadonlySet is the
  contract there.
- Verified: Node harness (scratchpad) boots the staged fork, mounts the real
  numpy.tar, runs the SHIPPED py-harden + py-harness — 22/22: stdlib readback
  hash == manifest, scrub holds, compile surface gone/runtime wasm types
  kept, intrinsics frozen, print/echo/traceback-with-source/js-refusal/
  __import__-refusal/numpy/numpy.random/SystemExit all green, protocol
  survives json.dumps sabotage, guard-strip probe still sees js.fetch
  undefined. `pnpm typecheck` + biome + `stage --check` clean.
- NOT yet browser-smoked (no dev server this session): canvas run + cancel
  path under the new boot order — worth one Chrome pass next session.

## Session 4 — Commit 1 (P1 hardening) DONE
- A1 isolation: `scrubNetworkScope()` in py-executor (deletes fetch/XHR/WS/ES
  own+prototype-chain after boot — AUTHORITATIVE layer); harness meta_path
  guard blocks {js,pyodide_js,pyodide,_pyodide} + pops js/pyodide_js from
  sys.modules (defense-in-depth); pyDevStatic resolve-then-contain (encoded
  `..` 404s — verified with curl); `_dumps = json.dumps` captured.
- A2: per-run TextDecoder recreation; MEM_BYTES→MEM_KIB (>>>10); startedAt
  re-stamped at phase 'running'; supervisor teardownExecutor() on dormant
  onerror + no-respawn on boot-failure exec-fatal; manager resetRuntime() on
  sup-fatal (was: wedged supervisor got redispatched); +stat/multiprocessing/
  pydoc/netrc/modulefinder/rlcompleter in STDLIB allowlist.
- Canvas smoke (Chrome, fresh room): print→2; `__import__('js')`→
  ModuleNotFoundError tinted; guard-bypass probe (strip meta_path guard,
  importlib js) → fetch/XHR/WS/ES all MISSING (scrub holds); 5/6 new stdlib
  mods import (pydoc gate-passes but hits the _pyrepl tombstone at runtime —
  pydoc.py:80 top-level import; precise error, acceptable; revisit at Step 1
  if cheap); requests → instant refusal; Ctrl+Enter toggle cancels
  mid-`while True` → "Run cancelled."; 30s soft timeout observed live.
- Known nit re-confirmed (already in backlog): language-switch WHILE EDITING
  doesn't retoggle `.is-runnable` — DOM button dead until editor reopen;
  Ctrl+Enter unaffected.

## Done
- P0-A PASSED on stock AND fork (Chrome): fork fresh boot ~2.2-2.4s (stock 5.2s),
  baseline snapshot 21.0MB, restore-boot ~420-550ms, kill+respawn ~416ms,
  interrupt 26ms. Harness: web/src/dev/py-spike-{main,supervisor,executor,snap}.ts.
- **P0-B PASSED — SNAPSHOT DESIGN FROZEN** (fork, Chrome):
  G6 baseline meta v1 ✓ · G6.5 dsoBaseHook liveness ✓ · G7 numpy record (13 .so
  loadDynlib'd lexicographic, import numpy, ones(4).sum()==4, loadOrder==13,
  site-packages tree 380 files/10.2MB read back WITH mtimes AFTER import) ✓ ·
  stacked capture 36.3MB/16ms, meta {stacked, loadOrder 13, dsoHandles 13} ✓ ·
  G8 replay in fresh worker via _preRestoreHook(avlo, Module) — restore-boot
  ~530-555ms, numpy works, lazy `numpy.testing` import works, x=41 roundtrips ✓ ·
  G8R RNG (state identical across restores; explicit os.urandom reseed differs) ✓ ·
  BLIT reset 3.4-3.9ms for 36.3MB image (globals gone, fractions unimported,
  numpy still works) ✓ · G9 rotated loadOrder → "snapshot DSO table drift" ✓.
  G6ctypes = EXPECTED-FAIL until the Step-3 cpython rebuild lands.
- Step 1 fixes that made P0-B possible:
  - **patch 0007 revised**: `_preRestoreHook(avlo, Module)` — hook fires inside
    restoreSnapshot BEFORE loadPyodide resolves, so the caller has no Module/API
    otherwise. Module.API + Module.FS are the replay handles.
  - **emsdk 0005 was NOT in the built glue** (top-level Makefile rule
    `emsdk/emsdk/.complete:` has no prereqs → staged patches inert on
    incremental builds). Hand-applied to
    .work/pyodide/emsdk/emsdk/upstream/emscripten; build.sh now direct-applies
    missing emsdk patches (dry-run + patch -N) and HARD-ASSERTS dsoBaseHook in
    libdylink.js. Standing prestage gate:
    `grep -c "snapshot DSO table drift" fork/pyodide.asm.js` ≥ 1.
- build.config.json pins unchanged (pyodide 0.29.4, image digest, recipes
  0.29-20260507). Fork staged at web/public/py-dev/fork/ (+release package.json
  + pyodide-lock.json until patch 0006).

## Hard-won learnings (do not re-derive)
- **Zombie-executor interrupt steal**: Worker.terminate() on an executor
  blocked in a wasm busy loop closes its ports immediately but the THREAD keeps
  spinning until its next yield; its Python signal check keeps consuming SIGINT
  from a shared interrupt SAB — the next executor's first interrupt vanishes
  (repro: fork suite G5 hang; byte 2→0 with no KI; second write delivered).
  FIXES (both now in spike supervisor, REQUIRED in production py-supervisor):
  (1) fresh interrupt SAB per executor spawn — never reuse across generations;
  (2) repeat SIGINT writes every 50ms until exec-result (soft-cancel loop).
- **numpy 2.x defers numpy.random**: `import numpy` does NOT seed the global
  RandomState. Bake it explicitly during per-set snapshot generation
  (`import numpy.random`) or every restore re-seeds fresh at first touch —
  breaks run determinism. Baseline warmup list + per-set import lists must pin
  the full module set they claim (G8R caught this).
- Site-packages tree MUST be read back AFTER `import numpy` (import-generated
  __pycache__ pycs are heap-referenced) and restored with mtimes
  (FS.utime(path, m, m)) — MEMFS has one ms timestamp per node.
- Snapshot container: u32[0] magic / u32[1] payloadOffset / u32[2] jsonLen /
  bytes 16..48 BUILD_ID / JSON at 48 / heap at payloadOffset (py-spike-snap.ts
  is the shared parser).
- Capture requires primitive-only Python↔JS traffic (live PyProxy aborts
  serializeHiwireState at snapshot.ts:218). runJson pattern in the executor.
- stdlib.zip byte-identity is NOT guarded by BUILD_ID — spike hashes it at
  every fork boot and refuses capture/restore drift. Restage ⇒ recapture.
- Vite: public-dir files cannot be ESM-imported → pyDevStatic middleware serves
  /py-dev/* raw (also sets COOP/COEP). git apply must run from .work/pyodide.
  WSL2 ~9GB RAM → build jobs pinned to 2 cores.

## M1 COMPLETE (Step 3 done; patch 0006 deferred)
- Full CPython rebuild landed patch 0003: _ctypes/_bz2/pyexpat/_elementtree/
  _lsprof/_multibytecodec all raise; zlib/_socket/select/_decimal/_zoneinfo/
  hashlib kept. wasm 8,540,853 → **7,471,023**. G6ctypes → PASS.
  (emsdk NOT re-setup — hand-applied patch persists, build.sh guard covers it;
  from-scratch official-mechanism repro deferred to the G0 CI gate in M4.)
- pack-stdlib.py: pruned pyc-only zip (77 entries pruned, 16 tombstoned
  top-levels), DEFLATED(9) — 2.42MB src → **3.09MB** (STORED was 7.2MB; the
  zip is MEMFS-resident so RAM wins; NB: writestr with explicit ZipInfo
  ignores the archive default — pass compress_type per entry). Deterministic
  (sorted + fixed dates). Corpus basic/ 5/5 PASS (tombstones, traceback shape,
  overlay import, post_restore callable).
- make-baseline.mjs: dist/baseline.snap 21.0MB, **G0 OK (byte-identical
  --repro)** + restore-verify. Determinism kit (runtime-side replacement for
  dropped fork patch 0008) intercepts THREE sources found by byte-diffing:
  (1) node:crypto randomFillSync/randomBytes — Emscripten PREFERS these over
  webcrypto in Node, a webcrypto-only patch sees 0 draws; (2) Date.now —
  MEMFS stamps every node, the stdlib zip mtime lands in zipimport's heap
  cache; (3) performance.now — clock_gettime anchors. PYTHONHASHSEED=0 rides
  loadPyodide env (hash_randomization asserted 0).
- **patch 0006 DEFERRED to M3/M4** (delta vs master plan): a 111-byte stub
  pyodide-lock.json ({info, packages:{}}) boots fine → the 122KB lockfile boot
  dependency is gone without touching the loader. Full machinery deletion is
  now pure hardening; do it alongside M3 serving (it changes runtime.js only).
  Node quirk: lockFileURL must be a PATH in Node, not a file:// URL.
- Fork restaged (glue+wasm+PRUNED stdlib+stub lock): fresh boot **860ms** (was
  2.3s), stacked numpy snapshot 30.2MB (was 36.3), restore-boot ~450-512ms,
  interrupt 9ms, blit 3.1ms. FULL GREEN BOARD: P0-A(stock) 5/5, P0-A(fork)
  5/5, P0-B 9/9.

## P1 COMPLETE (task #4) — Python runs on the canvas
- `web/src/core/py/` landed: protocol/sab/harness/imports/run-store/loader/
  executor/supervisor/manager + CLAUDE.md. Y wiring: `mutateWithOrigin` +
  `PY_RUN_ORIGIN` + `transactPyOutput`; `outputStatus` field everywhere
  (objects.ts CodeOutputStatus, accessors, render-accessors scratch). UI: live
  play/stop button (canvas hit + SelectTool `playButton` DownHit + CodeTool
  end + DOM `.is-runnable` + Mod-Enter), "Running… N s" header status +
  ticker, outputError tint (canvas AND DOM overlay).
- VERIFIED in Chrome (fresh room): print→"2" on canvas; Jupyter echo (`x`
  last-expr → 42); traceback with USER SOURCE + caret (linecache seeding);
  cancel → SIGINT → "Run cancelled." status=cancelled; 30s soft timeout →
  status=timeout (canonical message appended in supervisor — graceful
  interrupts print nothing themselves); undo untouched (PY_RUN_ORIGIN not
  tracked — Cmd+Z with only run-writes since load = no-op). Typecheck clean.
- Cold boot ~0.9s per executor spawn (fork + pruned stdlib + stub lockfile);
  2min idle teardown + eager respawn already in.
- NOT yet live-verified: peer-sees-final-only (by construction — zero Y writes
  until result), FF/Safari sweep, hard-kill grace path in product (spike-
  proven). Polish backlog: live stdout streaming into the DOM editing overlay
  (run-store already accumulates it), stop-square SVG centroid offset in DOM,
  language-switch while editing doesn't retoggle `.is-runnable`.

## Session 4 — Commit 2: M2 COMPLETE (bundles + dev mount)
- **Full gate board green**: pack-stdlib double-run byte-identical · corpus
  basic 6/6 numpy 4/4 pandas 5/5 mpl 4/4 all 1/1 (real tars, PNG decode,
  font gates) · every tar `--repro` byte-identical (incl. mpl subset+prebake)
  · G3 tracer 4 traces/81 rules ∩=∅ no PIL/fontTools · G1 budgets
  (numpy-path 7.01MB br / pandas-mpl 13.64MB br vs 12/16MiB ceilings) ·
  spike P0-A(fork) 5/5 + P0-B 9/9 through numpy.tar · stage --check clean ·
  typecheck clean. **Canvas demo**: numpy.ones(4).sum()→4.0, pandas
  groupby+describe (Jupyter echo), `import requests` instant refusal listing
  the real set, stat/multiprocessing un-refused.
- Pipeline: fetch-wheels (13 pins from stock lock; release-asset 404s →
  jsdelivr CDN mirror, sha-equivalence) → packlib.py (hashseed re-exec,
  dotted tombstones D6, deterministic zip/ustar) → pack-package.py (D2-D6;
  ustar meta-first; --unpruned/--stage-only/--tar-only) → tracer →
  compress/budgets → stage.mjs (dev manifest + py-stdlib-modules.gen.ts,
  --check drift gate).
- **Wheel patches born of gates** (all generated as exact-context diffs):
  pandas 0001 (top-level `import ctypes` in pandas.errors — EAGER, would
  have broken `import pandas` entirely on the ctypes-less fork; tracer found
  it) + 0002 (lazy ctypes in interchange.from_dataframe); dateutil 0001
  (silence the missing-tzdata UserWarning — tarball pruned, pytz is THE tz
  db via the reworked path-probed ensure_tzpath, now called by the executor
  after every mount); matplotlib 0001 (rc backend: Agg) + 0002
  (pillow-ectomy: imsave/print_png → _avlo_png, imread/others → clear
  ValueError, colors._repr_png_, lazy PillowWriter).
- **Font learnings**: the recipes mpl wheel SHIPS matplotlib/fontlist.json
  (39 faces, RELATIVE fnames — pyodide-patched font_manager loads
  package-local, so planned patch 0003 was unnecessary); prebake deletes it
  and rebuilds over the shipped faces. 5-face subset alone sprays ~20
  findfont warnings into user output (mathtext dejavusans fontset probes
  STIX/cm/Display fallbacks) → ship those 25 faces UNSUBSET (+1.56MB raw,
  ~0.7MB br; subsetting them is glyph-index-fragile, STIXNonUni rides PUA).
  Corpus font gates: matplotlib-logger tap asserts no findfont + no
  "generated new fontManager" (proves baked-list consumption).
- pandas 2.3 reality: io wrappers (excel/html/xml/sql/sas front doors) are
  EAGERLY imported by pandas.io.api — only lazy internals prunable
  (style/styler, clipboard, sas readers, _numba kernels). numpy: recipes
  wheel ships no tests; pruned f2py+_pyinstaller only.
- Runtime wiring: supervisor fetches per dev manifest w/ sha verify
  (stale-mix refusal), in-memory bundle cache across generations (copies
  transferred, originals kept), downloading phase w/ streamed progress,
  set-aware respawn (supersets satisfy); executor mounts (extract →
  loadDynlib per loadOrder → ensure_tzpath) BEFORE network scrub + harness.
  py-imports/manager consume the GENERATED allowlist (hand-set deleted).

## Next: M3+P2 (worker serving + full patch 0006) → P3 snapshots → P4+M4
- P3 groundwork already proven in the spike: stacked capture 30.2MB / restore
  ~0.5s / blit 3.1ms; py-loader has the `_loadSnapshot` seam; supervisor has
  idle teardown + respawn; bundle mounts feed the per-set snapshot recipe.
- M3 note: supervisor's in-memory bundle cache (~38MB raw for 'all') is the
  dev stopgap — P2 swaps fetches to Cache API + build-lock origin.
- Deferred nits: pydoc allowlisted but trips the _pyrepl tombstone at
  runtime (pydoc.py:80 top-level import; precise error, fine);
  `.is-runnable` retoggle on language switch (still in polish backlog).
