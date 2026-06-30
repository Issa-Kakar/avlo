# Per-room dynamic code/artifact executor on Cloudflare Dynamic Workers

**Goal.** A per-room executor that builds and runs user-supplied JS/TS/React on
Cloudflare's **Dynamic Workers** (the `worker_loaders` / `env.LOADER` binding),
keeps the client thin, lets generated artifacts render in native z-order
alongside avlo canvas objects (HTML-in-canvas), and is **secure** (a malicious
execution in a room cannot affect other executions) **and cost-efficient**
(reuse the per-room worker; don't pay for a brand-new worker on every request).

This report answers three things the brief flagged as confusing or hard:

1. **Security within the trust boundary** — can same-room, possibly-malicious
   code be prevented from interfering with other executions?
2. **Reuse the same dynamic worker per room** — is that possible, and how?
3. **"Make the script deterministic / reuse the same worker ID even when the
   code changes, to dodge the new-worker-per-request cost"** — is that possible?

Short version: (1) **yes**, with caveats; (2) **yes**, but the thing you reuse
per-room is *not* a Dynamic Worker; (3) **no — and you shouldn't want to** — the
correct lever is **content-addressing**, which is both Cloudflare's official
recommendation and provably the minimum-cost option that still isolates.

Everything below was verified against primary Cloudflare docs/blog/`workerd`
source **and** reproduced locally with `wrangler dev` (no deploy). See
`README.md` + `probe.sh` for the runnable proof.

---

## 1. How Dynamic Workers actually work (verified)

A normal ("loader") Worker gets a `worker_loaders` binding and spins up other
Workers at runtime from code passed as **strings**:

```jsonc
// wrangler.jsonc — the binding points at no external resource
{ "worker_loaders": [ { "binding": "LOADER" } ] }
```

```ts
env.LOADER.load(code: WorkerCode): WorkerStub                       // fresh isolate every call (no cache)
env.LOADER.get(id: string, () => Promise<WorkerCode>): WorkerStub   // cached/kept-warm, keyed by id
```

```ts
// WorkerCode (workerd-canonical shape)
{
  compatibilityDate: string;            // required
  compatibilityFlags?: string[];        // e.g. ["python_workers", "nodejs_compat"]
  mainModule: string;                   // key into modules
  modules: Record<string, string | { js?|cjs?|py?|text?|data?|json?|wasm? }>;
  env?: any;                            // the ONLY things the child can access
  globalOutbound?: Fetcher | null;      // network kill-switch / gateway
  limits?: { cpuMs?: number; subRequests?: number };   // per-invocation caps
  tails?: Fetcher[];                    // Tail Workers for the child's logs
}
// stub.getEntrypoint(name?, {props?, limits?}) -> Fetcher (fetch + RPC)
// stub.getDurableObjectClass(name?, {props?}) -> DurableObjectClass (DO Facets)
```

**Verified caching contract** (this is the crux):

- The **cache key is the `id` string — the runtime never hashes your code.**
- *"The callback you provide will only be called if the Worker is not already
  loaded."* → on a warm hit the callback is skipped; you cannot hot-swap code
  under a live id.
- *"You should ensure that the callback always returns exactly the same content,
  when called for the same ID. If anything about the content changes, you must
  use a new ID."* → mixing different code under one id is **unsupported**.
- Warmth is **best-effort, not guaranteed**: *"a later call with the same ID may
  instead start a new isolate from scratch"*; the callback *"could be called any
  number of times."* Cold (re)loads are cheap (ms).
- `load()` *"does not cache by ID. Each call creates a fresh Worker."*

Reproduced locally (`/counter`, `/get`): same id → callback ran exactly once,
counter persisted; new id → callback ran again; `load()` → fresh every call.

> **Module-key gotcha (hit in the prototype):** plain-string module values must
> use `.js`/`.py` keys, else load throws *"Module name must end with '.js' or
> '.py' …"*. Use the object form `{ js: src }` to decouple type from filename.

---

## 2. The cost model (current, verified 2026-06-30)

From the **live** pricing page (this changed recently — it is **no longer
waived**):

> *"Starting May 26, 2026, Dynamic Workers created daily are billed as part of
> Dynamic Workers pricing"* — **`+$0.002 per Dynamic Worker per day`**.
>
> **"A Dynamic Worker is uniquely identified by its Worker ID *and* code — if
> either changes, it counts as a new Dynamic Worker."**

Included monthly (Workers Paid): **1,000 unique Dynamic Workers**, **10M
requests** (+$0.30/M after), **30M CPU-ms** (+$0.02/M after). *"Dynamic Workers
requests and CPU time … count toward your Workers requests and CPU usage."*
There are **no concurrency/rate/count limits** on loading.

What this means precisely:

- The new, Dynamic-Workers-specific charge is **per `(id, code)` pair, per
  day** — *not* per request, *not* per CPU-second (those are the normal Workers
  meters).
- Re-running the **same** `(id, code)` all day = **one** billable unit.
- This is exactly why the playground (and the brief's pain) gets expensive: if
  every request uses a **new** id (or `load()`), every request is a new unique
  Dynamic Worker. The Cloudflare *starter* uses `load()` (no cache); the
  *playground* already content-addresses (`id = sha256(files+bundle+minify)`).

### Worked numbers for avlo

Let **D** = number of *distinct* code artifacts actually executed per day,
account-wide (after content-addressing — identical code counts once).

| Scenario | Distinct artifacts/day (D) | Unique DWs/mo | Monthly DW fee |
|---|---|---|---|
| Light | 30 | ~900 | **$0** (under 1,000 free) |
| Medium | 200 | ~6,000 | (6,000−1,000)×$0.002 = **$10** |
| Heavy | 2,000 | ~60,000 | (60,000−1,000)×$0.002 = **$118** |

Plus normal request + CPU metering (shared with your existing Workers usage).
The naïve "new worker per request" design would replace **D** with *number of
executions* — easily 100–1000× larger. **Content-addressing is the entire
cost story.**

---

## 3. The security / trust boundary (verified + reproduced)

**Each Dynamic Worker is its own V8 isolate.** Memory isolation is the *isolate*
boundary, not a process/VM boundary: many isolates share a process/thread.
Cloudflare layers defenses (custom second-layer sandbox with risk-based
cordoning, hardware MPK, Spectre mitigations such as a frozen `Date.now()` and
no shared memory, fast V8 patching, malicious-pattern scanning). Their own
security model concedes: *"Any time you have more than one tenant running code on
the same machine, Spectre attacks are possible."*

> **Tradeoff vs. your AWS path:** this is *strong* isolation and is literally
> marketed as *"a lightweight alternative to containers for securely sandboxing
> code you don't trust"* — but it is **not** the hardware/microVM boundary of
> Firecracker (your AWS Lambda microVM Python path). For "same-room user code
> must not corrupt *other* executions," V8 isolates + content-addressing are the
> right fit. For hostile cross-tenant secret exfiltration as the threat model,
> the microVM is stronger. Use the right tool per workload (you already are).

Four boundaries, each **reproduced locally** (`probe.sh`):

| Boundary | Mechanism | Local result |
|---|---|---|
| **State leakage across executions** | a reused isolate keeps module globals / `Array.prototype` / timers | **same id → leak** (counter grew; `pollute=1` then saw `polluted:true, arrayProtoEvil:true`). **different id → clean** (roomY never saw roomX's pollution). This is the proof that you must never reuse one isolate for distrusting code. |
| **Capability model** | child sees **only** the `env` you hand it; props are loader-only; RPC stubs unforgeable | child reported `envKeys:[]` with nothing passed, `["SECRET_TOKEN","ROOM_ID"]` only when passed. No ambient access to host bindings/secrets. |
| **Network egress** | `globalOutbound: null` blocks all `fetch()`/`connect()` | child got *"not permitted to access the internet … must use capabilities (bindings in 'env')"*. |
| **Resource abuse** | `limits: { cpuMs, subRequests }` per invocation; exceeding throws | (documented; lower of WorkerCode + per-call wins) |

For controlled egress instead of a hard block, pass a `WorkerEntrypoint` gateway
as `globalOutbound` (e.g. `ctx.exports.HttpGateway()`); every child request hits
its `fetch()` where you allowlist hosts / inject credentials by hand. (A
*separate* "Sandboxes Outbound Workers" product offers declarative
`allowedHosts`/`deniedHosts` — not the raw binding.)

---

## 4. The central tension, and the resolution

**Tension:** reuse one isolate → cheap but leaks state across executions
(unsafe). Fresh isolate per code → isolated but each is a billable unique
worker.

The brief's idea — *reuse a stable worker id while the code changes, to dodge
the per-request cost* — fails on **four** independent axes:

1. **API:** a warm isolate keeps serving the old code; the callback is skipped.
2. **Contract:** *"If anything about the content changes, you must use a new
   ID."* Same-id/different-code is unsupported & indeterminate.
3. **Billing:** *"uniquely identified by Worker ID **and** code."* Changing code
   counts as a new Dynamic Worker **anyway** — there is no cost arbitrage.
4. **Security:** we *proved* a reused isolate leaks globals/prototype/timers
   between executions. Doing it deliberately is the exact interference the brief
   wants to prevent.

**Resolution — content-addressing (`id = hash(code + config)`).** This is
Cloudflare's own recommendation: *"compute IDs based on a hash of the code and
config, so that any change results in a new ID."* It makes the id a deterministic
function of the code, which simultaneously:

- **reuses** the warm isolate for *identical* code (re-running / re-rendering the
  same artifact is free and fast — the common case),
- **isolates** *different* code into a fresh isolate (security floor),
- **bills minimally** — one unit per distinct artifact per day, the provable
  minimum while still isolating,
- **satisfies the contract** — id and code always change together.

Reproduced (`/run`, `/render-react`): 5 executions of 2 distinct code blobs →
**2** billable loads; changing *props* (runtime args) → cache hit; changing
*code* → new load. This is the "deterministic" the brief was reaching for — just
applied to the **id**, not to forcing one id to host changing code.

---

## 5. Per-room architecture

The thing you reuse "per room" should **not** be a Dynamic Worker (those are the
disposable, content-addressed sandboxes). Two layers:

```
                        ┌─────────────────────────────────────────────┐
  client (thin)  ──────►│  Host: your normal avlo Worker  (or a        │
                        │  per-room Durable Object "RoomRunner")       │
                        │  • routing, auth, room catalog               │
                        │  • serves built artifacts from KV/R2/Assets  │  ← NOT a Dynamic Worker:
                        │  • env.LOADER.get(sha(code), …) on execute   │     no per-DW fee, stays warm
                        └───────────────┬─────────────────────────────┘
                                        │  content-addressed
                          ┌─────────────▼──────────────┐
                          │ Dynamic Worker sandbox       │  globalOutbound:null
                          │ id = "sb:" + sha256(code)    │  env = only what you grant
                          │ one V8 isolate per distinct  │  limits:{cpuMs,subRequests}
                          │ code; reused for identical   │
                          └──────────────────────────────┘
```

- **Stateless executions (most React artifacts):** the host (normal Worker, or
  per-room DO for serialization) calls `env.LOADER.get("sb:"+sha256(code), …)`.
  No per-room Dynamic Worker is "kept" — the content-addressed sandbox *is* the
  reuse unit, shared across rooms when code matches.
- **Stateful per-room executor (when a room needs isolated, persistent state):**
  use **Durable Object Facets**. A per-room supervisor DO (`RoomRunner`, keyed
  by `roomId`) loads the room's code as a **facet** — a dynamically-loaded DO
  class running as a child *with its own isolated SQLite DB*:

  ```ts
  // supervisor DO
  const facet = this.ctx.facets.get("app", () => {
    const stub = this.env.LOADER.get("room:"+sha256(code), async () => ({
      compatibilityDate, mainModule: "app.js", modules: { "app.js": code }, globalOutbound: null,
    }));
    return { class: stub.getDurableObjectClass("App") };   // id omitted → inherits room DO id
  });
  return facet.fetch(request);
  ```

  Facet properties (verified): isolated SQLite per facet (dynamic code can't read
  the supervisor's DB); `ctx.facets.abort(name, reason)` tears down + invalidates
  stubs **but preserves storage** (the clean code-update path: abort old → `get`
  new class); `ctx.facets.delete(name)` wipes its DB. The DO **input gate
  serializes** execution (one at a time → no concurrent interference), and the DO
  **hibernates after ~10s idle** (no duration charge while hibernated), so a
  per-room executor is cheap when idle and re-warms on demand.

- **`ctx.exports`** (compat flag `enable_ctx_exports`) gives the host loopback
  bindings to its own entrypoints/DOs — used to mint the `globalOutbound`
  gateway and to hand capability stubs (KV/R2 partitions, a room-scoped API)
  into a child's `env` without exposing the host's real bindings.

---

## 6. Building + serving React artifacts

Dynamic Workers have **no build step** — TS/JSX/npm must be compiled to JS
strings first. Two viable build sites:

1. **Build on the worker (recommended):**
   [`@cloudflare/worker-bundler`](https://www.npmjs.com/package/@cloudflare/worker-bundler)
   `createWorker({ files, bundle, minify })` compiles TSX and resolves npm deps
   (React, etc.) at runtime into the exact `{ mainModule, modules }` shape, run
   inside the `get()` callback. The playground uses precisely this. The **build**
   needs network (npm) and runs in the host or a build-sandbox; the **execution**
   sandbox stays `globalOutbound:null`.
2. **Build on the client:** `esbuild-wasm` in a Web Worker
   (`esbuild.initialize({wasmURL})` → `transform`/`build`) — only if you ever
   want to skip the server round-trip. Heavier client; not the thin-client goal.

**Artifact lifecycle (the cost win):** content-address the build inputs →
`artifactId = sha256(files + framework + config)`. Run the sandbox once to
produce HTML (+ optional client bundle) → **store in KV/R2/Static Assets** under
the immutable hash → the host serves it forever from cache. **Re-rendering an
existing artifact costs nothing in the loader** (it's a static fetch); you only
pay a Dynamic-Worker load when a genuinely new artifact is built.

> **Prototype proof:** `src/react-build.ts` vendors real Preact +
> `preact-render-to-string` + `htm` (build-free JSX via tagged templates) as
> inlined text modules, so the sandbox SSRs with **zero network**. `POST
> /render-react` returns a real HTML artifact; identical component code →
> cache hit; changed code → new load. Production swaps the vendored bundles for
> `@cloudflare/worker-bundler` to get full React + arbitrary npm.

---

## 7. Rendering in native z-order with canvas (HTML-in-canvas)

The browser capability the brief refers to is shipping as **`drawElementImage`**
(2D), `texElementImage2D` (WebGL), `copyElementImageToTexture` (WebGPU), plus a
`layoutsubtree` attribute on `<canvas>`. (Naming history: `placeElement` →
`drawElement` → `drawElementImage`, ~Chrome 145.)

```html
<canvas layoutsubtree id="board">
  <div id="artifact"><!-- the SSR'd React artifact, a direct canvas child --></div>
</canvas>
```
```js
canvas.onpaint = () => {
  ctx.reset();
  ctx.drawElementImage(bgLayer, 0, 0);          // canvas-drawn avlo objects below
  ctx.drawImage(...);                            // strokes/shapes…
  ctx.drawElementImage(artifactEl, x, y);        // the React artifact, composited ON TOP
};
canvas.requestPaint();
// keep the real DOM node aligned for hit-testing/a11y:
artifactEl.style.transform = canvas.getElementTransform(artifactEl, drawTransform);
```

- **Z-order = call order inside `onpaint`.** Interleave `drawElementImage(...)`
  between canvas draws → DOM artifacts sit in true z-order among avlo's canvas
  objects. Exactly the brief's vision.
- It **rasterizes a snapshot** at paint time (not a live node); interactivity /
  hit-testing use the *real* element, which you position via
  `canvas.getElementTransform(...)`.

### Two important constraints (design-shaping)

1. **`drawElementImage` cannot rasterize cross-origin iframe content.** The
   strongest sandbox for untrusted **client-side** JS — a cross-origin iframe
   (`sandbox="allow-scripts"`, served from a separate `artifacts.avlo.io`,
   *without* `allow-same-origin`) — is therefore **not canvas-compositable**.
   - **For canvas-composited artifacts:** SSR to **static HTML+CSS (no client
     JS)** in the sandbox, render into a **same-origin** subtree (direct canvas
     child), draw via `drawElementImage`. Safe because the untrusted code already
     ran server-side in the isolate; the client only paints inert,
     auto-escaped markup. ← recommended default.
   - **For interactive artifacts (untrusted client JS):** run in a cross-origin
     sandboxed iframe positioned as a **DOM overlay** over the canvas (lose true
     z-interleaving), or accept a same-origin + strict-CSP sandbox (weaker).
     Never combine `allow-scripts` + `allow-same-origin` (the frame can remove
     its own sandbox and escape).
2. **Status:** Chromium-only, behind `chrome://flags/#canvas-draw-element` /
   Origin Trial (~M148–M151), **not in the WHATWG spec** as of mid-2026. Treat
   it as a forward-looking bet and ship a DOM-overlay fallback for other
   browsers.

---

## 8. What the local prototype proves

Runnable, **no deploy** (`README.md`):

| Claim | Endpoint | Result |
|---|---|---|
| Loader works in local `wrangler dev` | `/info` | `hasGet`, `hasLoad` true |
| `get(id)` caches by id; reuse leaks state | `/counter` | counter persists; pollution carries within an id, never across ids |
| `load()` always fresh | `/counter-load` | counter always 1 |
| `globalOutbound:null` blocks egress | `/egress` | blocked w/ explicit error |
| capability model | `/run` env | child sees only granted keys |
| content-addressing collapses billing | `/run` | 5 execs of 2 blobs → 2 loads |
| real React-family SSR in a network-isolated sandbox | `/render-react` | HTML artifact; props=cache hit, code=new load |

---

## 9. Recommendation

1. **Executor = content-addressed Dynamic Worker sandboxes** (`id =
   sha256(code+config)`), `globalOutbound: null`, `env` = only granted
   capabilities, `limits:{cpuMs,subRequests}`. This *is* the secure + minimal-cost
   design; it is also Cloudflare's documented pattern.
2. **"Per-room reuse" = a normal Worker or a per-room Durable Object**, not a
   Dynamic Worker. Use **DO Facets** only when a room needs isolated *persistent*
   state and serialized execution; otherwise plain content-addressed sandboxes
   are simpler and cheaper.
3. **Drop the "stable id + changing code" idea.** It's impossible, unsupported,
   non-saving, and unsafe. Content-addressing gives you the determinism you
   wanted, on the id.
4. **React:** build with `@cloudflare/worker-bundler`, content-address the build,
   **persist artifacts to KV/R2/Assets** so re-renders are free static serves.
5. **Render:** SSR static artifacts → `drawElementImage` into the canvas for
   z-order (same-origin, no client JS); interactive artifacts → cross-origin
   sandboxed-iframe overlay. Ship a fallback; the API is still experimental.
6. **Observe:** attach a Tail Worker via the `tails:[…]` array (per-child logs);
   buffer to a DO if you need them live (the playground's `LogSession` pattern).

### Open items before production
- Confirm `@cloudflare/worker-bundler` npm-resolution behavior + size under load
  (it fetches deps at runtime; cache aggressively / pin a lockfile).
- Decide the artifact store (R2 for big bundles, KV for small HTML, Static
  Assets if immutable + edge-cached) and an eviction/GC policy keyed by hash.
- Pick the interactivity tier per artifact type and build the canvas/​overlay
  fallback path.
- Re-check the (now-live) $0.002/DW/day against projected distinct-artifact
  volume; 1,000/mo free covers light usage.

---

## Sources
- Dynamic Workers docs: getting-started, api-reference, usage/{bindings,egress-control,limits,observability,durable-object-facets} — `developers.cloudflare.com/dynamic-workers/`
- Pricing: `developers.cloudflare.com/dynamic-workers/pricing/` (verified 2026-06-30)
- Open-beta changelog (2026-03-24); blog *"Sandboxing AI agents, 100x faster"* — `blog.cloudflare.com/dynamic-workers/`
- `ctx.exports`: `developers.cloudflare.com/workers/runtime-apis/context/`
- Reference impl: `github.com/cloudflare/agents/tree/main/examples/dynamic-workers{,-playground}`; `workerd` `src/workerd/api/worker-loader.h`
- HTML-in-Canvas: WICG `html-in-canvas` explainer; `chrome://flags/#canvas-draw-element` (Origin Trial M148–M151)
- All API/caching/isolation/cost claims independently reproduced locally — see `probe.sh`.
