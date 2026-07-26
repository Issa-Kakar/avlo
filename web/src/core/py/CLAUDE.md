# Python Runtime (`core/py/`)

> **COLD-RESTORE ATTACK LANDED (Session 16 — L1 walker + L2 topology flip;
> NOTES.md in py-build is authoritative):** fork is Pyodide **314.0.2** /
> CPython 3.14 / emsdk 5.0.3 / MAIN_MODULE=2, DSOs grouped 67→4, buildHash
> `f440369a4275be9a`. On top of P2's owned dense snapshots
> (`SNAPSHOTS_ENABLED = true`; capture at the pre-harden slot → AVS2 →
> OPFS): **(1)** bundles mount via the direct-node walker
> (`py-mount.ts mountBundleTree` — tar subarray adoption into MEMFS, no
> in-wasm tarfile; ~11 ms for `all`, parity-gated in the harness); **(2)**
> the SUPERVISOR spawns the executor FIRST and streams boot inputs
> (`boot-prep`/`boot-data`/`snap-header`/`snap-heap`) — it owns ALL OPFS
> snapshot I/O now (open/parse/read+hash pre-transfer; the executor never
> touches OPFS) and transfers the VERIFIED heap buffer; **(3)** `trySnapshot`
> boots are UNIFORM noInitialRun — py-loader's async preBlit driver decides
> restore-vs-cold in flight (header:null ⇒ deferred `Module.callMain()` on
> the same Module; pre-mutation failures ⇒ same-Module cold via
> exec-snap-invalid; from the first replay on ⇒ `DirtyRestoreError` + ONE
> fresh re-instantiate in the same worker) and the executor precompiles
> group DSOs (`WebAssembly.compile`) overlapped with the main instantiate;
> **(4)** cold boots free+zero DSO `file_data` post-mount (capture 78.5 →
> 65.4 MB). Poison ladder unchanged: post-blit pre-ready (`restored:true`)
> → poison + ONE cold respawn; restored gen's first-run hard failure →
> poison (now snapOps-chained) before the eager respawn.
> `idleTeardownMs` = 15 s (owner-binding pending the preview-board
> re-record). Prose below predating this (executor snap-probe, `PreBlitError`,
> `readHeapInto`, `openSetSnapshot`, single boot msg, `mount-extract`,
> `_loadSnapshot`/baseline/`PackedTree`/AVS1) is DEAD — trust NOTES.md + the
> code over any wording below; full rewrite lands P5.

In-browser Python execution for code blocks — forked Pyodide 0.29.4 (built by
`packages/py-build/`; artifacts + bundle tars served from the **py worker
origin** `PY_ORIGIN/<buildHash>/…` — `py.avlo.io` prod, `/api/py` Vite proxy
dev — seeded into R2 by py-build's `publish.mjs`, verified against the
committed `@avlo/py-loader` build-lock) running in a supervisor→executor
nested-worker pair. P3 state: **snapshot-restored boots** — stdlib boots
restore the prebuilt lock-verified `baseline.snap`; package-set boots restore
the set's OPFS-persisted stacked snapshot (client-generated on first use,
zero bundle fetches on hit) or generate one riding the boot; every run ends
with an in-place **blit reset** (heap rewound to the boot ready-point →
stateless, reproducible runs) — cold boot remains the universal fallback
(snapshots accelerate, never gate). On-demand package-bundle mounts
(numpy / pandas / matplotlib sets) feed cold + generation boots; Cache API
persistence (`avlo-py-<buildHash>`, shared with the SW's cache-first route)
covers tars + baseline — offline second-load runs with zero network.
The `pyDevStatic` `/py-dev/` middleware remains for the spike pages only.
Master plan:
`/home/issak/.claude/plans/prompt-md-i-copied-my-synthetic-octopus.md`;
build-side state: `packages/py-build/NOTES.md`.

## Files

| File | Role |
|------|------|
| `py-protocol.ts` | Message types for all three threads + `PY_LIMITS` caps + `PyBundlePayload` (bundle bytes ride boot postMessage). Single source of truth; workers import type-light (no yjs) |
| `py-sab.ts` | 64 B PY_SAB layout (interrupt u8[0] / state / runId / heartbeat / epoch / futex-reserved / cancelKind / memKiB) + alloc/map + interrupt write/clear |
| `py-mount.ts` | Session 16 (L1): the SINGLE home for ustar walking (`walkTar`/`octal`/`asciiName`), PEP-706 `dataFilterMode`, strict `parseTarMeta` (moved from the supervisor), `collectSoBytes`, and `mountBundleTree` — direct-node MEMFS grafting with adopted tar-subarray contents (no in-wasm tarfile; ~11 ms for `all`, byte-identical — harness `--section parity` is the standing gate). Dependency-FREE (callers wrap spans); imported by executor, supervisor, py-build harness AND corpus |
| `py-trace.ts` | Redesign-P0 boot/run tracing, always-on: per-thread span buffer → `performance.measure` + ONE `py:trace` JSON line per boot/run, relayed exec→sup→main (`ExecTraceMsg`/`TraceMsg`) — py-manager owns the visible `console.info` + the `pyTraceLines` ring (`window.__avloPyTraces` in DEV; the e2e read surface). `installWasmTimers()` = boot-window WebAssembly shims splitting side-module compile/instantiate out of DSO replay; MUST uninstall before scrub/harden. Span names are the cross-phase ledger keys (`packages/py-build/NOTES.md` Session 11) — keep stable |
| `py-snapshot.ts` | AVS2 codec + OPFS store (P2 owned snapshots): streaming `Xxh32` (u32-lane fast path), crc32, `planAvsHeapOff`/`encodeAvsHeaderBlock`/`parseAvsHeader` (magic/crc/v/buildHash/setKey/offset-arithmetic hard cross-checks — ANY failure throws), `readHeapInto` (8 MB chunked positioned reads STRAIGHT into re-acquired HEAPU8 views, folding the hash — zero full-size intermediates), `SnapReadHandle` contract (idempotent close). OPFS: executor-side `openSetSnapshot` (read-only sync → exclusive → async buffer → null; never creates, strictly pre-scrub, handle closes in a finally before harden), supervisor-side `writeSetSnapshot` (exclusive handle = multi-tab arbiter; heap chunks FIRST folding the hash, header LAST — torn write ⇒ structurally invalid) + `deleteSetSnapshot` + stale-buildHash dir GC. Dependency-light (py-trace only) — the py-build harness and the web vitest suite import the exact shipped codec |
| `py-manager.ts` | Main-thread API: `toggleRunCodeBlock` / `cancelRun` / `isRunnableCodeBlock`. FIFO queue (cap 4), single-flight dispatch, pre-run import gate, ONE Y commit per run, 500 ms status ticker |
| `py-run-store.ts` | Ephemeral per-block phase + live output (Zustand, non-persisted, presence-store pattern). Never written to Y |
| `py-figures.ts` | Result-time figure placement: `placeRunFigures(blockId, runId, figures)` — ingest PNGs through the image pipeline, assetId-dedup against the block's still-alive `figureIds` images (same plot = no-op; CREATE-ONLY, never update/move/delete), east placement at drag-drop sizing (400wu wide) via `slideClear` (nearest clear vertical slot; base spot fallback — a figure is always placed), then ONE user-origin `transact` per figure: `insertImage` + elbow `insertConnector` (code E-mid → image W-mid, none→arrow, device-ui connector style) + `figureIds` append — UNDO-TRACKED by owner decision, unlike the output commit. `enqueue` per new asset; per-block stale-batch guard (slow ingest from run N drops after run N+1's result) |
| `py-imports.ts` | Pure: `scanPythonImports` (triple-quote-aware line scan) + `resolveImports` (GENERATED allowlist + package→set merge by bundle union) + refusal message listing the real available set |
| `py-stdlib-modules.gen.ts` | GENERATED by py-build `stage.mjs` (checked in; `stage.mjs --check` = drift gate): `STDLIB_MODULES` (pruned-zip tops + true builtins + tombstoned tops), `PACKAGE_TO_SET`, `AVAILABLE_PACKAGES`, `SET_BUNDLES` |
| `py-harness.ts` | Python harness source: fresh `__main__` per run (belt-and-braces — the blit reset rewinds the whole interpreter after every run), linecache-seeded `'<block>'`, ast last-expression echo, harness-frame-trimmed tracebacks, defense-in-depth import guard, matplotlib figure harvest (`_pylab_helpers` via sys.modules — never imports mpl; dpi-scaled to `maxFigurePx`, first `maxFigures`, PNGs to MEMFS `/tmp/_avlo_figN.png`; `Gcf.destroy_all()` UNCONDITIONAL incl. interrupted runs + a start-of-run sweep — leaked figures must not haunt the next run; skips the dump when interrupted). Primitive-only returns (JSON string; figures ride as `[path, w, h]` triples) |
| `py-harden.ts` | Realm hardening, the AUTHORITATIVE isolation layer: `scrubWorkerScope()` (delete network incl. WebRTC + fresh-realm escapes incl. SharedWorker + origin storage + BroadcastChannel, own props AND prototype chain, strict-mode-safe) + `hardenRealm()` (delete the WebAssembly compile surface, freeze the shared `freezeTargets()` list — protocol-bearing intrinsics, prototypes AND constructors incl. Function/String/Number/Boolean/RegExp/Error + buffer/text-codec ctors; freezing a ctor blocks prop tampering while call/new/subclass keep working — eval/Function posture unchanged) + `assertRealmHardened()` (FAIL-CLOSED gate — throws if any scrubbed authority survived / the compile surface remains / ANY freeze target is unfrozen, named — a FULL sweep over the same list the writer froze, not a sample). Dependency-free — the committed py-build Node harness (`pnpm harness`) exercises the exact shipped code against a real fork boot |
| `py-supervisor.ts` | Worker. Executor lifecycle, wall clocks (30 s soft + 5 s hard grace; 2 s cancel grace), idle teardown (15 s — THE memory-reclaim knob; respawn restores from OPFS), eager respawn, result synthesis. P3 spawn branches: stdlib → `ensureBaseline` (Cache API + lock re-verify, tar posture; null = cold) → boot `{snapshot}`; package set → OPFS `readSetSnapshot` hit → boot `{snapshot, tree}` with ZERO bundle fetches / miss → baseline + `ensureBundles` + `{capture, captureKey}` (generation; works baseline-less too). `exec-snapshot` accepted only while `!executorReady` (forged-capture guard) → `writeSetSnapshot` overlaps the first run; `exec-done.needsRespawn` → eager respawn instead of idle-arm; pre-ready `exec-fatal` on a snapshot-fed boot = poison path (delete the OPFS wrapper / baseline cache entry, ONE cold retry with the run kept pending — snapshot failures are invisible to the user). M3/P2: artifact URLs are `PY_ORIGIN/<BUILD_LOCK.buildHash>/…`; the COMMITTED `@avlo/py-loader` lock (typed, deep-frozen) replaces every manifest fetch — boot msg carries the lock's stdlib sha, EVERY tar sha256-verified against it (stale-mix refusal; streaming bounded by lock size; tar-meta prefix/loadOrder path-validated). Verified tars persist in the Cache API (`avlo-py-<buildHash>`; hits RE-verified — corrupt hit → delete → refetch), boot buffers TRANSFERRED outright (no resident copy), posts `downloading` progress over misses, respawns when a run needs bundles the current generation lacks (supersets satisfy subsets). `ensureGlueVerified()` preflights the glue trio against the lock before the first spawn (memoized on success only; drift = fail-closed refusal). Refuses runs in non-crossOriginIsolated contexts with a precise result; offline-uncached spawn/boot failures surface a friendly "connect once (~X MB)" result |
| `py-executor.ts` | Nested worker. Pyodide instance, bundle mounts (tar → MEMFS extract → `loadDynlib` per meta loadOrder, deps-first across bundles), stdlib-zip integrity verify (hash AS MOUNTED vs boot-msg sha — ALWAYS before any capture) → `_avlo_runtime.post_restore()` (reseed + cache drop + tz bridge; superset of the old ensure_tzpath, idempotent on cold boots) → [generation] `BUNDLE_IMPORTS` bake (numpy MUST bake `numpy.random` — G8R) + gc×2 + `makeMemorySnapshot()` + `packTree` + `exec-snapshot` post (best-effort try/catch, boot continues snapshotless) → realm scrub + harden + fail-closed assert BEFORE harness install → hooks + harness → **`resetImage = HEAP8.slice()`** at the ready-point of EVERY boot (blit target already holds harness + armed interrupt + reseeded entropy). Post-run **blit reset**: guard `wasmTable.length` unchanged → `HEAP8.set(resetImage)` + zero tail + re-arm interrupt + `POST_RUN_RESET` (post_restore + `/tmp` sweep — MEMFS is JS-side and survives the blit); `needsRespawn = !blitOk \|\| heap > 1.5× image` rides exec-done. One-boot-per-generation guard, captured `postMessage`, raw-write stdout/stderr hooks (flush ≥100 ms/≥8 KB inside the write callback — no timers run mid-Python; end-of-run decoder drain so a mid-character final chunk keeps its glyphs), 4096-char output cap, figure extraction (harness-listed MEMFS PNGs → `FS.readFile().slice()` fresh buffers → unlink → TRANSFER on exec-done; relay transfer continues sup→main) |
| `py-loader.ts` | Fork boot wrapper — `bootPyodide({ artifactBase, restore? })`; `restore` drives the fork's `_avloRestore.preBlit` (noInitialRun: runtime init + preRun + ctors run, main() skipped): buildId assert pre-grow → `Module.growMemory(heapLen)` → `loadDynlibReplay` per recorded ABSOLUTE loadOrder (emsdk dsoBaseHook forces memBase, asserts tableBase) → `restoreDsoHandles` → `dsoReplayDone` → HARD `tableLenAtCapture` assert → `readHeapInto` → `handle.close()` in finally → returns `header.hiwire` for `finalizeBootstrap`. `PreBlitError` wraps EVERYTHING thrown inside preBlit (the executor's snap-invalid vs exec-fatal discriminator); `collectSoBytes` maps tar `.so` members → recorded absolute paths (subarrays of the transferred buffers — no FS pre-blit) |

## Security invariants

- **Never-auto-run.** `toggleRunCodeBlock` has exactly FOUR call sites, all
  local gestures: SelectTool play-button canvas hit, CodeTool play-button
  canvas hit, CodeTool DOM `.code-run-btn` click, Cmd/Ctrl+Enter in the CM
  keymap. Nothing observer-, sync-, or hydration-driven may call it; remote
  `output`/`outputStatus` fields render as inert data.
- **Same-origin realm stripped of ambient authority — the authoritative
  layer, fail-closed.** The executor is a same-origin dedicated worker (no
  iframe, no origin boundary), so `py-harden.ts` deletes the realm's authority
  outright after boot — own props AND prototype chain, so the fork's `js` proxy
  reads every name as undefined even if the Python-side guard is stripped:
  network (`fetch`/`XMLHttpRequest`/`WebSocket`/`WebSocketStream`/
  `EventSource`/`WebTransport` + WebRTC `RTCPeerConnection`/`RTCDataChannel` —
  a data channel is raw egress that connect-src CSP does NOT govern),
  fresh-realm escapes (`Worker`/`SharedWorker`/`importScripts` — a nested
  worker would boot with authority restored), origin storage (`indexedDB` =
  y-indexeddb room docs, `caches` = SW shell cache, `cookieStore`, `navigator`
  = OPFS/locks/GPU), and `BroadcastChannel`. `hardenRealm()` then deletes the
  WebAssembly compile surface (`compile`/`instantiate`/`*Streaming`/`Module` —
  all DSO loading is boot-time; a new set ⇒ a new worker) and freezes the
  intrinsics the run protocol flows through (Object/Array/Function/typed-array
  prototypes, JSON, Atomics, Math, Reflect, WebAssembly) so no run can poison
  the machinery for later runs in the same generation. `assertRealmHardened()`
  then RE-CHECKS all three — every scrubbed global undefined, the compile
  surface gone, the intrinsics frozen — and THROWS on any survivor, aborting
  the boot (⇒ exec-fatal, no harness, no runs): because same-origin makes this
  scrub THE boundary (the app's `connect-src 'self' … wss://sync.avlo.io` is
  inherited by same-origin worker scripts, so even in prod the CSP permits
  `'self'`+backend egress — only the scrub actually stops it), a silent
  enumeration miss must fail closed, not run unconfined. Verified in a REAL
  Chrome worker: guard stripped ⇒ all 16 authority names unreachable via `js`
  (incl. `navigator` deleted), numpy/matplotlib run post-harden. `eval`/
  `Function` stay by design — unblockable in-language (any `.constructor`
  chain reaches Function) and with zero I/O authority there is nothing to
  exfiltrate; posture is authority removal, not code-execution prevention.
  DEFENSE-IN-DEPTH: the harness pops `js`/`pyodide_js` from `sys.modules` and a
  `meta_path` guard raises ModuleNotFoundError for `{js, pyodide_js, pyodide,
  _pyodide}` roots. `postMessage` stays (the executor↔supervisor channel) — a
  guard-bypassed spoof reaches only the user's OWN block output, no authority.
  Fork-level `js`-bridge removal LANDED (patch 0008, M3): `import js` is a
  finder-level ModuleNotFoundError even with the guard stripped (Node
  harness 43/43 proves it); prod CSP backstops dynamic `import()`. Build already strips
  `_ssl`/http stack + `_ctypes` (no in-wasm FFI); `_socket` exists only to
  satisfy asyncio's import chain — `-lwebsocket.js` dropped, so no transport;
  `subprocess`/`multiprocessing` import but are inert (no `fork`/`execv`
  syscall in wasm).
- Executor receives exactly one SAB (its generation's PY_SAB).
- **Artifact integrity — every byte the runtime consumes is verified against
  the COMMITTED build-lock** (`@avlo/py-loader`, typed + deep-frozen; the
  shared predicate is `matchesLockEntry` from its `verify.ts`). Four legs:
  (1) **Bundle tars** — supervisor fetch-path sha + size-bounded streaming;
  Cache-API hits RE-verified (poisoned/stale → delete → refetch); the
  executor never fetches them (verified bytes TRANSFER on the boot msg).
  (2) **Core artifacts (glue mjs/asm.js/wasm + stdlib)** — the SW's
  `verifiedPyFirst` route buffers + lock-verifies them before EVERY cache
  write AND on every hit; mismatch = 502 fail-closed, never cached. This is
  the bytes-bind point for pyodide's internal indexURL fetches and the
  executor's dynamic `import()` — the reason a fork boot-from-bytes patch is
  deferred to P3 (it cannot verify the JS glue that would receive the bytes;
  the SW can). Tars deliberately stay on the streaming cacheFirst branch
  (supervisor verifies them; buffering would collapse download progress).
  (3) **Supervisor glue preflight** — `ensureGlueVerified()` fetch+verifies
  the glue trio once per page load (memoized on success only) before the
  first spawn: the drift/corruption gate for no-SW contexts (dev, first
  load), cache-warmer under a SW. (4) **Stdlib as-mounted** — the executor
  hashes `python_stdlib.zip` AS MOUNTED in MEMFS against the boot message's
  lock sha and refuses the boot on drift (restage ⇒ recapture; the anchor
  snapshots key on — and it runs BEFORE any capture, so an unverified stdlib
  can never be baked into a persisted image). (5) **Snapshots** —
  `baseline.snap` is a lock artifact (byte-reproducible; the `baseline`
  script bakes the `--repro` G0 gate) verified by `ensureBaseline` on every
  Cache-API hit AND fetch (the SW deliberately streams `.snap` un-buffered);
  per-set OPFS wrappers carry a sha-256 trailer + a buildHash binding
  (buildHash IS the canonical lock digest, so the wrapper commits to the
  exact lock-verified tars it was generated from); any verify failure =
  delete → regenerate; the fork's BUILD_ID gate + DSO table-drift error
  re-check every restore from inside. `exec-snapshot` is accepted only while
  the executor is NOT ready (capture precedes user code — a forged capture
  can't reach storage), and a restored image lands in the realm BEFORE
  scrub/harden/assert: even a fully poisoned heap boots authority-less.
  Documented residual: first-load-without-SW TOCTOU
  against an actively malicious origin — unclosable without `script-src
  blob:` (a worse trade); every realistic corruption fails closed. Lock:
  committed + byte-gated by `stage --check` — no boot-time discovery fetch.
- **Frozen protocol constants.** `PY_LIMITS`, `PyExecState`, `PyCancelKind`,
  and the generated `PACKAGE_TO_SET`/`SET_BUNDLES` records are
  `Object.freeze`d at module init — caps and set membership are not
  reshapeable at runtime in any of the three threads.
- Caps (`PY_LIMITS`): 30 s + 5 s wall, 4096 output chars, 4 figures ≤ 2048 px,
  queue 4, 2 GB wasm memory ceiling (build-pinned `MAXIMUM_MEMORY`).

## Interrupt discipline (P0-B findings — load-bearing)

1. **Fresh PY_SAB per executor generation.** `Worker.terminate()` on an
   executor blocked in a wasm busy loop closes its ports immediately, but the
   thread spins until its next yield point — its Python signal check keeps
   CONSUMING SIGINT bytes from a shared buffer, silently stealing the
   replacement executor's first interrupt.
2. **Repeat SIGINT writes** every `PY_LIMITS.interruptRepeatMs` until the run
   resolves — bounds any one-shot swallow to ~50 ms extra latency.

## Data flow

```
click/⌘↵ → toggleRunCodeBlock ── import gate (refusal = one 'unavailable' commit)
   │        scanPythonImports → resolveImports → setKey ('stdlib'…'all')
   └→ queue → supervisor {run,setKey}
        set unsatisfied? → respawn: OPFS snapshot hit → {boot: snapshot+tree}
        (zero fetches) · miss → baseline + fetch+verify bundles →
        {boot: snapshot?+bundles+capture} · stdlib → {boot: baseline}
        → executor: restore-or-mount → verify → post_restore → [capture →
        exec-snapshot → OPFS] → scrub/harden → harness → resetImage → {exec}
        → post-run blit reset (stateless runs; needsRespawn ⇒ eager respawn)
        phases/stdout ←── postMessage relay (run-store only; peers see nothing)
        result (ONE) ←── status/output/figures (PNG buffers transferred end-to-end)
   ├→ transactPyOutput (PY_RUN_ORIGIN — NOT undo-tracked; persists+broadcasts)
   │    y.set output / outputStatus / outputVisible → observer → bbox → paint
   └→ placeRunFigures (py-figures.ts) — async ingest → per-figure user-origin
        transact: image object east of the block + elbow connector + figureIds
        append (undo-tracked); same-assetId live figure ⇒ no-op
```

Live UI (stop-square button, "Running… N s" status in the header row, DOM
button swap while editing) reads `py-run-store`; the ticker + phase changes
call `invalidateWorldBBox(block bbox)` — no bbox drift, WYSIWYG-safe.

## Y fields (code kind)

`output: string | undefined` (first real writer), `outputVisible: boolean`,
`outputStatus: CodeOutputStatus | undefined` (`'ok'|'error'|'cancelled'|
'timeout'|'unavailable'|'oom'` — non-ok tints the output text
`THEME.chrome.outputError`). All three written ONLY by `transactPyOutput`
(runs also flip `outputVisible` on; the context-menu toggle still owns manual
visibility). `figureIds: string[] | undefined` — ids of the figure images
this block created (py-figures.ts), written inside the figure-creation
`transact` (user origin — undo reverts image + connector + the append
together; dead ids are pruned on the next figure write).
