Gotcha—let’s pin down exactly what Redis in **your** stack should be doing, and how to make the gzip’d binary path bullet-proof.

# What our spec says (the target behavior)

* **Version/role:** Redis **7.x stable** with **AOF enabled** is the authoritative store for the entire Y.Doc, stored as **one gzipped blob per room** (key `room:<id>`). TTL (default **ROOM\_TTL\_DAYS = 14**) is extended **only** on accepted writes. The stored **size\_bytes** is the **compressed** length.&#x20;
* **On each doc update (server):** Apply the delta to the in-memory doc, then compute a **fresh full snapshot** with `encodeStateAsUpdate(ydoc)`, **gzip (level 4)**, and `SET room:<id> <buf> EX <ttlSeconds>`. Awareness is never persisted.&#x20;
* **On first client join (server):** `GET` the blob from Redis, **gunzip**, `Y.applyUpdate` to the fresh in-memory Y.Doc for that room.&#x20;

(#) Why these choices are correct

* Redis strings are **binary-safe**; you can store raw gzipped bytes directly—no base64 needed. RESP uses length-prefixed bulk strings, so binary content is safe end-to-end. ([Redis][1])
* **AOF** is the persistence mode we rely on at the infra level (not per-write logic), with TTL handling done via `SET … EX …` on each persist. ([Redis][2])
* With **node-redis v4**, you should **write a Buffer** and **read a Buffer** using `commandOptions({ returnBuffers: true })`. Avoid round-tripping through UTF-8 strings. (This is the v4 replacement for the old `return_buffers` flag and prevents the classic “bytes ≥ 0x7f get mangled” issue.) ([Stack Overflow][3], [GitHub][4], [npm][5])
* Gzip level **4** is the specified speed/ratio tradeoff, and Node’s `zlib` exposes it directly; higher levels compress more slowly, lower levels save less memory. ([Node.js][6])
* Yjs API correctness: use `Y.encodeStateAsUpdate(ydoc)` for the full snapshot and `Y.applyUpdate(ydoc, update)` for hydration. ([docs.yjs.dev][7])

---

# Reference implementation (drop-in safe path)

### Save path (WS “doc-update” → Redis)

```ts
// server/redisAdapter.ts
import { commandOptions, createClient } from 'redis';
import * as zlib from 'node:zlib';
import * as Y from 'yjs';

const redis = createClient({ url: process.env.REDIS_URL! });

export async function persistRoomDoc(roomId: string, ydoc: Y.Doc, ttlSec: number) {
  // 1) Fresh full snapshot from current in-memory Y.Doc
  const update = Y.encodeStateAsUpdate(ydoc);            // Uint8Array

  // 2) Gzip(level=4) → Node Buffer
  const gz = zlib.gzipSync(Buffer.from(update), { level: 4 });

  // 3) Store as binary with TTL (atomic via SET EX)
  await redis.set(`room:${roomId}`, gz, { EX: ttlSec });

  // Return compressed size for advisory metadata
  return gz.length;
}
```

### Load path (first join → hydrate in-memory Y.Doc)

```ts
import { commandOptions } from 'redis';
import * as zlib from 'node:zlib';
import * as Y from 'yjs';

export async function loadRoomDoc(roomId: string, ydoc: Y.Doc) {
  const key = `room:${roomId}`;
  // Read exact bytes back (no UTF-8 decode!)
  const gz = await redis.get(commandOptions({ returnBuffers: true }), key);
  if (!gz) return false; // expired/missing

  const update = zlib.gunzipSync(gz as Buffer); // Buffer → Buffer
  Y.applyUpdate(ydoc, update);                  // reconstruct full doc
  return true;
}
```

> **Key details that avoid the classic traps**
> • Do **not** `toString()` or `JSON.stringify()` any Buffer.
> • Do **not** base64 unless you’re forced to (you aren’t).
> • Use `commandOptions({ returnBuffers: true })` with node-redis v4 when **reading**. (In v4 there is no global `return_buffers`—this is the per-command way.) ([Stack Overflow][3], [GitHub][8])

---

# Fast validation checklist (run these now)

**Redis side**

1. Confirm version & AOF:

```bash
redis-cli INFO server | grep redis_version
redis-cli INFO persistence | egrep 'appendonly|aof_current_size'
```

Expect Redis **7.x**, with `appendonly:1`. ([Redis][2])

2. TTL behavior: always use **one** `SET` with `EX` for atomic “write + TTL”. Don’t do `SET` followed by a separate `EXPIRE`. ([Redis][9])

**Node adapter**

* **GET returns Buffer?** If you see a string, your client call is wrong—add `commandOptions({ returnBuffers: true })`. If you see “random chars” on gunzip, you accidentally decoded as UTF-8 first. ([Stack Overflow][3])
* **Size accounting:** record **compressed** length (what we actually store). That’s what the UI pill reads.&#x20;

**Gzip path**

* Use Node’s `zlib.gzipSync(buf, { level: 4 })` and `zlib.gunzipSync(buf)`. If decompression throws “incorrect header check”, you likely used **deflate** on write and **gunzip** on read (or double-compressed). ([Node.js][6])

**Yjs semantics**

* On persist: **full** state snapshot (`encodeStateAsUpdate`) *not* the last incremental delta. On load: apply once to empty doc. New clients must hydrate to the **entire** document. ([docs.yjs.dev][7])

---

# Minimal round-trip self-test (proves gzip+Redis+Yjs end-to-end)

```ts
import * as Y from 'yjs';
import * as zlib from 'node:zlib';
import { createClient, commandOptions } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL! });

async function smoke(roomId='test-room') {
  const a = new Y.Doc();
  a.getArray('strokes').insert(0, [{ id:'1', points:[0,0, 10,10] }]);

  // Persist
  const update = Y.encodeStateAsUpdate(a);
  const gz = zlib.gzipSync(Buffer.from(update), { level: 4 });
  await redis.set(`room:${roomId}`, gz, { EX: 60 });

  // Hydrate a fresh doc from Redis
  const gzBack = await redis.get(commandOptions({ returnBuffers: true }), `room:${roomId}`);
  const updateBack = zlib.gunzipSync(gzBack as Buffer);
  const b = new Y.Doc();
  Y.applyUpdate(b, updateBack);

  // Equivalent state? Their state vectors should match length/content.
  // (Or compare your snapshot svKey for debugging.)
}
```

---

# Likely causes of the issues you’re seeing (and the quick fixes)

1. **UTF-8 decoding of binary** (very common): you read a string, `gunzip` fails or returns garbage.
   **Fix:** read with `returnBuffers: true`. ([Stack Overflow][3])

2. **Wrong compressor pair**: `deflate` on write, `gunzip` on read (or double gzip).
   **Fix:** always `gzipSync` ↔ `gunzipSync`. ([Node.js][6])

3. **Storing incremental deltas** instead of a full snapshot: new rooms fail to hydrate cleanly.
   **Fix:** always `encodeStateAsUpdate(ydoc)` after applying the delta to memory; do **not** persist the incoming delta itself.&#x20;

4. **TTL not being extended**: you used `EXPIRE` after `SET` and sometimes missed it under load.
   **Fix:** **single** `SET … EX <seconds>` per write. ([Redis][9])

5. **AOF off / memory eviction surprises**: Redis restarts drop the key or eviction removes it.
   **Fix:** verify `appendonly:1` and appropriate eviction policy for your environment (we rely on TTL, not cron deletes). ([Redis][2])

---

## TL;DR

* Your Redis should be **7.x + AOF**, storing **one gzipped full Yjs snapshot per room** with **SET … EX** on each accepted write; **size\_bytes = gz.length**.
* In Node, **write Buffers**, **read Buffers** (`commandOptions({ returnBuffers: true })`), and use `gzipSync(level:4)`/`gunzipSync`. ([Stack Overflow][3], [npm][5], [Node.js][6])

If anything in your adapter differs from the snippets above, that’s almost certainly the culprit.
