# py-build working notes (in-flight state)

Master plan: /home/issak/.claude/plans/prompt-md-i-copied-my-synthetic-octopus.md
Pickup plan (session 3): /home/issak/.claude/plans/original-prompt-was-here-graceful-cocke.md
Task list: session tasks #1-#8 (Step1..P4+M4); #1 Step1 DONE, #2 P0-B DONE, #3 M1-finish in progress.

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

## Next: M2 bundles (task #5) → M3+P2 (#6, + full patch 0006) → P3 snapshots (#7) → P4+M4 (#8)
- P3 groundwork already proven in the spike: stacked capture 30.2MB / restore
  ~0.5s / blit 3.1ms; py-loader has the `_loadSnapshot` seam; supervisor has
  idle teardown + respawn. M2 starts at pack-package.py + the import tracer.
