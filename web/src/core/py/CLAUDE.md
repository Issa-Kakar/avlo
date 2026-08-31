# Python Runtime (`core/py/`)

> **Everything here is mutable and rapidly changing.** This doc describes
> TODAY's implementation — none of it is a commitment, and the owner is
> actively reworking major surfaces (first-run path, heap-image memory,
> rendering/events). Treat "invariant"/"load-bearing" labels as scoped to the
> current design unless explicitly marked **owner-settled** (security posture)
> or **hard-correctness** (artifact hash verification, meta.json-first tars,
> deps-first DSO order). Challenge anything else freely — with data.

In-browser Python execution for code blocks — a forked Pyodide (currently
Pyodide 314.0.2 / CPython 3.14 / emsdk 5.0.3, MAIN_MODULE=2, side modules
grouped 67→4; built by `packages/py-build/`) running in a supervisor→executor
nested-worker pair. Artifacts + bundle tars are served from the **py worker
origin** `PY_ORIGIN/<buildHash>/…` (`py.avlo.io` prod, `/api/py` Vite proxy
dev; seeded into R2 by py-build's `avlo-build publish`) and verified against the
committed `@avlo/py-loader` build-lock at every trust boundary.

**Snapshots are owned, client-captured, and OPFS-only today** (AVS2 dense
heap images at `opfs:/py/<buildHash>/<setKey>.snap`). That is the current
implementation, not a commitment — build-time-captured snapshots shipped as
served artifacts remain under active consideration (py-build NOTES Open
items). As landed: every set (stdlib included) captures client-side at the
pre-harden slot of its first cold boot and restores on later boots —
zero-network, sub-second. Snapshots ACCELERATE,
never gate: any snapshot failure falls back to a cold mount boot and
self-heals (delete → re-capture). Every run ends with an in-place **blit
reset** (heap rewound to the boot ready-point → stateless, reproducible
runs). Bundle tars are fetched+verified by the supervisor on every spawn
(Cache API `avlo-py-<buildHash>`, shared with the SW — offline second load
runs with zero network) and mounted via the direct-node walker.

History, measurement ledgers, and build-side state live in
`packages/py-build/NOTES.md` — trust it over stale prose anywhere else.

## Boot topology (L2 — supervisor feeds a spawned-first executor)

The supervisor constructs the executor worker FIRST, then three detached
tasks stream boot inputs so bundle prep + ALL OPFS snapshot I/O run in the
shadow of worker spin-up + glue import + wasm instantiate:

- **T1** glue preflight (lock-verify the glue trio, memoized per page **on
  success only** — a rejection nulls the memo so a transient offline failure
  can't brick the page) → `boot-prep` (artifactBase, SAB, stdlib sha,
  buildHash, trySnapshot, captureKey).
- **T2** bundle fetch/verify → `boot-data` (tar buffers TRANSFERRED; sent on
  restore boots too — site-packages mounts and DSO precompile read them).
- **T3** (iff trySnapshot) OPFS open+parse → `snap-header` (header|null),
  then chunked read + fused xxh32 → `snap-heap` (verified heap TRANSFERRED,
  or null) — hash verdicts happen BEFORE bytes cross the boundary. The
  executor never touches OPFS.

The executor parks all messages in module-scope deferreds (any arrival
order) and boots UNIFORMLY under `noInitialRun` when trySnapshot: the async
preBlit driver in py-loader decides restore-vs-cold in flight — header null
⇒ deferred `Module.callMain()` on the SAME Module (no upfront decision
point); pre-mutation failures (buildId/grow/compile) ⇒ same-Module cold via
`exec-snap-invalid`; from the first replay call on the Module is dirty ⇒
`DirtyRestoreError` ⇒ ONE fresh re-instantiate in the same worker. Group
DSOs are precompiled (`WebAssembly.compile`) overlapped with the main
instantiate and replayed as Modules with zero revalidation.

Task discipline (the F1–F17 model — full glossary in NOTES.md): every task
captures its worker+token, every post is a synchronous live()-guarded pair;
teardown bumps the token and MUTES the dying worker's onmessage before
terminate; all snapshot-file mutations ride per-set `snapOps` promise chains
that reads await (poison-delete vs respawn-probe can never race). There is
NO boot watchdog — every executor-side await has a guaranteed completion
signal, and a task failure calls `abortSpawn` (unconditional teardown).

## Files

| File | Role |
|------|------|
| `py-protocol.ts` | Message types for all three threads + frozen `PY_LIMITS` caps. main→sup: `run {runId,code,setKey}`, `cancel {runId}`; sup→main: `phase` (`PyRunPhase` = `queued\|booting\|downloading\|running\|cancelling`, + `received`/`total` download progress — **restore boots surface as plain `booting`**, no dedicated phase: the OPFS I/O hides in the spawn shadow), `stdout`, `result`, `sup-fatal` (→ main tears the whole runtime down), `trace`. sup→exec is FOUR streamed boot msgs (`boot-prep`/`boot-data`/`snap-header`/`snap-heap`) + `exec`; exec→sup: `exec-ready {bootMs,restored}`, `exec-stdout`, `exec-done {…,needsRespawn}`, `exec-snapshot {captureKey,meta,heap}`, `exec-snap-invalid`, `exec-fatal {error,restored}`, `exec-trace`. `PyBundlePayload` = tar bytes + meta prefix/loadOrder; `boot-data` is ALWAYS sent (empty array for `stdlib`). The file also states the formal per-generation arrival contract — and that **teardown IS the abort signal; there is no boot-abort message**. Single source of truth; workers import type-light |
| `py-sab.ts` | 64 B PY_SAB layout (state / runId / heartbeat / epoch / futex-reserved / memKiB; u8[0] + i32[6] reserved — the disarmed interrupt's old cells) + alloc/map. One per executor GENERATION — never reused |
| `py-mount.ts` | The single home for ustar walking (`walkTar`/`octal`/`asciiName`), PEP-706 `dataFilterMode` (identity today — every live header is 0644 — parsed per-entry anyway so a pack change can't silently break parity), strict `parseTarMeta` (a real trust boundary: `safePathSegs` rejects `''`/`.`/`..`, `prefix` must be absolute, meta.json size-bounded — a bad meta minted build-side would otherwise steer mounting/dlopen outside the mount root), `collectSoBytes`, and `mountBundleTree` — direct-node MEMFS grafting with adopted tar-subarray contents (no in-wasm tarfile; ~11 ms for `all`, byte-identical — harness `--section parity` is the standing gate). Dependency-FREE (callers wrap spans); imported by executor, supervisor, py-build harness AND corpus. **One sanctioned duplicate exists**: py-build's `avlo_py_build/packlib.py` keeps a `parse_tar_meta` twin for build-graph isolation (the toolchain must never import `web/src`) |
| `py-snapshot.test.ts` | Vitest over the pure AVS2 half — xxh32 known-answer vectors + chunking invariance, header plan/encode/parse round-trip and every rejection path, chunked heap read + abandon signals. Layer 1 of the four-layer proof surface (see *Verification surfaces*) |
| `py-trace.ts` | Always-on boot/run tracing: per-thread span buffer → `performance.measure` + ONE `py:trace` JSON line per boot/run, relayed exec→sup→main — py-manager owns the visible `console.info` + the `pyTraceLines` ring (`window.__avloPyTraces` in DEV; the e2e read surface). `installWasmTimers()` = boot-window WebAssembly shims (compile/instantiate aggregates incl. DSO precompile) — it also `Proxy`-wraps the `WebAssembly.Module` and `Instance` CONSTRUCTORS, and since `Instance` is deliberately NOT on `hardenRealm`'s delete list, a left-installed wrapper would survive into user-code territory: that is why it MUST uninstall before scrub/harden. Span names are NOTES-ledger comparison keys — rename freely, just re-key the ledger entry (e2e parses only `th`/`kind`/`path`, not span names). Span meta key `n` clobbers the span name in the `{n, at, ms, ...meta}` spread — avoid |
| `py-snapshot.ts` | AVS2 codec + OPFS store. Codec: streaming `Xxh32` (u32-lane fast path), crc32, `planAvsHeapOff`/`encodeAvsHeaderBlock`/`parseAvsHeader` (magic/crc/v/buildHash/setKey/offset-arithmetic hard cross-checks — ANY failure throws). OPFS (ALL supervisor-side): `openSetSnapshotSup` (read-only sync handle → buffered `getFile` contention rung → null; `deletable` marks lock-holding rungs — only those may poison-delete), `readSnapshotToBuffer` (chunked reads into ONE buffer folding the hash, macrotask yield + live/abandoned checks per chunk), `writeSetSnapshot` (exclusive handle = multi-tab arbiter; heap chunks FIRST folding the hash, header LAST — torn write ⇒ structurally invalid), `deleteSetSnapshot`, stale-buildHash dir GC. `SnapReadHandle` abstracts OPFS/Node-fd (the py-build harness and vitest import this exact shipped codec) |
| `py-manager.ts` | Main-thread API: `toggleRunCodeBlock` / `cancelRun` / `isRunnableCodeBlock` / `pyTraceLines` (100-line ring). Lazy supervisor construction, FIFO queue (cap 4, further clicks silently dropped), single-flight dispatch, pre-run import gate, ONE Y commit per run, 500 ms status ticker, and `resetRuntime()` — a supervisor `onerror` or `sup-fatal` fails every queued AND in-flight run, terminates the worker and nulls it so the next click starts clean. See *Main-thread lifecycle* |
| `py-run-store.ts` | Ephemeral per-block run phase + progress (Zustand, non-persisted, presence-store pattern). Never written to Y. **`liveOutput` is currently write-only** — the `exec-stdout → stdout → appendOutput` relay has no reader in the tree; both the canvas (`code-system.ts` status text) and the DOM overlay (`CodeTool.createOutputDiv`) render final output from **Y**. Two in-file comments still claim a "DOM overlay live view" consumer that does not exist |
| `py-figures.ts` | Result-time figure placement: `placeRunFigures(blockId, runId, figures)` — ingest PNGs through the image pipeline, assetId-dedup against the block's still-alive `figureIds` images (same plot = no-op; CREATE-ONLY, never update/move/delete), east placement at drag-drop sizing (400wu) via `slideClear`, then ONE user-origin `transact` per figure: `insertImage` + elbow `insertConnector` + `figureIds` append — UNDO-TRACKED by owner decision, unlike the output commit. Per-block stale-batch guard |
| `py-imports.ts` | Pure: `scanPythonImports` (triple-quote-aware line scan) + `resolveImports` (GENERATED allowlist + package→set merge by bundle union) + refusal message listing the real available packages |
| `py-stdlib-modules.gen.ts` | GENERATED by py-build `avlo-build stage` (checked in; `avlo-build stage --check` = drift gate): `STDLIB_MODULES` (pruned-zip tops + true builtins + tombstoned tops), `PACKAGE_TO_SET`, `AVAILABLE_PACKAGES`, `SET_BUNDLES`, `PySetKey` |
| `pyodide-fork.gen.d.ts` | GENERATED by py-build `avlo-build stage` from the fork's emitted d.ts (patch 0009 declares `_module`/`_api` + Module runtime exports). `py-loader`'s `Pyodide` = its `PyodideInterface`; drift-gated by `avlo-build stage --check`, deliberately NOT hashed into buildHash (types carry no runtime bytes), biome-ignored |
| `py-harness.ts` | Python harness source: fresh `__main__` per run (belt-and-braces — the blit reset rewinds the whole interpreter), linecache-seeded `'<block>'`, ast last-expression echo, harness-frame-trimmed tracebacks, defense-in-depth import guard, matplotlib figure harvest (dpi-scaled to `maxFigurePx`, first `maxFigures`, PNGs to MEMFS `/tmp`; `Gcf.destroy_all()` unconditional). Primitive-only returns (JSON string; figures as `[path, w, h]` triples) |
| `py-harden.ts` | Realm hardening, the AUTHORITATIVE isolation layer: `scrubWorkerScope()` (delete network incl. WebRTC + fresh-realm escapes + origin storage + BroadcastChannel, own props AND prototype chain) + `hardenRealm()` (delete the WebAssembly compile surface, freeze protocol-bearing intrinsics/prototypes/constructors) + `assertRealmHardened()` (FAIL-CLOSED full re-sweep — any survivor aborts the boot). Dependency-free — the py-build Node harness exercises the exact shipped code against a real fork boot |
| `py-supervisor.ts` | Worker — the always-live control plane. Owns every wall clock (30 s timeout → immediate kill; 15 s idle teardown — THE memory-reclaim knob, respawn restores from OPFS), executor lifecycle (L2 spawn tasks above, token+mute teardown discipline, eager respawn on `needsRespawn`), bundle fetch+verify (Cache API; SW `x-avlo-verified` hits skip the re-hash, unmarked hits re-verified — corrupt → delete → refetch; buffers TRANSFERRED outright; download progress live-guarded), `ensureGlueVerified()` preflight, capture persistence (`exec-snapshot` accepted ONLY pre-ready — forged-capture guard; write rides the snapOps chain overlapping the first run), poison ladder — THREE rungs: pre-ready `exec-fatal restored:true` ⇒ delete + ONE noSnapshot retry with the run pending; a restored gen's first-run hard failure ⇒ chained delete before the eager respawn; **and a post-ready `exec-fatal` inside the `firstRunAfterRestore` window ⇒ chained delete too**. Set satisfaction is superset-covers-subset (`setSatisfies` by bundle-name inclusion), so a booted `all` generation serves a `numpy+pandas` run with no respawn, and eager respawns reuse the LAST REQUESTED set, not the booted one. Boot failure with nothing pending ⇒ go dormant; boot failure WITH a pending run ⇒ no eager respawn (it would just boot a second doomed worker). Cancel/timeout resolution = `killRun` (immediate synthesized result + kill + respawn — see *Cancellation* below), `SNAPSHOTS_ENABLED` kill switch (hardcoded `true`, so the `cold boot (snapshots off)` path is unreachable today). Refuses runs in non-crossOriginIsolated contexts; offline-uncached failures surface a friendly "connect once (~X MB)" result |
| `py-executor.ts` | Nested worker. Boot: park feeds → precompile group DSOs (overlapped) → uniform `bootPyodide` (restore-or-cold via preBlit; `DirtyRestoreError` ⇒ snap-invalid + fresh second boot in-worker) → walker mounts (`replayed` on restore skips the dlopen loop — the groups are LDSO-registered, but the `.so` FILES must land: ExtensionFileLoader fopen/fstats before dlopen) → stdlib-zip as-mounted hash vs boot-msg sha (ALWAYS before any capture) → `_avlo_runtime.post_restore()` → cold only: `freeDsoFileData` knife (−~14.6 MB) → `captureSetSnapshot` (BUNDLE_IMPORTS bake — numpy MUST bake `numpy.random`; matplotlib also bakes a throwaway render+savefig so the ~70 ms Agg/font/encoder warmup lands in the image, not the first real figure — + gc×2 + meta via fork APIs + dense `HEAP8.slice`, transferred; best-effort) → scrub/harden/fail-closed assert BEFORE harness install → hooks + harness → **`resetImage = HEAP8.slice()`** at the ready-point of EVERY boot. Run: `run-python` → figures off MEMFS (fresh buffers, transferred end-to-end) → **blit reset** (guard `wasmTable.length` unchanged → `HEAP8.set(resetImage)` + zero tail + `POST_RUN_RESET` /tmp sweep — MEMFS is JS-side and survives the blit); `needsRespawn = !blitOk \|\| heap > 1.5× image`. Raw-write stdout/stderr hooks (flush ≥100 ms / ≥8 192 **characters** — `stdoutFlushBytes` is compared against the post-decode JS string length, so multi-byte output flushes later than the name suggests — inside the write callback, since no timers run mid-Python; per-run decoders + end-of-run drain), 4096-char output cap |
| `py-loader.ts` | Fork boot wrapper + preBlit driver — `bootPyodide({ artifactBase, snapshot?: PySnapshotFeeds })`. Feeds = `{headerP, heapP, modulesP, onSnapInvalid, outcome}`. preBlit order: header await (null ⇒ `runCold` = deferred `Module.callMain()` + exitCode re-check) → buildId assert pre-grow → `Module.growMemory(heapLen)` + exact-length assert → await precompiled Modules → **[MUTATION ZONE begins]** `API.setDsoLoadInfo(header.dso)` → `loadDynlibReplay(path, Module)` per recorded ABSOLUTE loadOrder (emsdk dsoBaseHook forces memBase, asserts tableBase) → `restoreDsoHandles` → `dsoReplayDone` → HARD `tableLenAtCapture` assert → `touchWhileAwaiting` (pre-touch grown pages via value-preserving `Atomics.or` + MessageChannel yield while the heap is in flight) → blit → `header.hiwire` for `finalizeBootstrap`. Mutation-zone throws wrap in `DirtyRestoreError`; cold-main failures deliberately do NOT. Also `freeDsoFileData` (emsdk-pinned +28/+32 struct offsets, sanity-checked — aborts the knife, never the boot) |

## Serving & caching

- **workers/py** serves `GET /<buildHash>/<file>` + `/<buildHash>/bundles/<name>.tar`
  anonymously — immutable content-hashed keys, brotli `.br` sibling
  negotiation, edge cache. See `workers/CLAUDE.md`.
- **SW routes** (verify-at-fill — nothing the SW writes is unverified):
  core artifacts (lock `artifacts` keys) ride `verifiedPyFirst` — buffered +
  lock-verified before EVERY cache write, stored with `x-avlo-verified: 1`
  and pristine HTTP-cache identity (so V8's disk wasm code cache can engage);
  marked hits serve as-is, unmarked legacy hits delete + refill; mismatch =
  502 fail-closed, never cached. Tars ride `verifiedTarFirst` — **any** cache
  hit serves as-is, marked or not (the delete-and-refill rule is
  `verifiedPyFirst`-only; the supervisor re-verifies unmarked tar reads
  itself), and a miss streams to the page unbuffered (download progress
  intact), verified + marked-put on a clone in `waitUntil`. Anything else on
  the py origin falls through to plain cacheFirst. Stale `avlo-py-*`
  generations are evicted on activate.
- The supervisor shares the same Cache API keys: its own miss-path puts are
  marked (it verified the bytes), marked hits skip the ~40 MB/boot re-hash.
- `.snap` files don't cross HTTP today — snapshots are OPFS-only,
  client-captured. (If the build-time-snapshot direction lands, shipped
  snapshots would need their own verified route + lock entry here.)

## Security invariants

- **Never-auto-run.** `toggleRunCodeBlock` has exactly FOUR production call
  sites, all local gestures: SelectTool play-button canvas hit, CodeTool
  play-button canvas hit, CodeTool DOM `.code-run-btn` click, Cmd/Ctrl+Enter
  in the CM keymap (plus the DEV-only `dev/test-bridge.ts` e2e entry point).
  Nothing observer-, sync-, or hydration-driven may call it; remote
  `output`/`outputStatus` fields render as inert data.
- **Same-origin realm stripped of ambient authority — the authoritative
  layer, fail-closed.** The executor is a same-origin dedicated worker (no
  iframe, no origin boundary), so `py-harden.ts` deletes the realm's authority
  outright after boot — own props AND prototype chain, so the fork's `js`
  proxy reads every name as undefined even if the Python-side guard is
  stripped: network (`fetch`/`XMLHttpRequest`/`WebSocket`/`WebSocketStream`/
  `EventSource`/`WebTransport` + WebRTC `RTCPeerConnection`/`RTCDataChannel` —
  a data channel is raw egress that connect-src CSP does NOT govern),
  fresh-realm escapes (`Worker`/`SharedWorker`/`importScripts` — a nested
  worker would boot with authority restored), origin storage (`indexedDB` =
  y-indexeddb room docs, `caches` = SW shell cache, `cookieStore`, `navigator`
  = OPFS/locks/GPU), and `BroadcastChannel`. `hardenRealm()` then deletes the
  WebAssembly compile surface (`compile`/`instantiate`/`*Streaming`/`Module` —
  all DSO loading is boot-time; a new set ⇒ a new worker) and freezes the
  intrinsics the run protocol flows through so no run can poison the
  machinery for later runs in the same generation. `assertRealmHardened()`
  RE-CHECKS all three and THROWS on any survivor, aborting the boot
  (⇒ exec-fatal, no harness, no runs): same-origin makes this scrub THE
  boundary (the app CSP is inherited and still permits `'self'`+backend
  egress — only the scrub actually stops it), so a silent enumeration miss
  must fail closed, not run unconfined. `eval`/`Function` stay by design —
  unblockable in-language, and with zero I/O authority there is nothing to
  exfiltrate; the posture is authority removal, not code-execution
  prevention. DEFENSE-IN-DEPTH: the harness pops `js`/`pyodide_js` from
  `sys.modules` and a `meta_path` guard blocks the `{js, pyodide_js,
  pyodide, _pyodide}` roots; fork patch 0008 removes the js bridge at the
  finder level (proven by the Node harness even with the guard stripped);
  prod CSP backstops dynamic `import()`. The build tombstones the http stack,
  `_ctypes`, `urllib.request` and `multiprocessing`; `subprocess`/`socket`/
  `ssl`/`threading` still import but are inert (no fork/execv syscall and no
  pthreads in wasm, no socket transport — `_ssl` is upstream-disabled as a C
  extension and survives only as Pyodide's pure-py stub, so `import ssl`
  succeeds and can encrypt nothing). They stay because load-bearing chains
  import them at top level; see NOTES "Non-functional but UNPRUNABLE".
  `postMessage` stays (the exec↔sup channel) — a spoof reaches only the
  user's own block output, no authority.
- Executor receives exactly one SAB (its generation's PY_SAB).
- **Artifact integrity — every byte the runtime consumes is verified against
  the COMMITTED build-lock** (`@avlo/py-loader`; shared predicate
  `matchesLockEntry` from its `./verify` subpath). Legs: (1) **bundle tars**
  — supervisor fetch-path sha + size-bounded streaming; unmarked Cache-API
  hits re-verified (poisoned/stale → delete → refetch); the executor never
  fetches. (2) **Core artifacts** (glue trio + stdlib zip) — the SW's
  `verifiedPyFirst` route (above): the bytes-bind point for pyodide's
  internal indexURL fetches and the executor's dynamic `import()`.
  (3) **Supervisor glue preflight** — `ensureGlueVerified()` once per page
  load (memoized on success only): the drift gate for no-SW contexts (dev,
  first load), cache-warmer under a SW. (4) **Stdlib as-mounted** — the
  executor hashes `python_stdlib.zip` AS MOUNTED in MEMFS against the
  boot-prep lock sha and refuses the boot on drift; runs BEFORE any capture,
  so an unverified stdlib can never bake into a persisted image. (5)
  **Snapshots** — OPFS-only and not fetched (today); header carries a crc32 + the
  buildHash/setKey binding (buildHash IS the canonical lock digest, so a
  wrapper commits to the exact lock-verified inputs it was captured over);
  the supervisor folds an xxh32 over every heap byte DURING the read,
  pre-transfer; the fork re-checks from inside (BUILD_ID pre-grow, per-DSO
  tableBase, hard tableLenAtCapture). ANY failure = delete → cold.
  `exec-snapshot` is accepted only while the executor is NOT ready (capture
  precedes user code — a forged capture can't reach storage), and a restored
  image lands in the realm BEFORE scrub/harden/assert: even a fully poisoned
  heap boots authority-less. Documented residual: first-load-without-SW
  TOCTOU against an actively malicious origin — unclosable without
  `script-src blob:` (a worse trade); every realistic corruption fails
  closed.
- **Frozen protocol constants.** `PY_LIMITS`, `PyExecState`, `PyCancelKind`
  and the generated `PACKAGE_TO_SET`/`SET_BUNDLES` records are
  `Object.freeze`d at module init, so caps and set→bundle membership are not
  reshapeable at runtime. Two caveats: the other two generated tables,
  `STDLIB_MODULES` and `AVAILABLE_PACKAGES`, are plain `Set`s — `ReadonlySet`
  is a compile-time type only (and `Object.freeze` wouldn't help; Set entries
  live in internal slots). And this is a **main-thread** property: the
  executor imports none of these tables (only the erased `PySetKey` type);
  `SET_BUNDLES` reaches the supervisor, the rest stay in `py-imports.ts`.
- **Caps:** `PY_LIMITS` in `py-protocol.ts` is the single source — read it
  there rather than trusting any copied table. Two non-obvious ones: the
  harness mirrors `maxFigures`/`maxFigurePx` as local literals (import-free
  file), and the **2 GB wasm memory ceiling is NOT in `PY_LIMITS`** — it is a
  build pin (`MAXIMUM_MEMORY` in py-build patch 0001).

## Cancellation (2026-08: a kill, not an interrupt)

The interrupt buffer is **never armed** — the armed signal check taxed every
run 2-4.5% (in-wasm clock decrement + a wasm→JS SAB read every 51st tick) for
a graceful-cancel path the product doesn't currently need. What remains:

1. **Cancel/timeout = immediate kill.** `killRun` posts the `cancelling`
   phase, synthesizes the result (`Run cancelled.` / `Run timed out after
   30 s.`), terminates the executor and eager-respawns (cached bundles + OPFS
   restore ⇒ warm replacement in ~1 s). Any stdout the run printed is
   discarded with it.
2. **The UI path stays fully wired** — `CancelMsg`, toggle-to-cancel,
   `cancelling` phase, `'Stopping…'` label, `PyCancelKind` — as the seam a
   future real cancellation lands behind (candidates: worker-terminate-only
   designs, or re-arming with a far longer signal interval).
3. **Fresh PY_SAB per executor generation** still stands (state/heartbeat/
   mem plane — generation state must not bleed across spawns). The historical
   interrupt-steal rationale lives in py-build NOTES.
4. `ExecDoneMsg.interrupted` now only means user code raised
   `KeyboardInterrupt` itself; the supervisor maps it to plain `'error'`.

## Main-thread lifecycle (`py-manager.ts`)

The supervisor worker is **lazily constructed on first run** and lives until
something kills it; the executor underneath it is spawned and torn down
freely (15 s idle teardown is the memory-reclaim knob).

- **Toggle semantics.** One entry point, three meanings by current phase:
  click on idle = run, on `queued` = **dequeue**, on running = cancel.
- **Queue.** Global FIFO, `queueCap` 4 counting in-flight + queued; a
  queue-full click is **silently dropped** (feedback is polish backlog).
  Single-flight dispatch — one run in flight at a time.
- **Status clock.** The "Running… N s" counter re-stamps `startedAt` at the
  `running` phase, so it times execution, not queue/boot/download. The 500 ms
  ticker and phase changes call `invalidateWorldBBox(block bbox)`.
- **Commit.** Exactly ONE Y commit per run, and it is dropped entirely if the
  block was deleted or the room left meanwhile. `placeRunFigures` runs after
  it on every result, figure-less ones included.
- **`resetRuntime()`.** A supervisor `onerror` or a `sup-fatal` fails every
  queued *and* in-flight run, terminates the worker, and nulls it — the next
  click boots a clean runtime.

## Verification surfaces

Four independent layers; the Node harness is the one that matters most,
because it exercises **shipped modules verbatim** (`py-harden`, `py-harness`,
`py-mount`, `py-protocol`, `py-snapshot`, `py-loader` + py-loader's
`verify.ts`) rather than a re-implementation.

| Layer | What | Where |
|---|---|---|
| vitest | pure AVS2 codec — xxh32 vectors, header round-trip + every rejection path, chunked read/abandon | `py-snapshot.test.ts` |
| py-build Node harness | five sections — `base` · `seaborn` · `snapshot` · `parity` · `verify` — against real fork boots | `pnpm harness` (`packages/py-build/`) |
| e2e | real browser + real OPFS; parses the `py:trace` line schema | `e2e/py-snapshot.spec.ts` |
| codegen drift gate | `py-stdlib-modules.gen.ts` + `build-lock.json` byte-identity | `pnpm --filter @avlo/py-build stage:check` |

Trace lines are the shared observability surface: one `py:trace` JSON line
per boot/run, shape `{ th, kind, seq, …extra, spans }` with `th ∈ {sup,exec}`
and `kind ∈ {boot, run, boot-fatal, fatal, snap-invalid}`. e2e parses only
`th`/`kind`/`path`; span names are NOTES-ledger comparison keys — rename
freely, just re-key the ledger.

## Data flow

```
click/⌘↵ → toggleRunCodeBlock ── import gate (refusal = one 'unavailable' commit)
   │        scanPythonImports → resolveImports → setKey ('stdlib'…'all')
   └→ queue → supervisor {run,setKey}
        set unsatisfied? → spawnExecutor (worker FIRST, then feeds):
          T1 glue-preflight → boot-prep · T2 bundles → boot-data (transfer)
          · T3 OPFS open/parse → snap-header · read+hash → snap-heap (transfer)
        → executor: precompile DSOs ∥ uniform boot — preBlit restores
          (replay + blit) or runs cold (deferred callMain) → walker mounts
          (+dlopen cold) → stdlib verify → post_restore → [cold: dso-free →
          capture → exec-snapshot → sup writes OPFS] → scrub/harden/assert →
          harness → resetImage → {exec}
        → post-run blit reset (stateless runs; needsRespawn ⇒ eager respawn)
        phases ←── postMessage relay (run-store only; peers see nothing)
                   (stdout is relayed on the same channel but has no reader)
        result (ONE) ←── status/output/figures (PNG buffers transferred end-to-end)
   ├→ transactPyOutput (PY_RUN_ORIGIN — NOT undo-tracked; persists+broadcasts)
   │    y.set output / outputStatus / outputVisible → observer → bbox → paint
   └→ placeRunFigures (py-figures.ts) — async ingest → per-figure user-origin
        transact: image object east of the block + elbow connector + figureIds
        append (undo-tracked); same-assetId live figure ⇒ no-op
```

Live UI (stop-square button, "Running… N s" status, DOM button swap while
editing) reads `py-run-store`; the ticker + phase changes call
`invalidateWorldBBox(block bbox)`.

## Y fields (code kind)

`output: string | undefined` (first real writer), `outputVisible: boolean`,
`outputStatus: CodeOutputStatus | undefined` (`'ok'|'error'|'cancelled'|
'timeout'|'unavailable'|'oom'` — non-ok tints the output text
`THEME.chrome.outputError`). **`output` and `outputStatus` are written ONLY
by `transactPyOutput`. `outputVisible` is not** — runs flip it on through
`transactPyOutput`, but block creation (`CodeTool`), the context-menu toggle
(`CodeTool.toggleOutput`), the selection field table, and the DEV test bridge
all write it under the normal user origin. `figureIds: string[] | undefined` — ids of the figure images
this block created (py-figures.ts), written inside the figure-creation
`transact` (user origin — undo reverts image + connector + the append
together; dead ids are pruned on the next figure write).
