# Presence Cursor Interpolation — Implementation Guide (Phase 7 Update)

> **Goal:** Make remote cursors feel smooth and responsive by doing **receiver-side interpolation and one-frame dead-reckoning** inside **`RoomDocManager`** (owner of awareness), with **minimal renderer changes**. This replaces the old `interpolation.md`. The renderer remains a passive consumer of the _smoothed_ positions that the manager publishes via `Snapshot.presence`.&#x20;

---

## 0) Executive Summary

- **Where the logic lives:** Almost entirely in **`RoomDocManager`** (receiver smoothing), not in the render loop. The renderer (`presence-cursors.ts`) just draws whatever is in `snapshot.presence`.&#x20;
- **How it works:** On every awareness change, the manager **ingests new remote cursor samples** (world coords), tracks **last + previous** samples and velocity, and during publish **computes an interpolated “display” point** per peer:
  - **Lerp for \~1–2 frames** toward the newest sample.
  - If a tick is missing, **dead-reckon once** using the last velocity (≤ 1 frame).
  - Quantize to **0.5 world units** for stability (matches sender quantization).&#x20;

- **When we publish:** We already publish a snapshot when **doc-dirty** or **presence-dirty**. We’ll add a tiny “presence animation window” that keeps presence marked dirty for a few RAFs after a new sample so the interpolation actually animates.&#x20;
- **Gating unchanged:** Cursors render only when **`G_AWARENESS_READY && G_FIRST_SNAPSHOT`**. On disconnect, cursors hide immediately and trails are cleared.&#x20;

---

## 1) Current Architecture (what’s already there)

- The manager owns **Y.Doc**, **y-websocket**, **awareness**, gates, and the **RAF publisher**. Presence is derived in the manager and injected into every snapshot.&#x20;
- Awareness send pipeline already exists: quantizes local cursor to **0.5 world units**, throttles cadence, and handles WS backpressure. **Do not change sender logic**.&#x20;
- Awareness receive hook (`_onAwarenessUpdate`) currently just sets `presenceDirty` and triggers a throttled presence update; **buildPresenceView** copies raw `cursor` positions straight into the `PresenceView`.&#x20;
- The RAF loop publishes when `isDirty || presenceDirty`; after publish, it clears both flags. We will **extend** this to animate presence for \~1–2 frames after each awareness ingest.&#x20;

---

## 2) Design: Receiver-side Interpolation (Manager-owned)

### 2.1 Terminology & constants

Define inside `RoomDocManagerImpl`:

```ts
// Interpolation policy (receiver)
const INTERP_WINDOW_MS = 66; // ~1–2 frames @60 FPS
const DEAD_RECKON_MS = 33; // at most 1 frame of prediction
const MAX_SPEED_WU_PMS = 2.0 / 1000; // (optional) cap world-units per ms (~2 wu per second)
const CURSOR_Q_STEP = 0.5; // world-unit quantization (matches sender)
```

Rationale aligns with Phase-7 spec: "**Interpolate cursor state (lerp) for 1–2 frames; on a missing frame, dead-reckon using last velocity for one frame.**"&#x20;

### 2.2 Per-peer state we keep (manager, private)

Add a small in-memory smoother per remote `userId`:

```ts
type Pt = { x: number; y: number; t: number };

interface PeerSmoothing {
  // Inputs (from awareness):
  prev?: Pt; // previous accepted sample
  last?: Pt; // latest accepted sample (target)
  hasCursor: boolean; // whether the latest awareness advertises a cursor

  // Derived motion:
  vx?: number; // velocity estimate (wu/ms)
  vy?: number;

  // Animation state (for lerp between displayStart -> last)
  displayStart?: { x: number; y: number; t: number };
  animStartMs?: number; // when lerp starts
  animEndMs?: number; // when lerp should finish
}
```

Store a `Map<string, PeerSmoothing>` on the manager (`private peerSmoothe rs = new Map()`).

### 2.3 Ingest algorithm (called on awareness updates)

When `_onAwarenessUpdate` fires, we already mark `presenceDirty` and trigger the throttled update. Extend the handler to **ingest** each changed remote state:

```
for every remote user state:
  if cursor is undefined:
    ps.hasCursor = false
    ps.prev = ps.last = undefined
    ps.vx = ps.vy = undefined
    // No display animation while absent
  else:
    // Quantize to 0.5 world-unit for stability (matches sender)
    const nx = round(cursor.x / 0.5) * 0.5
    const ny = round(cursor.y / 0.5) * 0.5
    const nt = now()

    // Update velocity using previous accepted sample (if present)
    if (ps.last) {
      const dt = max(1, nt - ps.last.t) // avoid divide by zero
      const vx = (nx - ps.last.x) / dt
      const vy = (ny - ps.last.y) / dt
      // Optional clamp
      const s = Math.hypot(vx, vy)
      const f = s > MAX_SPEED_WU_PMS ? (MAX_SPEED_WU_PMS / s) : 1
      ps.vx = vx * f; ps.vy = vy * f
      ps.prev = ps.last
    }

    ps.last = { x: nx, y: ny, t: nt }
    ps.hasCursor = true

    // Start a new small lerp window from the current displayed position
    // (we'll compute displayStart lazily in getDisplay() if needed)
    ps.animStartMs = now()
    ps.animEndMs   = ps.animStartMs + INTERP_WINDOW_MS

    // Keep the presence animating for the whole lerp window:
    presenceAnimDeadlineMs = max(presenceAnimDeadlineMs, ps.animEndMs)
```

**Where:** augment the existing awareness `"update"` listener inside `initializeWebSocketProvider()` where we already set `publishState.presenceDirty = true` and call the throttled presence update.&#x20;

### 2.4 Computing the display position (on publish)

Change **`buildPresenceView()`** so that for each remote `userId` we **return a smoothed `cursor`**:

```
function getDisplay(ps: PeerSmoothing, nowMs: number): {x:number,y:number}|undefined {
  if (!ps.hasCursor) return undefined;                // hidden immediately when absent
  if (!ps.last) return undefined;

  // 1) If we're inside the lerp window, interpolate from displayStart -> last
  if (ps.animStartMs && ps.animEndMs && nowMs < ps.animEndMs) {
    // Lazily choose displayStart:
    // - prefer the position we rendered at animStart (cached in ps.displayStart)
    // - else fall back to ps.prev or ps.last
    const start = ps.displayStart ?? ps.prev ?? ps.last;
    const u = (nowMs - ps.animStartMs) / (ps.animEndMs - ps.animStartMs);
    const x = start.x + (ps.last.x - start.x) * clamp01(u);
    const y = start.y + (ps.last.y - start.y) * clamp01(u);
    return q(x,y);
  }

  // 2) Otherwise, we are at target; consider 1-frame dead-reckon if a tick is missing:
  // "On a missing frame, dead-reckon using last velocity for one frame."
  if (ps.vx !== undefined && ps.vy !== undefined) {
    const dt = Math.min(nowMs - ps.last.t, DEAD_RECKON_MS);
    if (dt > 0) {
      const x = ps.last.x + ps.vx * dt;
      const y = ps.last.y + ps.vy * dt;
      return q(x,y);
    }
  }

  // 3) Just return the last target
  return q(ps.last.x, ps.last.y);

  function q(x:number, y:number) {
    // Apply the same 0.5 wu quantization to the display to avoid sub-pixel shimmer
    return {
      x: Math.round(x / CURSOR_Q_STEP) * CURSOR_Q_STEP,
      y: Math.round(y / CURSOR_Q_STEP) * CURSOR_Q_STEP,
    };
  }
}
```

**Important:** We do **not** add any extra delay/buffering; the renderer sees a tiny glide over **\~1–2 frames** after each update and at most **one frame** of prediction if an expected tick is missing. This mirrors the spec in OVERVIEW Phase-7.&#x20;

---

## 3) Publishing discipline (animating presence without extra timers)

### 3.1 Keep publishing during the tiny lerp window

Add a manager field:

```ts
private presenceAnimDeadlineMs = 0;
```

In the **RAF loop** (inside `startPublishLoop()`), right before checking the dirty flags, add:

```ts
const now = this.clock.now();
if (!this.publishState.presenceDirty && now < this.presenceAnimDeadlineMs) {
  // Force a presence publish to progress the interpolation
  this.publishState.presenceDirty = true;
}
```

This keeps presence snapshots flowing for the short animation window **even if no new awareness frames arrive**. After each publish, `presenceDirty` is cleared (already in code), but this hook will re-arm it until `now >= presenceAnimDeadlineMs`.&#x20;

### 3.2 Setting `displayStart` at publish time

In `buildPresenceView()` when you detect `now < animEndMs`, set `ps.displayStart = {x:computed,y:computed,t:now}` the **first time** in that window, so subsequent frames interpolate consistently from the exact position we actually published at the start of the animation.

---

## 4) Changes by file

### 4.1 `room-doc-manager.ts` (manager)

**Add fields:**

```ts
private peerSmoothers = new Map<string, PeerSmoothing>();
private presenceAnimDeadlineMs = 0;
```

**Augment awareness receive hook** (inside `initializeWebSocketProvider()`):

- After marking `publishState.presenceDirty = true`, **ingest** new states into `peerSmoothers` as described in §2.3, and set/extend `presenceAnimDeadlineMs`.

**Modify `buildPresenceView()`**:

- When enumerating awareness states (we already iterate over `yAwareness.getStates()`), for each **remote** `userId`:
  - Update/ensure a `PeerSmoothing` entry exists.
  - Compute `display = getDisplay(ps, now)` (§2.4).
  - Use `display` as the **published** `cursor` (world coords) in `PresenceView.users.set(userId, {..., cursor: display, ...})`.
  - Set `lastSeen` as we already do (from incoming state `ts` or `Date.now()`), **unchanged**.&#x20;

**Adjust RAF loop**:

- Insert the presence animation keep-alive snippet from §3.1 before evaluating dirtiness and publishing.

**Teardown**:

- We already call `clearCursorTrails()` and nuke awareness on disconnect/destroy; keep that as-is. Also clear `peerSmoothers` on `destroy()` (defensive hygiene).&#x20;

### 4.2 `renderer/layers/presence-cursors.ts`

The renderer should already draw from `snapshot.presence` and its **current ViewTransform** each frame. Because we now publish **smoothed world coords**, the renderer should **not** add any extra interpolation. If it previously did any easing, **remove it** to avoid double-smoothing (the spec explicitly warns about this). Trails can continue to consume the position from `snapshot.presence`; they will naturally look smooth because the input is smooth.&#x20;

**Keep** the existing `clearCursorTrails()` export — the manager already calls it on disconnect to avoid stale data.&#x20;

### 4.3 `canvas.tsx` / `renderloop.ts`

No structural change: they pull gates from the manager and call `drawPresenceOverlays` with the snapshot. Our **small RAF presence keep-alive** lives in the manager; the render loop remains agnostic.&#x20;

---

## 5) Edge Cases & Policies

- **Gate alignment:** Only draw when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`. The manager already flips these gates; our smoothing respects visibility (we return `undefined` when `hasCursor === false`; no fade-out for staleness).&#x20;
- **Disconnects:** On WS disconnect, the manager closes `G_AWARENESS_READY`, calls `setLocalState(null)`, clears trails, and marks presence dirty — cursors vanish immediately. Our per-peer smoother also drops `hasCursor`.&#x20;
- **Mobile:** Send side already omits `cursor` and forces `activity='idle'` on mobile. Smoothing respects that (no `hasCursor`).&#x20;
- **Sequence/order:** We continue to trust Y-awareness ordering and last-write-wins per sender; our ingestion replaces `last` only when a newer update arrives. (Using `seq` is fine if present; otherwise, time monotonicity per sender is good enough for MVP.)&#x20;
- **Transforms:** Awareness positions are **world space**; convert to canvas in the renderer per frame. If the view transform changes during a lerp window, we still interpolate in world space; drawing remains correct.&#x20;
- **Backpressure:** The send-side skip/degrade logic remains unchanged (skip frames when `bufferedAmount` is high; degrade cadence); receiver smoothing masks jitter locally.&#x20;
- **Quantization:** Keep **0.5 world-unit** quantization at both **ingest and display** to prevent flicker. This is consistent with the sender quantization in `updateCursor()`.&#x20;

---

## 6) Detailed Pseudocode (drop-in helpers)

```ts
// In RoomDocManagerImpl:

type Pt = { x:number; y:number; t:number };
interface PeerSmoothing {
  prev?: Pt; last?: Pt; hasCursor: boolean;
  vx?: number; vy?: number;
  displayStart?: Pt;
  animStartMs?: number; animEndMs?: number;
}

private peerSmoothers = new Map<string, PeerSmoothing>();
private presenceAnimDeadlineMs = 0;

private ingestAwareness(userId: string, state: any): void {
  if (!this.yAwareness) return;
  const now = this.clock.now();
  const ps = this.peerSmoothers.get(userId) ?? { hasCursor: false };
  const c = state?.cursor as {x:number, y:number} | undefined;

  if (!c) {
    ps.hasCursor = false;
    ps.prev = undefined; ps.last = undefined;
    ps.vx = undefined;   ps.vy = undefined;
    ps.displayStart = undefined;
    ps.animStartMs = undefined; ps.animEndMs = undefined;
    this.peerSmoothers.set(userId, ps);
    return;
  }

  // Quantize to 0.5 wu
  const nx = Math.round(c.x / CURSOR_Q_STEP) * CURSOR_Q_STEP;
  const ny = Math.round(c.y / CURSOR_Q_STEP) * CURSOR_Q_STEP;
  const nt = now;

  if (ps.last) {
    const dt = Math.max(1, nt - ps.last.t);
    let vx = (nx - ps.last.x) / dt;
    let vy = (ny - ps.last.y) / dt;
    const s = Math.hypot(vx, vy);
    if (s > MAX_SPEED_WU_PMS) {
      const f = MAX_SPEED_WU_PMS / s; vx *= f; vy *= f;
    }
    ps.vx = vx; ps.vy = vy; ps.prev = ps.last;
  }

  ps.last = { x: nx, y: ny, t: nt };
  ps.hasCursor = true;
  ps.displayStart = undefined;             // recompute on first publish in window
  ps.animStartMs = now;
  ps.animEndMs   = now + INTERP_WINDOW_MS;
  this.peerSmoothers.set(userId, ps);

  // keep presence animating during the lerp window
  this.presenceAnimDeadlineMs = Math.max(this.presenceAnimDeadlineMs, ps.animEndMs!);
  this.publishState.presenceDirty = true;
}

private getDisplayCursor(ps: PeerSmoothing, now: number) {
  if (!ps.hasCursor || !ps.last) return undefined;

  // 1) Inside animation window: lerp from displayStart to last
  if (ps.animStartMs !== undefined && ps.animEndMs !== undefined && now < ps.animEndMs) {
    if (!ps.displayStart) {
      // prefer prev sample if available to avoid a stationary start
      const s = ps.prev ?? ps.last;
      ps.displayStart = { x: s.x, y: s.y, t: now };
    }
    const u = Math.max(0, Math.min(1, (now - ps.animStartMs) / (ps.animEndMs - ps.animStartMs)));
    const x = ps.displayStart.x + (ps.last.x - ps.displayStart.x) * u;
    const y = ps.displayStart.y + (ps.last.y - ps.displayStart.y) * u;
    return {
      x: Math.round(x / CURSOR_Q_STEP) * CURSOR_Q_STEP,
      y: Math.round(y / CURSOR_Q_STEP) * CURSOR_Q_STEP,
    };
  }

  // 2) Dead-reckon at most 1 frame if a tick is missing
  if (ps.vx !== undefined && ps.vy !== undefined) {
    const dt = Math.min(now - ps.last.t, DEAD_RECKON_MS);
    if (dt > 0) {
      const x = ps.last.x + ps.vx * dt;
      const y = ps.last.y + ps.vy * dt;
      return {
        x: Math.round(x / CURSOR_Q_STEP) * CURSOR_Q_STEP,
        y: Math.round(y / CURSOR_Q_STEP) * CURSOR_Q_STEP,
      };
    }
  }

  // 3) Otherwise just the last target
  return { x: ps.last.x, y: ps.last.y };
}
```

Hook these in:

- In the awareness `"update"` handler: call `ingestAwareness(userId, state)` for each changed remote user before the current throttled presence update.&#x20;
- In `buildPresenceView()`: for each remote `userId`, use `getDisplayCursor(ps, now)` for the published `cursor`.&#x20;
- In RAF loop: insert the keep-alive snippet to re-set `presenceDirty` while `now < presenceAnimDeadlineMs`.&#x20;

---

## 7) Renderer notes (what _not_ to do)

- **Do not** smooth again in `presence-cursors.ts`. The spec: “**do not double-smooth: if a predicted point exists for the current frame, prefer it.**” Our manager now always provides the best point for this frame. The renderer should just transform _world → canvas_ and draw.&#x20;
- **Trails**: Keep buffering `{x,y,t}` from the published **smoothed** cursor; age-fade logic stays in the renderer. Respect existing degrade rules (peer count, FPS, reduced motion).&#x20;

---

---

## 10) Performance & Complexity

- Per frame, we do **O(#peers)** tiny arithmetic in the manager (just a few adds/mults). The renderer already loops peers to draw pointers/trails.
- Memory is **small**: \~dozens of `PeerSmoothing` entries (each a handful of numbers).
- No extra timers; the RAF loop we already own keeps presence moving during short windows.&#x20;

---

1. **Commit** the manager changes (fields, ingest + display helpers, RAF keep-alive, `buildPresenceView` substitution).
2. **Remove** any renderer-side easing or “cursor smoothing” left in `presence-cursors.ts`. Keep trails as they are.
3. **Verify** gates and disconnect path (cursors hide instantly; trails cleared by manager).&#x20;

---

## 12) Reference Pointers (for reviewers)

- **Manager owns awareness, gates, and snapshot publisher; presence is injected into snapshots; renderers read snapshots only.** (Project overview & phases.)&#x20;
- **Existing awareness send:** quantization to **0.5 wu**, cadence, WS backpressure skip/degrade. (Keep as-is.)&#x20;
- **Awareness gating & rendering:** draw presence only when `G_AWARENESS_READY && G_FIRST_SNAPSHOT`; hide immediately on disconnect; no stale fade.&#x20;
- **Current code hooks** you’ll modify: `_onAwarenessUpdate`, `buildPresenceView`, RAF loop in `startPublishLoop()`, `destroy()` cleanup.&#x20;
