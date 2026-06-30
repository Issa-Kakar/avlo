# cf-dynamic-executor — Worker Loaders prototype

A local, no-deploy prototype that establishes the behaviour of Cloudflare
**Dynamic Workers** (the `worker_loaders` / `env.LOADER` binding) for a
per-room, cost-efficient, securely-sandboxed code/artifact executor.

Everything here runs under `wrangler dev` (local `workerd`) — **no Cloudflare
account or deploy required** to reproduce the findings.

## Run

```bash
npm install
npm run dev          # wrangler dev on http://127.0.0.1:8799
bash probe.sh        # in a second shell — exercises every claim
```

## What it proves (all reproduced by `probe.sh`)

| # | Behaviour | Endpoint |
|---|-----------|----------|
| 0 | `env.LOADER` exposes both `load()` and `get()` **in local dev** | `/info` |
| 1 | `get(id, cb)` caches by `id`; same id reuses the warm isolate and the callback is **not** re-run. Module state, globals **and `Array.prototype` tampering persist across executions** in a reused isolate (the leak that makes naive reuse unsafe) | `/counter?id=` |
| 2 | A different `id` is a different V8 isolate → hard isolation; roomX's pollution never reaches roomY | `/counter?id=` |
| 3 | `load()` is a fresh isolate every call | `/counter-load` |
| 4 | `globalOutbound: null` blocks all egress (`fetch`/`connect`) | `/egress` |
| 5 | **Content-addressing** (`id = sha256(code)`) collapses billable "unique workers" to one-per-distinct-code; re-running identical code is a free cache hit | `POST /run` |
| 6 | A real **Preact + htm + render-to-string** component is built and executed inside a **network-isolated** sandbox, producing an HTML artifact; changing *props* is a cache hit, changing *code* is a new load | `POST /render-react` |

## Key API facts (verified locally)

- Binding config (`wrangler.jsonc`): `"worker_loaders": [{ "binding": "LOADER" }]`.
- `env.LOADER.get(id, () => WorkerCode)` / `env.LOADER.load(WorkerCode)` → `WorkerStub`; run via `stub.getEntrypoint().fetch(req)`.
- `WorkerCode = { compatibilityDate, compatibilityFlags?, mainModule, modules, env?, globalOutbound? }`.
- **Module keys must end in `.js` or `.py`** (or the value must be a typed object) — `.mjs`/`.ts` keys are rejected at load time.
- The child sees **only** the `env` you pass it (capability model) — no ambient access to the host's bindings.
- `globalOutbound: null` = no network; pass a `Fetcher` to intercept/redirect/allowlist instead.

## Files

- `src/index.ts` — host worker: routes, content-addressed `/run`, `/render-react`, isolation probes, load accounting.
- `src/react-build.ts` — assembles a self-contained Preact-SSR module map from a user component.
- `src/vendor/*.mjs.txt` — preact, htm, preact-render-to-string bundles, inlined as text (so the sandbox needs no network).
- `probe.sh` — reproducible empirical probe.

In production the hand-vendored Preact bundles are replaced by
[`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler)
(`createWorker({ files })`), which compiles TSX and resolves npm deps at runtime
into the same `{ mainModule, modules }` shape.
