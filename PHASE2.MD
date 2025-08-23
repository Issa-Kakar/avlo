# Avlo Phase 2 — Execution Brief for AI Agent

*(Testing, Data-Flow, rAF Publisher, Scene Semantics, ClearBoard, Budgets, Idempotency, and Exhaustive Acceptance/Test Plan)*

> **Audience:** This document is the **single source of truth** for the AI agent driving Phase 2 work on the Avlo project.
> **Goal:** Make Phase 2 *work end-to-end* with a testable, deterministic core data layer. It is acceptable to deviate from the spec **where necessary** to achieve correctness and testability, as long as we document the deviation and keep it compatible with the broader spec.
> **Scope:** Phase 2 covers the *core data layer & models* only—no canvas/UI and no network providers (WS/RTC). Local plumbing (WriteQueue/CommandBus), snapshot publishing (rAF), scene semantics, size budgets, idempotency, and a tiny **render-snapshot** IDB cache are **in scope**.&#x20;

---
**CRITICAL NEXT TASK:**
Got it — if the rAF/coalescing fix is in and the only thing left is the crude `×0.7` size estimate, here’s the concrete path I recommend and exactly how to implement it. Short answer: do a **hybrid** now — **actual gzip for the 2 MB frame cap**, plus a **rolling compression ratio (EWMA)** for the 8 MB/10 MB doc thresholds — and later (when you wire the server) snap to server-truth.

---

# What to build

## 1) Enforce the **2 MB frame cap** with **actual gzip** (precise, low overhead)

Measure the compressed size of the **exact bytes you’re about to send** (the “frame”). If it’s over 2 MB, reject/split before enqueue. This removes guesswork and prevents false negatives/positives.

* **Browser path:** use `CompressionStream('gzip')`.
* **Node/tests:** use `zlib.gzipSync` (Vitest).
* **What to gzip:** the *wire* payload (whatever you’d ship). If your Phase-2 wire is a JSON command batch, gzip the UTF-8 bytes of that JSON. If you have a Yjs update buffer already, gzip that buffer instead (even better).

### Drop-in utility (TypeScript)

```ts
// size-estimator.ts
export async function gzipSizeBrowser(input: Uint8Array | string): Promise<number> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // CompressionStream is supported on modern Chromium/Firefox/Safari
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  return compressed.byteLength;
}

// Node/Vitest fallback (tree-shake via build or conditional import)
export function gzipSizeNode(input: Uint8Array | string): number {
  const { gzipSync } = require('zlib');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return gzipSync(bytes).byteLength;
}
```

Usage in your write path:

```ts
// BEFORE enqueuing frame
const rawFrameBytes = /* Uint8Array or JSON string for the frame */;
const compressed = isBrowser ? await gzipSizeBrowser(rawFrameBytes) : gzipSizeNode(rawFrameBytes);

if (compressed > 2_000_000) {
  // reject or split (stroke simplification / delta splitting strategy)
  return { ok: false, reason: 'frame_cap' };
}
```

**Why this now?** The 2 MB limit is a hard transport cap; “0.7×” can’t be trusted. Gzipping a single frame is cheap (tens–hundreds of μs for typical sizes).

---

## 2) Predict **document compressed size** with a **rolling ratio (EWMA)**

Use a rolling compression ratio **ĉ** to estimate total *compressed* doc bytes from observed *uncompressed* growth (or from sampled real gzips of deltas), and gate **warn** (≈ 8 MB) and **read-only** (≈ 10 MB).

Why not always gzip the whole doc every write? Because it’s too expensive. Summing gzipped deltas is also wrong (gzip is stateful; the whole is smaller than parts). The best Phase-2 approximation is a **stable EWMA**:

* Maintain:

  * `docEstGzBytes` — our running estimate of the whole document’s compressed size.
  * `ratioEWMA` (ĉ) — recent `gzDelta / rawDelta` average, clamped to `[0.15, 1.0]`.
  * `alpha` (smoothing), e.g. `0.2`.

* On each accepted change:

  1. Compute `rawDeltaBytes` (bytes we’re adding to the source of truth; e.g., UTF-8 JSON length of the doc-diff you would persist, or the encoded Yjs update length if you have it).
  2. Occasionally (e.g., every N updates or when `rawDeltaBytes` is large), **sample** the actual gzip of just the delta to get `gzDeltaBytes` and update `ratioEWMA`.
  3. Estimate growth: `estGzDelta = (gzDeltaBytes ?? ratioEWMA * rawDeltaBytes)`.
  4. `docEstGzBytes = Math.max(0, docEstGzBytes + estGzDelta)`.
  5. If you perform a **ClearBoard** (semantic reset), reset `docEstGzBytes` to a small baseline (e.g., 32–64 KB) and keep `ratioEWMA` (or slightly re-bias it upward).

* Thresholds:

  * `if (docEstGzBytes >= 8_000_000)` → set `warn=true`.
  * `if (docEstGzBytes >= 10_000_000)` → **local read-only** (until shrink/clear).

### Minimal estimator (TypeScript)

```ts
// size-estimator.ts
export class RollingGzipEstimator {
  private ratioEWMA = 0.5;           // start conservative
  private readonly alpha = 0.2;      // smoothing (0..1)
  private readonly minR = 0.15;      // clamp
  private readonly maxR = 1.0;
  private _docEstGzBytes = 0;

  get docEstGzBytes() { return this._docEstGzBytes; }
  get ratio() { return this.ratioEWMA; }

  // Call when a write is accepted.
  // Pass raw delta bytes (uncompressed). Optionally pass measured gz of that delta.
  observeDelta(rawDeltaBytes: number, gzDeltaBytes?: number) {
    if (rawDeltaBytes <= 0) return;

    if (gzDeltaBytes != null) {
      const r = Math.min(this.maxR, Math.max(this.minR, gzDeltaBytes / rawDeltaBytes));
      this.ratioEWMA = this.alpha * r + (1 - this.alpha) * this.ratioEWMA;
    }

    const estGzDelta = gzDeltaBytes ?? Math.ceil(this.ratioEWMA * rawDeltaBytes);
    this._docEstGzBytes = Math.max(0, this._docEstGzBytes + estGzDelta);
  }

  // Call on semantic resets like ClearBoard
  resetBaseline(baselineGz = 64 * 1024) {
    this._docEstGzBytes = baselineGz;
    // keep ratioEWMA; optionally nudge upward a bit to be safe
    this.ratioEWMA = Math.min(this.maxR, this.ratioEWMA * 1.05);
  }
}
```

**Sampling policy:** compress the delta (to refine ĉ) when either:

* `rawDeltaBytes ≥ 16 KB`, or
* every `N = 10` accepted writes (tunable), or
* when approaching thresholds (e.g., `docEstGzBytes > 7.5 MB`).

This keeps CPU cost tiny while keeping ĉ realistic.

---

## 3) Optional (later): Snap to **server truth** when available

When you wire real persistence/acks, accept an authoritative `persist_ack.size_bytes` (gzipped doc size) and:

* `docEstGzBytes = ack.size_bytes`, and
* seed `ratioEWMA` using the last `(gzDelta/rawDelta)` sample for faster convergence.

This removes drift entirely, but it’s fine to defer until Phase 4+.

---

# Where to integrate

* **`client/src/lib/room-doc-manager.ts` (or a small `lib/size-estimator.ts` you import):**

  * Instantiate a `RollingGzipEstimator`.
  * On **each accepted write**:

    * Compute `rawDeltaBytes` (the exact bytes you add to the doc). If you already produce an encoded Yjs update, that length is best; otherwise use your JSON diff bytes.
    * If you just gzipped the **frame** to enforce the 2 MB cap and the frame is one-to-one with the doc delta, reuse that gz size as `gzDeltaBytes`. If frame includes multiple commands/batching glue, only gzip the doc-delta portion for the estimator (optional; otherwise rely on sampling).
    * Call `estimator.observeDelta(rawDeltaBytes, maybeGzipDeltaBytes)`.
    * Update `roomStats`/`meta` with `estimator.docEstGzBytes`, and gate **warn/RO**.
  * On **ClearBoard**: call `estimator.resetBaseline()`.

* **`client/src/lib/command-bus.ts`:**

  * Before enqueue/send, build the **frame** bytes and check `gzipSize…(frame) ≤ 2 MB`.
  * If over, **split or reject** with a clear error.

---

# Replace the 0.7× with this exact logic

```ts
// OLD (remove)
const est = Math.floor(rawBytes * 0.7);

// NEW
const frameGzBytes = isBrowser ? await gzipSizeBrowser(frameBytes) : gzipSizeNode(frameBytes);
if (frameGzBytes > 2_000_000) return { ok: false, reason: 'frame_cap' };

// After accepting the write:
const rawDeltaBytes = typeof deltaBytes === 'string'
  ? new TextEncoder().encode(deltaBytes).byteLength
  : deltaBytes.byteLength;

// Optionally sample gz of the delta itself (not always needed)
const maybeGzDelta = shouldSample(rawDeltaBytes) 
  ? (isBrowser ? await gzipSizeBrowser(deltaBytes) : gzipSizeNode(deltaBytes))
  : undefined;

estimator.observeDelta(rawDeltaBytes, maybeGzDelta);

// Gates
const warn = estimator.docEstGzBytes >= 8_000_000;
const readOnly = estimator.docEstGzBytes >= 10_000_000;
```

---

# Tests you should add/adjust

1. **Frame-cap precision**

   * Build synthetic frames just below/above 2 MB gz; assert hard gating (reject above, accept below).
   * Include both Node (zlib) and browser (CompressionStream via Playwright) coverage.

2. **Estimator convergence**

   * Feed a sequence of deltas with known `(raw, gz)` pairs; ensure `ratioEWMA` converges and `docEstGzBytes` tracks within ±10%.
   * Verify clamps `[0.15, 1.0]` prevent wild swings.

3. **Sampling policy**

   * With sampling every N writes, ensure estimates stay within tolerance and CPU time is bounded.

4. **Threshold behavior**

   * Drive `docEstGzBytes` to 7.9 MB → `warn=false`.
   * Push to 8.1 MB → `warn=true`.
   * Push to 10.0 MB → `readOnly=true`.

5. **ClearBoard reset**

   * After large doc, call `resetBaseline()`; assert `docEstGzBytes` falls to baseline and `ratioEWMA` persists.

---

# Performance notes

* Gzipping **one frame** is cheap; gzipping **every delta** is also usually cheap, but you can sample to guarantee overhead stays negligible under bursty input.
* Prefer **Uint8Array** inputs to avoid extra encodes.
* If you ever see UI jank, move gzip sampling into a microtask or a Web Worker (not usually necessary at these sizes).

---

# TL;DR

* **Do this now**:

  1. **Actual gzip** of each **frame** to enforce the **2 MB** cap.
  2. **Rolling compression ratio** (EWMA) to estimate **doc** compressed size for **8 MB warn / 10 MB read-only**.
* **Do this later**:
  3\) When persistence is wired, snap estimates to **server-truth**.

This fully replaces the brittle `×0.7` heuristic without adding complexity to your hot path and keeps Phase 2 behavior deterministic and testable.


## 0) Green-Light Context (What You Must Know Before You Do Anything)

1. **Phase 2 is the foundation** for everything else. Phase 3 (Canvas) depends on correct snapshot publishing & scene filtering; Phase 4 (Realtime) depends on correct WriteQueue validation & command processing; Phase 5 (Persistence) depends on size budgets & TTL. If we don’t make this rock-solid and testable, later phases crumble.&#x20;

2. **What’s already defined for Phase 2**

   * **RoomDocManager** singleton per room; **never** expose `Y.Doc` or providers to UI; only immutable **Snapshots** through hooks. Snapshots are **never null**—publish an **EmptySnapshot** at init. &#x20;
   * **Yjs document structure**: root `Y.Map` with `strokes[]`, `texts[]`, `code`, `outputs[]`, `meta.scene_ticks[]`. Numeric arrays are stored as `number[]` in Y; typed arrays built at render-time only (later phases).&#x20;
   * **Snapshot Publisher** (rAF): ≤ 60 FPS; **coalesce** Y updates per **8–16 ms**; widen to **24–32 ms** under pressure; publish ≤ 1/rAF; hidden tab ≈ 8 FPS; immediate EmptySnapshot. **Add tiny IDB render-snapshot cache** keyed by `{roomId, svKey}` for first paint. &#x20;
   * **WriteQueue + CommandBus**: Single entrypoint; one `yjs.transact(...)` per command; **idempotency**; **dual size budgets**—per-stroke update ≤ 128 KB and **transport frame** cap ≤ 2 MB; `MAX_POINTS_PER_STROKE=10 000`; text ≤ 500 chars; code ≤ 200 KB; **ClearBoard** rate-limited 1/15 s. &#x20;
   * **Scene invariants**: Scene captured at *gesture start* (pointer-down etc.) and **preserved to commit**; prevents time-travel when ClearBoard ticks a new scene concurrently. Only `scene === currentScene` is rendered. `scene_ticks[]` append-only.&#x20;

3. **Known pain points you must solve in Phase 2**

   * rAF **batching is not true batching**; current code is more like rate limiting and causes flaky tests and race conditions. We will **replace** the publisher with a deterministic **batch-timer-driven rAF** (documented below). &#x20;
   * **ClearBoard bug**: ensure `scene_ticks.push(Date.now())` (no nested arrays).&#x20;
   * **Test harness alignment**: fix bbox shape to `[minX,minY,maxX,maxY]`; include `finishedAt` for `DrawStrokeCommit`; fix `document.hidden` mocking. &#x20;

4. **Spec vs. practical testing**

   * The high-level spec says “single rAF loop per room tab” with 8–16 ms windows. For **testability**, we will **schedule rAF only when a batch window expires** rather than running a perpetual loop. This is a **controlled deviation** that still satisfies: ≤ 1 publish per rAF, coalescing windows, hidden-tab policy, and ≤ 60 FPS. (Rationale in §4.2.)&#x20;

---

## 1) Phase 2 Definition (Scope, Non-Goals, Deliverables)

### 1.1 In-Scope (Phase 2)

* Type system and validation helpers for **strokes/text/code/outputs/meta** and **commands**.&#x20;
* **RoomDocManager** foundation with immutable snapshot publishing and subscription APIs (`subscribeSnapshot`, `subscribePresence`, `subscribeRoomStats`, `destroy`). Singleton registry per room.&#x20;
* **Yjs document structure** initialization; helpers to access Y types *internally*; **never** expose Y objects. Numeric arrays must be plain `number[]`.&#x20;
* **Snapshot Publisher** with **coalescing windows (8–16 ms → 24–32 ms under pressure)**, hidden-tab ≈ 8 FPS, **immediate EmptySnapshot**, and **IDB render-snapshot cache** keyed by `svKey`.&#x20;
* **WriteQueue + CommandBus** with backpressure, idempotency keys per command, dual size budgets, and rate limiting (ClearBoard 1/15 s).&#x20;

### 1.2 Out-of-Scope (Phase 2)

* **All UI/canvas rendering**, spatial index (RBush) builds (that lands in Phase 3.3), **network providers (WS/RTC)** integration details, PWA/service-worker caching of `/yjs/**`, and anything beyond the tiny **render-snapshot** cache. &#x20;

### 1.3 Phase 2 Deliverables Checklist (must be true to move on)

* ✅ Types + guards for all models and commands
* ✅ RoomDocManager with **never-null** snapshots, subscribers, and `destroy()` cleanup
* ✅ Ydoc shape + helpers; arrays are `number[]` only
* ✅ Snapshot Publisher passes: **≤ 60 FPS**, **≤ 1 publish/rAF**, **8–16 ms coalescing window** with **24–32 ms under pressure**, **8 FPS hidden**, **immediate EmptySnapshot**, **IDB render-snapshot cache** keyed by `{roomId, svKey}` (hydrate only if current svKey matches)
* ✅ WriteQueue + CommandBus with **idempotency**, **backpressure**, **128 KB stroke budget**, **2 MB frame cap**, **MAX\_POINTS\_PER\_STROKE=10 000**, text ≤ 500 chars, code ≤ 200 KB, **ClearBoard 1/15 s**
* ✅ Deterministic **Playwright + Vitest** test packs for rAF cadence, visibility throttling, coalescing, scene capture & ClearBoard invariants, idempotency, and budgets
* ✅ ESLint “no-restricted-imports” green (UI cannot import yjs/providers)
* ✅ Minimal observability: counters for publish cadence, coalescing window, queue depth, idempotency drops, svKey churn&#x20;

---

## 2) Constraints, Invariants, and Budgets (Phase 2 authoritative list)

> These invariants are **non-negotiable** unless explicitly documented as a deviation.

1. **Ownership & Exposure Rules**

   * UI **must not** import `yjs`, `y-websocket`, `y-indexeddb`, `y-webrtc`. Only access through RoomDocManager + hooks. Snapshots are immutable view objects.&#x20;
   * Exactly **one** RoomDocManager per room and tab; **never** expose live `Y.Doc` outside. Snapshots **never null**; publish **EmptySnapshot** on init.&#x20;

2. **Timestamp Policy**

   * **Inside Y/CRDT**: `number` ms epoch (`Date.now()`).
   * **HTTP/WS JSON**: ISO-8601 UTC string.
   * **rAF/testing/intervals**: use **`performance.now()`** (monotonic) for durations and fake-time control.
     (Policy is cross-referenced by the model & transport specs.)&#x20;

3. **Publisher (rAF) Contract**

   * **≤ 60 FPS**; **≤ 1 publish/rAF**; **coalesce** updates per **8–16 ms** input window; widen to **24–32 ms** if last publish exceeded \~8 ms budget; **hidden tab** ≈ 8 FPS; **EmptySnapshot** at init. &#x20;

4. **Render-Snapshot Cache (Phase 2.4)**

   * Persist **last render snapshot** in IDB keyed by `{roomId, svKey}`; **write only when svKey changes**; on boot, **hydrate only if svKey matches**; cap size, one per room. **Never** use cached snapshot for business logic.&#x20;

5. **Write-Path & Budgets**

   * **Single write entrypoint** → queue → **one `yjs.transact` per command**.
   * **Idempotency** on all commands; **drop duplicates** before transact.
   * **Dual limits**: `DrawStrokeCommit` encoded ≤ **128 KB** (after simplification), **all** commands frame ≤ **2 MB**.
   * **Content caps**: `MAX_POINTS_PER_STROKE=10 000`; text ≤ 500 chars; code ≤ 200 KB.
   * ClearBoard client-side rate limiting **1/15 s**; server also rate-limits later. &#x20;

6. **Scene & Causality**

   * `scene = meta.scene_ticks.length` (append-only).
   * Capture `cmd.scene` at **interaction start** and **preserve** to commit; never recompute at commit time.
   * ClearBoard appends **`Date.now()`** to `scene_ticks` (single value, **no nested arrays**).
   * *Visibility isolation*: render/export objects with `scene === currentScene` only.  &#x20;

7. **Authority & Storage (Phase 2 view)**

   * Redis (TTL) is authoritative for Yjs doc; Postgres is metadata only. TTL extends **only** on accepted writes. (WS/RTC providers attach in later phases.)&#x20;

---

## 3) Data Flow (Phase 2, end-to-end narrative)

### 3.1 Initialization & First Paint

1. Construct `Y.Doc({ guid: roomId })`.
2. Initialize the Y root structures (`strokes`, `texts`, `code`, `outputs`, `meta.scene_ticks`).
3. Build **EmptySnapshot** (`scene=0`, arrays empty, identity view, `meta.readOnly=false`), publish immediately.
4. Compute svKey from state vector; **attempt IDB render-snapshot hydrate** keyed by `{roomId, svKey}`; if present, hand it to subscribers while the doc is live. **Never** use cached snapshot for any decisions. &#x20;

### 3.2 Write Path

1. UI submits a **Command** → `WriteQueue.enqueue(cmd)`; queue enforces **room status (read-only/mobile)**, size budgets, and **idempotency**.
2. `CommandBus.execute(cmd)` wraps the **single** `yjs.transact(...)` applying changes to the Y document.
3. Y changes trigger the **publisher**; changes inside the **coalescing window** are batched into **one** snapshot publish on the next scheduled rAF.
4. After publish, update the **IDB render-snapshot cache** only if **svKey changed**. &#x20;

### 3.3 Scene Semantics & ClearBoard

* `ClearBoard` appends a **single** timestamp to `meta.scene_ticks` → this increments `currentScene`.
* A stroke started **before** a ClearBoard **must** commit in its captured scene (causal consistency).
* Scene is *never* re-sampled at commit time; commands carry the captured scene.
* Exports and rendering filter strictly by current scene (later phases will add the renderer).&#x20;

---

## 4) The rAF Publisher: Best-Path Design for Determinism & Testability

### 4.1 Why We’re Changing It

* The existing loop **runs continuously** and may publish before the **batch window** has elapsed, causing race conditions and breaking the “coalesce 8–16 ms” requirement under test clocks. We need **true batching**, not just rate limiting.&#x20;

### 4.2 The Proposed Model (Controlled Deviation, Spec-Compatible)

* **Replace** the perpetual rAF loop with a **batch-timer-driven, one-shot rAF**:

  * On first Y update, mark `pendingPublish=true` and **start a batch timer** for **`batchWindow ∈ [8,16] ms`** (controlled by pressure heuristics).
  * **When the timer fires**, schedule **exactly one `requestAnimationFrame`** to **publish once**.
  * Any extra Y updates during the timer window get **coalesced** into that one publish.
  * Under pressure (publish work > \~8 ms), **expand** `batchWindow` dynamically to **24–32 ms** until stable.
  * If the tab becomes visible and `pendingPublish=true`, we **schedule immediate publish** without waiting (keeps “hidden→visible” transition snappy).
* This design **meets**: **≤ 1 publish/rAF**, **8–16 ms coalescing** (24–32 under pressure), **≤ 60 FPS**, **\~8 FPS hidden**. It’s easier to **unit test** with fake timers and `page.clock`. &#x20;

> **Code-shape (illustrative; keep citations outside the fence):**

```ts
// Pseudocode — one-shot rAF publisher
class Publisher {
  publishState = { pending: false, batchTimer: 0 as any, batchWindow: 16 };

  onYUpdate() {
    this.publishState.pending = true;
    if (!this.publishState.batchTimer) {
      this.publishState.batchTimer = setTimeout(() => {
        this.publishState.batchTimer = 0;
        requestAnimationFrame(() => {
          if (!this.publishState.pending) return;
          this.publishOnce();               // builds immutable snapshot; ≤1/rAF
          this.publishState.pending = false;
          // adapt window based on last publish cost (8→24–32ms under pressure)
        });
      }, this.publishState.batchWindow);
    }
  }

  onVisibilityChange() {
    if (document.hidden) return;       // hidden → run throttled elsewhere
    if (this.publishState.pending) {
      // schedule immediate publish (no wait)
      this.publishState.batchWindow = 0;
      this.onYUpdate();
    }
  }
}
```



* **Hidden tab policy**: replace rAF-driven cadence with a **`setTimeout(1000/8)`** gate (≈ 8 FPS) or only schedule when `pending=true`. For deterministic tests, mock `document.hidden` safely (see §7.3). &#x20;

---

## 5) Command Set, Idempotency Keys, and Validation

### 5.1 Command Definitions (Phase 2 surface)

```ts
type Command =
  | { type: 'DrawStrokeCommit'; id: StrokeId; tool:'pen'|'highlighter'; color:string; size:number; opacity:number; points:number[]; bbox:[number,number,number,number]; startedAt:number; finishedAt:number; scene: SceneIdx }
  | { type: 'EraseObjects'; ids: (StrokeId|TextId)[] }
  | { type: 'AddText'; id: TextId; x:number; y:number; w:number; h:number; content:string; color:string; size:number; scene: SceneIdx }
  | { type: 'ClearBoard' }
  | { type: 'ExtendTTL' }
  | { type: 'CodeUpdate'; lang:'javascript'|'python'; body:string; version:number }
  | { type: 'CodeRun' };
```

* **Idempotency keys**

  * `DrawStrokeCommit`/`AddText`: key = `id`
  * `ClearBoard`: key = `sceneIdxBefore + ':' + floor(Date.now()/300)` (prevents duplicate clear within debounce window; server still rate-limits).
  * `ExtendTTL`: client-side cooldown ≥ 10 min.&#x20;

### 5.2 Validation & Budgets (WriteQueue.validate)

* **Room checks**: reject writes when room is read-only (≥ 10 MB) or device is mobile (view-only).
* **Per-command budgets**:

  * Stroke encoded update ≤ **128 KB** (Douglas–Peucker + one retry with `tol*1.4`, else uniform downsample).
  * Any command encoded ≤ **2 MB** (WS frame cap).
  * Text ≤ 500 chars; Code ≤ 200 KB; `MAX_POINTS_PER_STROKE=10 000`.
* **Backpressure**: queue ≤ 100 pending; widen coalescing under pressure and drop superseded deltas. **All commands run in a single `yjs.transact(...)`.** &#x20;

### 5.3 Error Recovery

* **Never** let one failed command jam the queue. Wrap `transact` in try/catch and continue; log error. (Unit test included.)&#x20;

---

## 6) Scene Semantics, ClearBoard, and Rapid Scene Changes

### 6.1 Core Rules

* `currentScene = meta.scene_ticks.length` (append-only).
* `ClearBoard` **pushes a plain number timestamp**; **no arrays**: `scene_ticks.push(Date.now())`.
* **Causal consistency**: A command captures `scene` at interaction start and **must commit in that same scene**, even if new ticks have been added in the meantime.
* **No time travel**: `cmd.scene <= currentScene` must always hold.
* **Visibility**: Only `scene === currentScene` content participates in snapshot views.  &#x20;

### 6.2 Rapid Scene-Change Testing Matrix (Phase 2)

* **T1**: A draws in Scene 0, B clears to Scene 1 before A pointer-up → A’s commit lands in **Scene 0**.
* **T2**: B clears twice rapidly (Scene 0→1→2) while A is typing text started in Scene 0 → text **commits to Scene 0**.
* **T3**: Multi-touch/pointer scenarios maintain `cmd.scene` captured at start; idempotency prevents replays into wrong scenes.
* **T4**: Ensure `scene_ticks` is strictly append-only and monotonic. (Guard via dev-only invariant checks.)&#x20;

---

## 7) Testing Strategy (Deterministic & Exhaustive)

> We run **Vitest** for unit/contract tests and **Playwright** for E2E/timing correctness. We must tame rAF and clocks to make tests precise and non-flaky.

### 7.1 Global Test Bed Principles

* Use **fake timers** for **`setTimeout`** and **`Date.now()`** paths.
* Use **shimmed rAF** that can be driven by tests (hook `requestAnimationFrame` into a controlled micro-scheduler).
* Use **`performance.now()`** for durations within the publisher; in tests, we control it via the same shim (safe because `performance.now()` is monotonic and independent of `Date.now()`).
* ESLint rule “no-restricted-imports” is enforced during test runs, too (it must fail if UI imports Yjs/providers).&#x20;

### 7.2 Vitest (Unit) — rAF Publisher Determinism

* **Goal**: Prove **one** publish per rAF; **coalescing windows** of **8–16 ms** (and **24–32 ms** under pressure); **hidden-tab** throttling to ≈ 8 FPS; **EmptySnapshot** on init; **IDB cache** read/write policy.
* **Approach**:

  1. **Replace rAF** with a controlled queue. Expose `advanceRafFrame()` helper in tests to flush exactly one frame.
  2. **Drive batch windows** by advancing fake timers: advance **9 ms** with multiple Y updates → verify **one** scheduled rAF → after `advanceRafFrame()` only **one** publish.
  3. **Hidden tab**: stub `document.hidden=true` *via* `vi.stubGlobal('document', { ...document, hidden: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })`. Publish must throttle to **8 FPS**.&#x20;
  4. **Pressure mode**: simulate heavy publish cost (inject a fake 9–12 ms cost) → expect batch window to **expand** into 24–32 ms and verify via timed updates.
  5. **IDB render-snapshot cache**: test **hydrate on matching svKey** and **skip on mismatch**; **write only when svKey changes**.&#x20;

**Named Unit Tests:**

* `publisher/empty-snapshot-immediate.test.ts` — initial publish on construction (once)
* `publisher/one-publish-per-raf.test.ts` — multiple Y updates within 8–16 ms → single publish
* `publisher/hidden-tab-throttle.test.ts` — document.hidden → \~8 FPS cadence
* `publisher/pressure-widens-window.test.ts` — work > 8 ms → 24–32 ms windows
* `publisher/idb-hydrate-and-write-policy.test.ts` — svKey-matching hydrate; write-on-svKey-change only

### 7.3 Playwright (E2E) — Cross-Layer Timing

* **Goal**: Prove that the system exhibits correct macro behavior with a browser environment.
* **Clock Control**: Use `page.clock` to **step timers**; for rAF, we rely on our controlled shim or schedule one shot rAFs; when `document.hidden` is needed, we inject a **stubbed `document`** at `addInitScript` time (cannot redefine in jsdom directly otherwise).&#x20;
* **Scenarios**:

  * **E2E-1**: Burst of 5 writes within 10 ms → **exactly one** publish on next rAF.
  * **E2E-2**: Hidden tab for 1 s → expect ≤ 8 publishes (ideally \~8).
  * **E2E-3**: Simulate heavy publish → confirm widened coalescing window.
  * **E2E-4**: Scene concurrency: A starts draw in Scene 0; B triggers ClearBoard to Scene 1; A commits → stroke is in Scene 0.
  * **E2E-5**: IDB render-snapshot hydrate path on reload (svKey equal) vs. skip path (svKey mismatch).

**Named E2E Tests:**

* `e2e/raf-coalescing.spec.ts`
* `e2e/visibility-throttle.spec.ts`
* `e2e/scene-causality.spec.ts`
* `e2e/idb-render-snapshot-cache.spec.ts`

---

## 8) Test Data & Harness Corrections

* **`DrawStrokeCommit` shape**: include `bbox: [x1,y1,x2,y2]` (flat tuple), `startedAt`, `finishedAt`, `scene`. Fix any harness that uses `{min,max}` objects; add missing `finishedAt`.&#x20;
* **Scene tick**: **no nested arrays**; correct to `sceneTicks.push(Date.now())`.&#x20;
* **Error recovery**: don’t stop the queue on a failed command; catch and continue (log).&#x20;

---

## 9) What Exactly Must Work in Phase 2 (Functional Contract)

1. **Snapshot Publisher**

   * Publishes ≤ 1 per rAF; coalesces updates within **8–16 ms**, **24–32 ms** under pressure; publishes immediate **EmptySnapshot**; throttles hidden tab to **\~8 FPS**; IDB cache hydrate/write policy enforced.&#x20;

2. **WriteQueue + CommandBus**

   * Queue ≤ 100 pending; idempotency keys drop duplicates; command budgets enforced (128 KB stroke, 2 MB frame, 10 k points, text 500, code 200 KB); `ClearBoard` rate limited (1/15 s). One `yjs.transact` per command.&#x20;

3. **Scene semantics**

   * Capture scene at interaction start; commit in captured scene; ClearBoard appends timestamp; snapshot filters by current scene.&#x20;

4. **Exposure rules**

   * UI cannot import Yjs/providers; snapshots are immutable; arrays are frozen (dev) and must be `number[]` in Y (typed arrays only at render time in later phases).&#x20;

5. **Render-snapshot cache**

   * Keyed by `{roomId, svKey}`; hydrate on match; write on svKey change; cache not authoritative.&#x20;

---

## 10) Extremely Detailed Testing Guide

### 10.1 Unit Tests — Publisher Timing

**A. Immediate EmptySnapshot**

* Construct RoomDocManager → assert one publish with an EmptySnapshot (`scene=0`, empty arrays), frozen arrays in dev. (Check `Object.isFrozen` on arrays.)&#x20;

**B. Coalescing Window (8–16 ms)**

* Trigger three Y updates spaced at 2 ms; advance timers by 10 ms; expect **one** scheduled rAF and **one** publish after `advanceRafFrame()`.

**C. Pressure Widening (24–32 ms)**

* Inject a fake load (simulate `publishOnce` cost of 10 ms); ensure **next** window increases to 24–32 ms; assert only one publish across that expanded window.&#x20;

**D. Hidden Tab Throttle**

* Stub `document.hidden=true`; generate many updates for 1 s of fake time; expect publish count ≈ 8 (8 FPS). Unhide → if `pending=true`, immediate publish.&#x20;

**E. IDB Cache Policy**

* On svKey match, return the cached snapshot once; on mismatch, return null; write only on svKey change. (Ensure cache not used for any state decisions.)&#x20;

### 10.2 Unit Tests — Commands & Validation

**F. Idempotency Drops**

* Enqueue duplicate `DrawStrokeCommit` with same `id` within a short window → queue drops second before transact.

**G. Budgets**

* Stroke > 128 KB encoded diff → rejected (after one tolerance bump).
* Any command > 2 MB → rejected.
* Text > 500 chars → rejected; Code > 200 KB → rejected.
* Points > 10 k → rejected.&#x20;

**H. Room Read-Only & Mobile Gate**

* Mock `docStats.bytes≥10MB` → WriteQueue returns `read_only` error.
* Mock `isMobile=true` → WriteQueue returns `view_only`. (Banner responsibility is a later-phase UI concern, but validation exists now.)&#x20;

**I. Error Recovery**

* Throw inside a `CommandBus.execute()` test double; ensure queue processes subsequent commands.&#x20;

### 10.3 Unit Tests — Scene Semantics

**J. Captured Scene Prevails**

* Start draw (scene 0); enqueue `ClearBoard` → scene becomes 1; finish draw → commit must land with `scene=0`.

**K. No Nested Ticks**

* Ensure `scene_ticks` values are numbers; fail if arrays detected. (Regression guard.)&#x20;

**L. Monotonicity**

* Assert `scene_ticks.length` only increases; add a dev-only invariant test.

### 10.4 E2E Tests — With Playwright

**M. Coalesced Burst**

* Post 5 logical updates over 10 ms; step to end of window; expect exactly one publish on rAF.

**N. Hidden→Visible Transition**

* Keep `hidden=true` and generate updates; switch to visible → verify immediate publish if `pending=true`.

**O. Scene Race**

* A (tab 1) draws in scene N; B (tab 2) triggers `ClearBoard`; A finishes → commit in scene N (not N+1). This validates cross-client causality invariants early, even before WS/RTC in Phase 4. (Use two managers in same test process.)

**P. IDB Hydrate Flow**

* Publish a snapshot; reload; ensure hydrate path triggers only when svKey **matches**; else skip.

---

## 11) Tooling, Mocks, and Clock Control

1. **`performance.now()` vs `Date.now()`**

   * Use `performance.now()` for intervals/coalescing/raf budgets; mock via a shared monotonic clock in tests.
   * Use `Date.now()` for **doc timestamps** (`createdAt`, `scene_ticks`). Test by freezing and stepping Date independently. (This keeps “what time is it?” separate from “how long did that take?” per policy.)&#x20;

2. **rAF Shim**

   * Replace global `requestAnimationFrame` with a queue collecting callbacks; expose `advanceRafFrame()` to flush one frame. Provide helpers to count **scheduled frames** vs **publishes**.

3. **Visibility API**

   * For jsdom: use `vi.stubGlobal('document', { ...document, hidden, addEventListener: vi.fn(), removeEventListener: vi.fn() })`. Never try to reconfigure the real hidden property.&#x20;

4. **IDB**

   * Provide a tiny test adapter mimicking the put/get by `{roomId, svKey}` with versioning, so we can assert **write-on-svKey-change** and **hydrate-on-match**.

---

## 12) Agent Tasks (Do-This-Now Plan)

### 12.1 Replace Publisher with True Batching

* Implement the **batch-timer-driven, one-shot rAF** publisher described in §4.2.
* Heuristics: start at **16 ms** batch window; if last publish cost > 8 ms, widen to **24–32 ms** until two successive frames cost ≤ 8 ms; clamp ≤ 32 ms. (Back off again if costs drop.)&#x20;
* Implement **hidden tab** throttling (≈ 8 FPS) and “visible kick” (immediate publish if pending).&#x20;

### 12.2 Fix ClearBoard & Scene Mechanics

* Ensure `scene_ticks.push(Date.now())`.
* Validate `cmd.scene` is preserved; never read `currentScene` at commit; reject **future** scenes (`cmd.scene > currentScene`).&#x20;

### 12.3 Harden WriteQueue & CommandBus

* Enforce **dual budgets**; implement **idempotency** map; cap queue to **100**; drop superseded deltas under pressure; ensure **one transact per command**.
* Add **try/catch** around transact to keep queue draining. &#x20;

### 12.4 Instrumentation (dev-only)

* Counters: `publishes_per_frame`, `coalesce_window_ms`, `queue_depth`, `svKey_churn`, `idempotency_drops`. (Use to debug flakiness.)&#x20;

### 12.5 Test Packs

* Implement the unit and E2E suites named in §10; wire them into CI; fail the build if ESLint “no-restricted-imports” finds Yjs imports in UI.&#x20;

---

## 13) Acceptance Criteria (Go/No-Go Gate)

A release candidate for Phase 2 **must** demonstrate the following in CI:

* **Publisher**

  * One publish per rAF across bursts; coalescing 8–16 ms (and 24–32 under pressure); \~8 FPS hidden; EmptySnapshot at init; IDB hydrate/write policy correct.&#x20;
* **Scene Invariants**

  * Commands commit to their captured scene; ClearBoard increases scene; `scene_ticks` numeric (not array); monotonic scenes.&#x20;
* **Write Path**

  * Idempotency dropping duplicates; budgets enforced (128 KB stroke, 2 MB frame, 10 k points, text 500, code 200 KB); queue drains on errors.&#x20;
* **Exposure Rules & Lints**

  * No Yjs/provider imports in UI; snapshots are immutable/frozen in dev.&#x20;

---

## 14) Risk Register & Mitigations

* **Risk: rAF timing flakiness on CI browsers.**
  *Mitigation*: Controlled rAF shim + fake timers; test only the **contract** (counts and windows), not wall-clock.

* **Risk: Over-batching increases latency.**
  *Mitigation*: Dynamic windows with upper bound 32 ms; publish when tab becomes visible immediately; counters to observe.&#x20;

* **Risk: Spec deviation (no perpetual loop).**
  *Mitigation*: We still satisfy the observable contract; the deviation is local to publisher internals and improves determinism. We document it here and can restore a single perpetual rAF later if needed with the same external behavior.&#x20;

---

## 15) FAQ for the Agent

**Q: Why not keep a perpetual rAF loop as the spec hints?**
**A:** Because in tests, perpetual loops tend to race the batch timeout, violating true batching. Our one-shot rAF is *behavior-compatible* (≤1 publish/rAF, coalescing windows, FPS caps) and much more deterministic under `page.clock`.&#x20;

**Q: Which clock should I mock?**
**A:** Mock **`performance.now()`** for durations and rAF windows; mock **`Date.now()`** for CRDT timestamps and scene ticks. Keep them decoupled per policy.&#x20;

**Q: How do I test the hidden-tab behavior safely?**
**A:** Stub a custom `document` with `hidden: true` using `vi.stubGlobal` (do not redefine native property descriptors directly).&#x20;

---

## 16) Exhaustive Engineering Checklist (Tick Every Box)

### 16.1 Types & Guards

* [ ] `Stroke`, `TextBlock`, `CodeCell`, `Output`, `Meta` types complete
* [ ] `Command` union complete & exported
* [ ] Validation guards for all size/content limits
* [ ] Awareness payload shape (ephemeral) defined

### 16.2 RoomDocManager

* [ ] Singleton registry per `roomId`
* [ ] Internal Y accessors only; no Y references leaked
* [ ] `subscribeSnapshot`, `subscribePresence`, `subscribeRoomStats`, `destroy`
* [ ] `currentSnapshot` **never null**; EmptySnapshot published at init

### 16.3 Y Document Shape

* [ ] Root `Y.Map` with `strokes`, `texts`, `code`, `outputs`, `meta.scene_ticks`
* [ ] Numeric arrays stored as `number[]`
* [ ] Helpers return Y types internally only

### 16.4 Snapshot Publisher

* [ ] Batch timer (8–16 ms) with dynamic widen to 24–32 ms
* [ ] Schedule **one** rAF publish at the end of the window
* [ ] Dirty tracking to avoid redundant publishes
* [ ] Hidden tab throttled to ≈ 8 FPS
* [ ] Immediate EmptySnapshot
* [ ] IDB render-snapshot cache `{roomId, svKey}`, **hydrate on match**, **write on svKey change**
* [ ] Publish builds frozen immutable snapshot; `svKey` derived from state vector

### 16.5 WriteQueue & CommandBus

* [ ] One `yjs.transact(...)` per command
* [ ] Idempotency keys implemented (drops duplicates)
* [ ] Dual budgets enforced (128 KB stroke; 2 MB frame)
* [ ] Content limits enforced (10 k points; text 500; code 200 KB)
* [ ] Queue cap 100; drop superseded under pressure
* [ ] `ClearBoard` rate limit 1/15 s
* [ ] Error recovery: transact try/catch; queue continues

### 16.6 Scene Semantics

* [ ] `scene_ticks.push(Date.now())` (number; no arrays)
* [ ] Capture `cmd.scene` at interaction start; preserve to commit
* [ ] Reject future scenes
* [ ] Snapshot filters `scene === currentScene`

### 16.7 Testing

* [ ] Unit tests for all publisher behaviors (EmptySnapshot, coalesce, pressure widen, hidden tab, IDB policy)
* [ ] Unit tests for idempotency and budgets
* [ ] Unit tests for ClearBoard, scene capture, monotonic ticks
* [ ] E2E Playwright tests for coalescing, visibility, scene race, IDB hydrate
* [ ] ESLint rule enforced in CI (UI cannot import Yjs/providers)

### 16.8 Observability

* [ ] Counters: publish cadence, coalescing window, queue depth, svKey churn, idempotency drops
* [ ] Developer logs toggled via env flag

---

## 17) Deliverable: Readme Snippet to Include (for Humans)

> Avlo **Phase 2** establishes the core data layer: a Yjs-backed RoomDocManager that publishes immutable Snapshots on a deterministic cadence, a tiny render-snapshot cache for fast first paint, and a validated WriteQueue/CommandBus with idempotency and strict size budgets. Scene semantics are causality-safe (no time travel). The system is exhaustively tested with a deterministic rAF publisher and robust clock/visibility mocks to make timing behavior provable in CI. (UI/canvas and providers come in later phases.) &#x20;

---

## 18) Appendix — Snapshot Contract (Phase 2 view)

```ts
interface Snapshot {
  svKey: string;                 // base64 of state vector
  scene: SceneIdx;
  strokes: ReadonlyArray<StrokeView>; // filter: only scene === currentScene
  texts: ReadonlyArray<TextView>;     // ditto
  presence: PresenceView;             // derived + smoothed (ephemeral)
  spatialIndex: null;                 // Phase 2.4: null; Phase 3.3 populates RBush
  view: ViewTransform;                // identity or current view; immutable
  meta: { bytes?: number; cap: number; readOnly: boolean; expiresAt?: number };
  createdAt: number;                  // ms epoch when snapshot frozen
}
```

* Typed arrays are **render-time only** (Phase 3); Snapshot arrays are frozen in dev.
* Never publish `null` snapshot; `EmptySnapshot` exists from construction.&#x20;

---

## 19) Appendix — Micro-Batching & Pressure Rules (Source Trace)

* Coalesce Y updates **8–16 ms**, expandable to **24–32 ms** under pressure; cap to **≤ 60 FPS**; hidden tab ≈ **8 FPS**. (We implement via batch-timer-driven rAF.)&#x20;
* Flush at micro-batch windows; never more than one publish per rAF.&#x20;

---

## 20) Final Agent Instructions (Do Not Skip)

1. Implement the **true batching publisher** and wire all **unit/E2E tests**.
2. Fix **ClearBoard** and **scene semantics**; add explicit tests for rapid scene changes.
3. Wire **WriteQueue/CommandBus** with all **budgets**, **idempotency**, and **error recovery**.
4. Enforce **exposure rules** via ESLint and red-bar in CI.
5. Deliver **metrics counters** to debug cadence and batching in CI.
6. Produce a **short report** (for humans) summarizing which tests prove which contractual behaviors.

> When all checkboxes in §16 are ticked and all tests in §10 pass in CI, **Phase 2 is done** and we can proceed to **Phase 3 (Canvas)** confidently.&#x20;

---

The ClearBoard “push” call is not a bug in Yjs terms: Y.Array.push(items) takes an array of items to insert. To insert one number, you call push([timestamp]). That preserves the logical number[] you want for scene_ticks. Keep it — but add a test that proves the stored element is a number and that currentScene === scene_ticks.length. 

1) Issue-by-issue analysis (mapped to spec/plan)
1) RAF publishing logic conflict — Spec/plan violation; must fix

What the plan/spec require
Phase-2 explicitly moves you to a batch-timer–driven, one-shot requestAnimationFrame publisher: you coalesce Y updates for 8–16 ms, schedule one rAF, publish once in that rAF, and widen to 24–32 ms only under pressure. Also cap to ≤ 60 FPS and throttle hidden tabs to ≈ 8 FPS. 
 
 

Why your current dual path is wrong
Having a batch timer that also publishes and a rAF loop that also publishes creates two competing schedulers and breaks the “≤ 1 publish per rAF” guarantee and the determinism the plan calls out. The plan calls this out as a known pain point to fix. 

What to change (code-shape)

In the Y observer (handleYDocUpdate):

Mark dirty and record lastYUpdateAt.

(Re)arm a single batch timer if none is active.

Do not publish here.

When the batch timer fires: schedule exactly one rAF.

In the rAF callback: publish once if dirty and (a) now - lastYUpdateAt ≥ batchWindow, (b) now - lastPublishAt ≥ minFrameInterval, where minFrameInterval is 16.67 ms visible and 125 ms hidden (≈ 8 Hz). Then adapt the batch window here (and only here). 
 

This is exactly the plan’s “one-shot rAF” design. 

2) ClearBoard scene increment — Yjs API nuance; keep push([ts]) and prove types

What the spec/plan require

meta.scene_ticks is append-only numeric array; current scene is scene_ticks.length; ClearBoard appends a single timestamp; rendering/exports filter to scene === currentScene. 
 

How to write it with Yjs

Y.Array<number>.push([timestamp]) is the correct call (Yjs wants an array of items to insert). That writes one number element. Keep this.

Add a guard test: after ClearBoard, typeof ySceneTicks.get(ySceneTicks.length - 1) === 'number'. Then assert getCurrentScene() === ySceneTicks.length. 

Also re-assert scene causality

Commands carry cmd.scene captured at interaction start and never re-sample currentScene at commit. Your plan already states this; keep tests for “A draws in Scene 0 while B clears to Scene 1 — A’s commit stays in Scene 0.” 
 

3) Scene consistency (getCurrentScene = scene_ticks.length) — Correct

That matches the spec and the acceptance criteria. Keep. 

4) Scene filtering (strokes/texts by scene === currentScene) — Correct

This is baked into the snapshot contract: render/export must filter by current scene. Keep. 
 

5) Batch-window adaptation split — Spec deviation; consolidate

Spec/plan

Start with 8–16 ms windows; widen to 24–32 ms only under pressure (e.g., publish work > ~8 ms). The adaptation logic should live in one place so the behavior is predictable and testable. 
 

Action
Delete any batch-window adjustment in the timer callback; adapt only after you actually published (you then have a measured publishCostMs). This matches §4.2’s design and the test plan. 

2) Implementation sketch (deterministic, testable)
// room-doc-manager.ts (publisher core; illustrative)
type PublishState = {
  dirty: boolean
  lastYUpdateAt: number
  lastPublishAt: number
  batchTimer: number | null
  batchWindowMs: number // start 16; clamp [8,32]
}

const MIN_FRAME_INTERVAL_VISIBLE = 16.67
const MIN_FRAME_INTERVAL_HIDDEN = 125

function onYUpdate(ps: PublishState) {
  ps.dirty = true
  ps.lastYUpdateAt = performance.now()
  if (ps.batchTimer == null) {
    ps.batchTimer = (setTimeout(() => {
      ps.batchTimer = null
      requestAnimationFrame(() => maybePublish(ps))
    }, ps.batchWindowMs) as unknown) as number
  }
}

function maybePublish(ps: PublishState) {
  const now = performance.now()
  if (!ps.dirty) return
  const minFrame = document.hidden ? MIN_FRAME_INTERVAL_HIDDEN : MIN_FRAME_INTERVAL_VISIBLE
  if ((now - ps.lastYUpdateAt) < ps.batchWindowMs) return
  if ((now - ps.lastPublishAt) < minFrame) return

  const t0 = performance.now()
  publishOnceImmutableSnapshot() // builds view; ≤1/rAF
  ps.lastPublishAt = performance.now()
  ps.dirty = false

  const cost = ps.lastPublishAt - t0
  adaptBatchWindow(ps, cost)      // single place to adapt
}

function adaptBatchWindow(ps: PublishState, costMs: number) {
  // Start 16ms. If cost >8ms → widen toward 24–32ms, else shrink toward 8–16ms.
  if (costMs > 8) ps.batchWindowMs = Math.min(32, Math.max(24, ps.batchWindowMs + 4))
  else            ps.batchWindowMs = Math.max(8, Math.min(16, ps.batchWindowMs - 2))
}


“isTestEnvironment” factoring (non-spec hygiene)

This isn’t in the spec, but it’s a good refactor: create one derived flag (e.g., env.isTest) from a single source (DI’d config or a feature flag), and do not scatter environment checks around timing code. That keeps the publisher deterministic and keeps your tests relying on the rAF/timer shims instead of environment branching. (No spec citation: this is purely an implementation clean-up.)

6) Paste-ready amendments for PHASE2_FIX_PLAN.MD
Amendment A — Single rAF Publisher Path (No Dual Mechanisms)

We remove any “publish-now” behavior from Y observers/batch timers. Observers only set dirty and (re)arm a single batch timer. When that timer fires, we schedule exactly one rAF and publish once in that rAF if:
dirty && (now - lastYUpdateAt ≥ batchWindow) && (now - lastPublishAt ≥ minFrameInterval) where minFrameInterval = 16.67 ms (visible) or 125 ms (hidden). This maintains ≤ 1 publish per rAF, ≤ 60 FPS, 8–16 ms coalescing (widening 24–32 ms under pressure), and hidden-tab ≈ 8 FPS. 
 

Amendment B — Single-Place Batch-Window Adaptation

We adapt batchWindow only after a publish, using measured publishCostMs to widen into 24–32 ms when cost > ~8 ms and shrink back into 8–16 ms when recovered. Delete any other adjusters. 

Amendment C — ClearBoard Semantics (Yjs-accurate)

meta.scene_ticks is logically number[]. With Yjs, append one number via ySceneTicks.push([Date.now()]). Add tests that the stored element is a number and that currentScene === scene_ticks.length. Rendering/exports filter to scene === currentScene. 
 

Amendment D — Hidden-Tab Policy

Under document.hidden, throttle to ≈ 8 FPS (either via minFrameInterval=125 ms or a setTimeout(1000/8) gate). Provide deterministic stubs in tests. 

Amendment E — Metrics & Probes

Emit publishes_per_frame, coalesce_window_ms, svKey_churn, queue_depth. Use them to verify cadence and coalescing in CI. 

7) Side-effects & mitigations

Latency on tiny bursts: moving all publish to the one-shot rAF can add up to one frame of latency vs. “timer-direct publish.” This is explicitly accepted by the plan in favor of determinism and testability; we preserve immediate EmptySnapshot at init. 

Hidden→visible transition: include the plan’s “visible kick” (if pending when tab becomes visible, set batch window to 0 and schedule immediately) to keep the UI snappy. 

Backpressure behavior: widening to 24–32 ms under pressure is intentional; the tests prove this path rather than treating it as a regression.

Single rAF publish path; no timer-direct publish. This matches the plan’s “one-shot rAF” model and acceptance bullets: ≤1 publish/rAF, coalesce 8–16 ms (24–32 ms under pressure), hidden-tab ≈ 8 FPS. 
Hidden tab note. If you prefer even stricter throttling, replace the rAF scheduling when document.hidden with a setTimeout(1000/8) gate as your plan suggests (keep it in the same central place so tests can stub it deterministically). 
ClearBoard call. Use ySceneTicks.push([Date.now()]) (Yjs API) and assert that the materialized JS array is number[]. On snapshot build, compute currentScene = scene_ticks.length and filter views to scene === currentScene. 
3) Tests to add (names/behaviors come from your plan)
Unit (Vitest) — rAF Publisher Determinism
Replace rAF with a shim; expose advanceRafFrame(); drive timers by 9 ms chunks; verify one scheduled rAF and one publish for multiple Y updates within 8–16 ms. 
Hidden tab throttle: stub document.hidden = true via vi.stubGlobal(...) and verify cadence ≈ 8 FPS. 
Pressure mode: inject 9–12 ms synthetic publish cost and verify batch window expands into 24–32 ms. 
IDB cache policy: hydrate only when svKey matches; write only when svKey changes. 
E2E (Playwright)
Burst of 5 writes within 10 ms → exactly one publish next rAF.
1 s hidden tab → ≤ 8 publishes.
Scene concurrency: A draws in Scene 0; B clears to Scene 1; A’s commit stays in Scene 0. 
Scene/Command tests
scene_ticks monotonic/append-only; currentScene === scene_ticks.length.
cmd.scene captured at gesture start is preserved; commits never re-sample current scene. 
(Your plan already lists names for these tests; reuse them for CI.)

---

*(End of Phase 2 Agent Brief)*
