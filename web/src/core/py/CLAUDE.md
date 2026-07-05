# Python Runtime (`core/py/`)

In-browser Python execution for code blocks — forked Pyodide 0.29.4 (built by
`packages/py-build/`; artifacts dev-served from `/py-dev/fork/` via the
`pyDevStatic` Vite middleware) running in a supervisor→executor nested-worker
pair. P1 state: cold boot per executor spawn, stdlib only; snapshots (P3),
package bundles (M2), and real artifact serving (M3) layer on top. Master
plan: `/home/issak/.claude/plans/prompt-md-i-copied-my-synthetic-octopus.md`;
build-side state: `packages/py-build/NOTES.md`.

## Files

| File | Role |
|------|------|
| `py-protocol.ts` | Message types for all three threads + `PY_LIMITS` caps. Single source of truth; workers import type-light (no yjs) |
| `py-sab.ts` | 64 B PY_SAB layout (interrupt u8[0] / state / runId / heartbeat / epoch / futex-reserved / cancelKind / memKiB) + alloc/map + interrupt write/clear |
| `py-manager.ts` | Main-thread API: `toggleRunCodeBlock` / `cancelRun` / `isRunnableCodeBlock`. FIFO queue (cap 4), single-flight dispatch, pre-run import gate, ONE Y commit per run, 500 ms status ticker |
| `py-run-store.ts` | Ephemeral per-block phase + live output (Zustand, non-persisted, presence-store pattern). Never written to Y |
| `py-imports.ts` | Pure: `scanPythonImports` (triple-quote-aware line scan) + `resolveImports` (stdlib allowlist + package→setKey map) + refusal message |
| `py-harness.ts` | Python harness source: fresh `__main__` per run (interpreter/module state SHARED across runs until P3's blit reset), linecache-seeded `'<block>'`, ast last-expression echo, harness-frame-trimmed tracebacks, defense-in-depth import guard. Primitive-only returns (JSON string) |
| `py-supervisor.ts` | Worker. Executor lifecycle, wall clocks (30 s soft + 5 s hard grace; 2 s cancel grace), idle teardown (2 min), eager respawn, result synthesis |
| `py-executor.ts` | Nested worker. Pyodide instance, raw-write stdout/stderr hooks (flush ≥100 ms/≥8 KB inside the write callback — no timers run mid-Python), 4096-char output cap |
| `py-loader.ts` | Fork boot wrapper (`loadPyodide` config; P3 adds `_loadSnapshot` + `_preRestoreHook`) |

## Security invariants

- **Never-auto-run.** `toggleRunCodeBlock` has exactly FOUR call sites, all
  local gestures: SelectTool play-button canvas hit, CodeTool play-button
  canvas hit, CodeTool DOM `.code-run-btn` click, Cmd/Ctrl+Enter in the CM
  keymap. Nothing observer-, sync-, or hydration-driven may call it; remote
  `output`/`outputStatus` fields render as inert data.
- **No JS bridge / no network for run code — two layers.** AUTHORITATIVE:
  `py-executor.ts` `scrubNetworkScope()` deletes `fetch`/`XMLHttpRequest`/
  `WebSocket`/`EventSource` from the worker realm (own props + prototype
  chain) right after boot — the fork's `js` proxy then reads them as
  undefined. DEFENSE-IN-DEPTH: the harness pops `js`/`pyodide_js` from
  `sys.modules` and a `meta_path` guard raises ModuleNotFoundError for
  `{js, pyodide_js, pyodide, _pyodide}` roots (pyodide/_pyodide stay cached
  for internals, so the hook covers the popped bridge + uncached submodules).
  Fork-level bridge removal (patch 0006) lands with M3; prod CSP backstops
  dynamic `import()`. Build already strips `_ssl`/http stack; `_socket`
  exists only to satisfy asyncio's import chain — no transport.
- Executor receives exactly one SAB (its generation's PY_SAB).
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
   └→ queue → supervisor {run} → executor {exec} → runPython(harness)
        phases/stdout ←── postMessage relay (run-store only; peers see nothing)
        result (ONE) ←── status/output/figures
   └→ transactPyOutput (PY_RUN_ORIGIN — NOT undo-tracked; persists+broadcasts)
        y.set output / outputStatus / outputVisible → observer → bbox → paint
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
visibility).
