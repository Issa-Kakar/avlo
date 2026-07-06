# py-build working notes (in-flight state)

Master plan: /home/issak/.claude/plans/prompt-md-i-copied-my-synthetic-octopus.md
Pickup plan (session 3): /home/issak/.claude/plans/original-prompt-was-here-graceful-cocke.md
Slice plan (session 4): /home/issak/.claude/plans/packages-py-build-notes-md-view-the-two-zazzy-pascal.md
Session-4 tasks: #1-3 Commit 1 (P1 hardening), #4-13 Commit 2 (M2 Steps 0-9).

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
