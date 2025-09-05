Got it—focusing **only** on the Phase 6A code you pasted (svKey, snapshot publishing, and gates), here’s the straight answer:

## Short answer

There **is** a subtle but decisive bug in what you pasted: you’re updating `publishState.lastSvKey` **inside `buildSnapshot()`** (and opening the `firstSnapshot` gate from there). That change can cause the **publisher’s dedupe check** to think “nothing changed” and **skip the actual publish**, which perfectly explains “strokes/clear do nothing until refresh,” and why disabling the svKey optimization made strokes render again.

## Why that’s a bug (step-by-step)

Typical publish loop discipline is:

1. A Y update marks the doc “dirty”.
2. RAF tick runs → **builds** a `snapshot` (pure computation, no side effects).
3. Publisher compares `snapshot.svKey` vs **the svKey of the last snapshot it actually published** (`publishState.lastSvKey`).
4. If different → **publish** to subscribers → **then** update `publishState.lastSvKey = snapshot.svKey`.
5. If same → skip publish.

Your 6A change moves part of (4) **up into `buildSnapshot()`**:

```ts
// inside buildSnapshot():
if (snapshot.svKey !== this.publishState.lastSvKey) {
  this.publishState.lastSvKey = snapshot.svKey;   // <-- side-effect here
  if (!this.gates.firstSnapshot && snapshot.svKey !== '') {
    this.openGate('firstSnapshot');               // <-- gate opens here too
  }
}
```

That’s a problem because:

* The **dedupe comparison** now happens **after** you’ve already mutated `lastSvKey`.
* So, by the time the publisher checks “did svKey change?”, it may see **`snapshot.svKey === lastSvKey`** and decide **not to publish**—even though it should have.
* Meanwhile, `firstSnapshot` might get opened **before** any snapshot is actually emitted to subscribers (mis-signaling readiness).

This produces exactly your symptom profile:

* **Strokes/clear appear only after refresh**: the publish during the first session gets swallowed by the premature `lastSvKey` write; after a reload the lifecycle differs just enough that you occasionally see a publish (or you disabled the optimization temporarily).
* **Disabling the svKey optimization** makes strokes render: by removing the “same-key → skip” check, you sidestep the premature `lastSvKey` update and the publisher finally emits frames.

## Other 6A-specific gotchas in your paste

These aren’t *the* root cause, but they amplify confusion:

* **`firstSnapshot` gate opens inside `buildSnapshot()`**: your comment says it should open when the first **doc-derived snapshot publishes**. Opening it at build-time can fire the gate **even if no publish happens**, so any UI awaiting that gate may proceed under a false “ready” signal while subscribers never received a new snapshot.
* **IDB gate and RAF**: You correctly say RAF should **not** wait for gates. Good. If, however, any consumer is waiting on `firstSnapshot` to start painting and that gate opens too early (see above), they’ll move on without actually having received a published snapshot.

## What to change (principles, not code)

* Treat `buildSnapshot()` as **pure**: compute and return a snapshot; **do not** mutate `publishState` or gates from here.
* Perform **all** dedupe and state advancement in the **publish** path:

  * Compare `snapshot.svKey` to `publishState.lastSvKey`.
  * If different → **emit to subscribers**, then **update `publishState.lastSvKey`**.
  * Only **after** a successful emit, open `firstSnapshot` (if not yet open and `svKey !== ''`).
* Keep the RAF loop independent of gates (as you already stated).

## A quick, surgical way to prove it locally

Add four breadcrumb logs (no code here, just what to log and where):

1. **On Y update** → log `onDocUpdate -> dirty=true`.
2. **At RAF tick before build** → log `raf -> lastSvKey=<value>`.
3. **Immediately after `buildSnapshot()` returns** → log `built snapshot svKey=<value>`.
4. **Right where you decide to publish** → log `willPublish=<true/false> (compare snapshot.svKey vs lastSvKey)` and **after** notifying subscribers log `published` and then `advance lastSvKey=<value>`.

If you currently see the sequence:
`raf (lastSvKey=A)` → `built (svKey=A)` → `willPublish=false`,
and yet you know the doc changed just now, that’s the smoking gun: `lastSvKey` was already advanced **inside** `buildSnapshot()`.

---

### Bottom line

Based solely on the Phase 6A snippet you pasted: the premature update of `publishState.lastSvKey` (and the `firstSnapshot` gate opening) **inside `buildSnapshot()`** is the most likely cause of your “no render until refresh” behavior. Move the `lastSvKey` advancement and `firstSnapshot` gate opening to the **post-publish** commit path, and the symptoms you described should disappear without touching earlier phases or the rest of your architecture.
