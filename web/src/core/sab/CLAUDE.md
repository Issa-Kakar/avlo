# SAB Control-Plane Toolkit (`core/sab/`)

> Worker-agnostic SharedArrayBuffer primitives for a producer (main thread) ↔ N-consumer (worker pool) command channel. First consumer: image decode (`core/image/image-sab.ts` + `image-manager.ts` + `image-worker.ts`). The code-execution workers planned next import the same toolkit.

---

## The split it exists to enforce

```
COMMAND / CANCEL / STALENESS  → SharedArrayBuffer + Atomics   (high-frequency, tiny, latency-sensitive)
RESULT (a decoded ImageBitmap) → postMessage + Transferable    (rare, one per job, zero-copy — unchanged)
```

GPU-backed results (ImageBitmap) **cannot** live in a SAB, so they keep travelling by Transferable. The win is on the command path: a burst of would-be cancels collapses into a single `Atomics.load` of current intent; dispatch is work-stealing (no static routing); idle workers cost zero CPU (futex parking).

---

## Files

| File | Responsibility |
|------|----------------|
| `futex.ts` | `Futex` over one i32 seq cell: `signal()` (bump + `Atomics.notify` — wakes ALL idle workers), `loadSeq()`, `wait(expected)` (`Atomics.waitAsync`). |
| `ring.ts` | `SpmcRing` — single-producer / multi-consumer lock-free ring of fixed-width i32 records. `tryPush` (producer), `tryPop` (consumer, CAS on head), `isEmpty`, `reset`. |
| `slot-table.ts` | `SlotTable` — `slotCount × slotWords` atomic i32 fields + a parallel per-slot byte side-region (the image plane stores the 32-byte hash there). Generic `load`/`store`/`bump` + `setHash`/`hashView`. |
| `index.ts` | Barrel + `assertCrossOriginIsolated()` + `allocControlSab(layout)` / `mapControlSab(sab, layout)` — carve one SAB into header + slot table + rings + hash region, return typed views + offsets. |

A consumer module (e.g. `image-sab.ts`) names the header indices and slot fields, picks `SLOT_COUNT`/`RING_CAP`, and builds the `SlotTable` + `SpmcRing`s + `Futex` from the views — so the layout is a single source of truth `import`ed by both producer and consumer (no version field, agreement by construction).

---

## Invariants

- **Cross-origin isolation is the contract.** `Atomics.waitAsync` + SAB require `crossOriginIsolated` (COOP `same-origin` + COEP `credentialless`, set in `client/public/_headers` + `vite.config.ts`). `assertCrossOriginIsolated()` throws at pool init — no dual-path fallback (pre-production doctrine).

- **Single producer.** Exactly one thread (main) pushes to a ring and writes `tail`; only `head` is contended (CAS between consumers). This is what makes the ring lock-free yet correct without a full MPMC protocol. Never push from a worker.

- **The slot table is the source of truth; the ring is a hint.** A ring record (`[slot, gen]`) only says "look at this slot." The consumer re-reads the slot's real intent (gen/level/dims). So a stale or torn record degrades to "re-check that slot, find nothing to do" — never corruption. For the producer to overwrite a record a consumer is mid-read would require lapping it by a full `capacity` between the consumer's CAS and its read — impossible at these sizes/rates.

- **Monotonic cursors.** `head`/`tail` are i32 counters that never wrap; `& (capacity-1)` maps them to storage, so **`capacity` must be a power of two**. Live count = `tail - head` ≤ capacity.

- **Memory ordering via the gen handshake.** The producer writes a slot's plain fields (level/dims/hash), THEN `Atomics`-bumps the slot's gen and publishes the ring record. A consumer `Atomics`-loads the gen first; that acquire pairs with the producer's release, making the prior plain writes visible. So per-field writes need not be individually atomic — a consumer that reads a half-updated slot also sees a bumped gen and abandons at its next checkpoint.

- **Futex discipline (no lost wakeup).** Consumer loop:
  ```
  while (tryPop work) process(work)
  const seq = futex.loadSeq()          // snapshot
  if (!ring.isEmpty()) continue        // re-check AFTER snapshot
  await futex.wait(seq)                // 'not-equal' short-circuits the gap
  ```
  If the producer pushes + `signal()`s between the snapshot and the wait, `waitAsync` returns `not-equal` synchronously and the consumer re-loops instead of sleeping through the wake. `signal()` always follows a push batch.

- **`waitAsync` keeps the loop live.** It does NOT block the agent (the blocking `Atomics.wait` is illegal on a window agent anyway). A parked worker still services `postMessage` and runs async work — so on the same worker, the decode loop can park while ingest/upload/unfurl handlers still fire.
