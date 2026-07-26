/**
 * AVS2 snapshot codec + OPFS store (P2 — owned dense snapshots).
 *
 * At-rest layout (`opfs:/py/<buildHash>/<setKey>.snap`; never on the wire):
 *   [u32 magic 'AVS2' LE] [u32 headerLen] [u32 heapLen] [u32 crc32(headerJSON)]
 *   [header JSON, UTF-8, zero-padded so heapOff = 16 + alignUp(headerLen, 4096)]
 *   [dense heap bytes … EOF]
 *
 * Hard cross-checks on read: magic, crc32(headerJSON), v, buildHash (the lock
 * binding — buildHash commits to every artifact/bundle sha), setKey, stored
 * heapOff == 16 + alignUp(headerLen, 4096), header heapLen == fixed-header
 * heapLen, and fileSize − heapOff == heapLen (workerd-style "heap is whatever
 * is left" — stored and inferred must agree). The heap carries a FAST content
 * hash (xxh32 over u32 lanes) folded incrementally inside the chunked
 * read/write loops — never a whole-file buffer, never a SHA pass. ANY check
 * failure throws; callers delete + fall back cold. The write puts the header
 * LAST (heap first at heapOff), so a torn write is a magic/crc/length fail on
 * the next read — no temp+rename needed.
 *
 * Restore reads are SUPERVISOR-side (L2 topology): `readSnapshotToBuffer`
 * does chunked positioned reads into ONE exact-size buffer, folding the fast
 * hash, yielding to the event loop between chunks (the supervisor owns every
 * wall clock — a sync ~79 MB loop would block cancel/exec messages) and
 * checking live/abandoned signals per iteration. The verified buffer is then
 * TRANSFERRED to the executor, whose preBlit driver blits it into wasm
 * memory — hash verdicts happen before the bytes ever cross the boundary.
 *
 * Deliberately absent vs the parked AVS1 design: tree segment (site-packages
 * re-extracts from the boot tars — the in-wasm `tarfile.extractall` already IS
 * the bulk path; deterministic ustar mtimes reproduce capture), dso segment
 * (`.so` bytes slice out of the transferred tar buffers), sparse pages,
 * SHA-256 trailer, LRU (≤5 sets, bounded by construction), brotli/wire
 * concerns. The header does double duty as the future wire integrity field
 * when build-side capture ships snapshots over HTTP.
 *
 * Table-drift posture: replay determinism holds because `updateGOT`
 * addFunctions every non-internal export of every module at instantiation —
 * imports at runtime are table HITS, never new slots — and the one preRun
 * trampoline is positionally identical on cold and restore boots. If that
 * ever breaks (e.g. a UA change re-introduces an iOS-style trampoline
 * asymmetry), the per-DSO tableBase asserts + the hard post-replay
 * tableLenAtCapture assert fail LOUD → snap-invalid → cold + re-capture.
 *
 * Dependency-free by design (py-trace is the one allowed import — itself
 * dependency-free): the SUPERVISOR owns ALL OPFS I/O (open/read/write/delete/
 * GC — `navigator.storage` only inside those functions); the executor never
 * touches OPFS (L2 killed the executor-side probe, so no sync handle can even
 * exist near the scrub boundary). The py-build Node harness imports the codec
 * half (pure functions + readSnapshotToBuffer over an fd-backed handle)
 * against a real fork boot.
 */

import { traceBegin } from './py-trace';

// ------------------------------------------------------------------- types

export interface AvsDsoInfo {
  /** Recorded NORMALIZED ABSOLUTE dlopen paths, in dlopen order. */
  loadOrder: string[];
  soMemoryBases: Record<string, number>;
  soTableBases: Record<string, number>;
}

/** Everything the executor captures at the pre-harden slot (rides
 * `exec-snapshot` next to the transferred heap). */
export interface AvsCaptureMeta {
  dso: AvsDsoInfo;
  dsoHandles: Record<string, { handles: number[] }>;
  /** Fork SnapshotConfig (hiwire + immortal keys) — opaque to the client;
   * handed back verbatim to finalizeBootstrap on restore. */
  hiwire: unknown;
  /** Fork BUILD_ID (glue+wasm digest) — asserted in preBlit pre-grow. */
  buildId: string;
  tableLenAtCapture: number;
  heapLen: number;
}

export interface AvsHeader extends AvsCaptureMeta {
  v: 2;
  buildHash: string;
  setKey: string;
  heapOff: number;
  heapHash: { algo: 'xxh32'; value: string };
}

/** Chunked positioned reader over the snapshot file. Implemented over an OPFS
 * read-only sync access handle, a buffered File (contention fallback), or a
 * Node fd shim in the py-build harness. `close()` is idempotent — failure
 * paths may close twice. */
export interface SnapReadHandle {
  readonly size: number;
  /** Read up to view.length bytes at absolute offset `at`; returns count. */
  read(view: Uint8Array, at: number): number;
  close(): void;
}

// ------------------------------------------------------------------- xxh32
//
// Standard XXH32 (seed 0), streaming, with an unrolled u32-lane fast path
// (~2.8 GB/s in V8 — the heap-integrity budget). Known-answer vectors are
// pinned by the py-build harness snapshot section.

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

export class Xxh32 {
  private a1 = (P1 + P2) | 0;
  private a2 = P2 | 0;
  private a3 = 0;
  private a4 = -P1 | 0;
  private len = 0;
  private carry = new Uint8Array(16);
  private carryLen = 0;

  update(u8: Uint8Array): void {
    this.len += u8.length;
    let i = 0;
    if (this.carryLen > 0) {
      const take = Math.min(16 - this.carryLen, u8.length);
      this.carry.set(u8.subarray(0, take), this.carryLen);
      this.carryLen += take;
      i = take;
      if (this.carryLen < 16) return;
      const dv = new DataView(this.carry.buffer);
      this.stripe(dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true), dv.getUint32(12, true));
      this.carryLen = 0;
    }
    const stripes = (u8.length - i) >> 4;
    if (stripes > 0 && (u8.byteOffset + i) % 4 === 0) {
      // Fast path: u32-lane reads, 4 stripes per iteration (independent
      // accumulator chains give the ILP; heap chunks are always 4-aligned).
      const u32 = new Uint32Array(u8.buffer, u8.byteOffset + i, stripes * 4);
      let b1 = this.a1;
      let b2 = this.a2;
      let b3 = this.a3;
      let b4 = this.a4;
      const n16 = (stripes * 4) & ~15;
      let s = 0;
      for (; s < n16; s += 16) {
        b1 = (b1 + Math.imul(u32[s], P2)) | 0;
        b1 = Math.imul((b1 << 13) | (b1 >>> 19), P1);
        b2 = (b2 + Math.imul(u32[s + 1], P2)) | 0;
        b2 = Math.imul((b2 << 13) | (b2 >>> 19), P1);
        b3 = (b3 + Math.imul(u32[s + 2], P2)) | 0;
        b3 = Math.imul((b3 << 13) | (b3 >>> 19), P1);
        b4 = (b4 + Math.imul(u32[s + 3], P2)) | 0;
        b4 = Math.imul((b4 << 13) | (b4 >>> 19), P1);
        b1 = (b1 + Math.imul(u32[s + 4], P2)) | 0;
        b1 = Math.imul((b1 << 13) | (b1 >>> 19), P1);
        b2 = (b2 + Math.imul(u32[s + 5], P2)) | 0;
        b2 = Math.imul((b2 << 13) | (b2 >>> 19), P1);
        b3 = (b3 + Math.imul(u32[s + 6], P2)) | 0;
        b3 = Math.imul((b3 << 13) | (b3 >>> 19), P1);
        b4 = (b4 + Math.imul(u32[s + 7], P2)) | 0;
        b4 = Math.imul((b4 << 13) | (b4 >>> 19), P1);
        b1 = (b1 + Math.imul(u32[s + 8], P2)) | 0;
        b1 = Math.imul((b1 << 13) | (b1 >>> 19), P1);
        b2 = (b2 + Math.imul(u32[s + 9], P2)) | 0;
        b2 = Math.imul((b2 << 13) | (b2 >>> 19), P1);
        b3 = (b3 + Math.imul(u32[s + 10], P2)) | 0;
        b3 = Math.imul((b3 << 13) | (b3 >>> 19), P1);
        b4 = (b4 + Math.imul(u32[s + 11], P2)) | 0;
        b4 = Math.imul((b4 << 13) | (b4 >>> 19), P1);
        b1 = (b1 + Math.imul(u32[s + 12], P2)) | 0;
        b1 = Math.imul((b1 << 13) | (b1 >>> 19), P1);
        b2 = (b2 + Math.imul(u32[s + 13], P2)) | 0;
        b2 = Math.imul((b2 << 13) | (b2 >>> 19), P1);
        b3 = (b3 + Math.imul(u32[s + 14], P2)) | 0;
        b3 = Math.imul((b3 << 13) | (b3 >>> 19), P1);
        b4 = (b4 + Math.imul(u32[s + 15], P2)) | 0;
        b4 = Math.imul((b4 << 13) | (b4 >>> 19), P1);
      }
      for (; s < stripes * 4; s += 4) {
        b1 = (b1 + Math.imul(u32[s], P2)) | 0;
        b1 = Math.imul((b1 << 13) | (b1 >>> 19), P1);
        b2 = (b2 + Math.imul(u32[s + 1], P2)) | 0;
        b2 = Math.imul((b2 << 13) | (b2 >>> 19), P1);
        b3 = (b3 + Math.imul(u32[s + 2], P2)) | 0;
        b3 = Math.imul((b3 << 13) | (b3 >>> 19), P1);
        b4 = (b4 + Math.imul(u32[s + 3], P2)) | 0;
        b4 = Math.imul((b4 << 13) | (b4 >>> 19), P1);
      }
      this.a1 = b1;
      this.a2 = b2;
      this.a3 = b3;
      this.a4 = b4;
      i += stripes * 16;
    } else if (stripes > 0) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      for (let s = 0; s < stripes; s++, i += 16) {
        this.stripe(dv.getUint32(i, true), dv.getUint32(i + 4, true), dv.getUint32(i + 8, true), dv.getUint32(i + 12, true));
      }
    }
    if (i < u8.length) {
      this.carry.set(u8.subarray(i), 0);
      this.carryLen = u8.length - i;
    }
  }

  private stripe(l1: number, l2: number, l3: number, l4: number): void {
    let a = (this.a1 + Math.imul(l1, P2)) | 0;
    this.a1 = Math.imul((a << 13) | (a >>> 19), P1);
    a = (this.a2 + Math.imul(l2, P2)) | 0;
    this.a2 = Math.imul((a << 13) | (a >>> 19), P1);
    a = (this.a3 + Math.imul(l3, P2)) | 0;
    this.a3 = Math.imul((a << 13) | (a >>> 19), P1);
    a = (this.a4 + Math.imul(l4, P2)) | 0;
    this.a4 = Math.imul((a << 13) | (a >>> 19), P1);
  }

  /** Finalize → 8-hex-char digest (does not mutate; safe to call once). */
  hex(): string {
    const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
    let h = this.len >= 16 ? (rotl(this.a1, 1) + rotl(this.a2, 7) + rotl(this.a3, 12) + rotl(this.a4, 18)) | 0 : P5 | 0;
    h = (h + this.len) | 0;
    let i = 0;
    const dv = new DataView(this.carry.buffer);
    for (; i + 4 <= this.carryLen; i += 4) {
      h = (h + Math.imul(dv.getUint32(i, true), P3)) | 0;
      h = Math.imul(rotl(h, 17), P4);
    }
    for (; i < this.carryLen; i++) {
      h = (h + Math.imul(this.carry[i], P5)) | 0;
      h = Math.imul(rotl(h, 11), P1);
    }
    h ^= h >>> 15;
    h = Math.imul(h, P2);
    h ^= h >>> 13;
    h = Math.imul(h, P3);
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

// ------------------------------------------------------------------- codec

const AVS_MAGIC = 0x32535641; // 'AVS2' LE
const HEADER_ALIGN = 4096;
/** Header JSON can exceed one page (hiwire immortalKeys) — bound it sanely. */
const MAX_HEADER_LEN = 1 << 22;
const CHUNK = 8 << 20; // multiple of 16 — whole xxh32 stripes per chunk

const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(u8: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Fixed-point heapOff: the header JSON stores its own offset, and the offset
 * depends on the JSON's length — iterate to convergence (2–3 passes; the
 * digit count of heapOff is the only movable part). The heapHash value is
 * ALWAYS 8 hex chars, so sizing with the placeholder and finalizing with the
 * real digest is byte-length-identical. */
export function planAvsHeapOff(h: Omit<AvsHeader, 'heapOff'>): number {
  const enc = new TextEncoder();
  let heapOff = 0;
  for (let i = 0; i < 6; i++) {
    const len = enc.encode(JSON.stringify({ ...h, heapOff })).length;
    const next = 16 + alignUp(len, HEADER_ALIGN);
    if (next === heapOff) return heapOff;
    heapOff = next;
  }
  throw new Error('avs2: heapOff fixed point did not converge');
}

/** Assemble the zero-padded header block (fixed 16 bytes + JSON + padding to
 * heapOff). Throws if the JSON no longer fits the planned offset. */
export function encodeAvsHeaderBlock(h: Omit<AvsHeader, 'heapOff'>, heapOff: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ ...h, heapOff }));
  if (16 + alignUp(json.length, HEADER_ALIGN) !== heapOff) throw new Error('avs2: header length shifted after planning');
  const block = new Uint8Array(heapOff);
  const dv = new DataView(block.buffer);
  dv.setUint32(0, AVS_MAGIC, true);
  dv.setUint32(4, json.length, true);
  dv.setUint32(8, h.heapLen, true);
  dv.setUint32(12, crc32(json), true);
  block.set(json, 16);
  return block;
}

/** Read + validate the header. ANY failure throws — the caller treats the
 * file as invalid (executor: exec-snap-invalid → cold; supervisor deletes). */
export function parseAvsHeader(handle: SnapReadHandle, expect: { buildHash: string; setKey: string }): AvsHeader {
  const fixed = new Uint8Array(16);
  if (handle.read(fixed, 0) !== 16) throw new Error('avs2: truncated fixed header');
  const dv = new DataView(fixed.buffer);
  if (dv.getUint32(0, true) !== AVS_MAGIC) throw new Error('avs2: bad magic');
  const headerLen = dv.getUint32(4, true);
  const heapLenU32 = dv.getUint32(8, true);
  if (headerLen === 0 || headerLen > MAX_HEADER_LEN) throw new Error('avs2: implausible headerLen');
  const json = new Uint8Array(headerLen);
  if (handle.read(json, 16) !== headerLen) throw new Error('avs2: truncated header json');
  if (crc32(json) !== dv.getUint32(12, true)) throw new Error('avs2: header crc mismatch');
  const h = JSON.parse(new TextDecoder().decode(json)) as AvsHeader;
  if (h.v !== 2) throw new Error(`avs2: unknown version ${h.v}`);
  if (h.buildHash !== expect.buildHash) throw new Error('avs2: buildHash mismatch (stale build)');
  if (h.setKey !== expect.setKey) throw new Error('avs2: setKey mismatch');
  if (h.heapOff !== 16 + alignUp(headerLen, HEADER_ALIGN)) throw new Error('avs2: heapOff disagrees with headerLen');
  if (h.heapLen !== heapLenU32) throw new Error('avs2: heapLen disagrees with fixed header');
  if (handle.size - h.heapOff !== h.heapLen) throw new Error('avs2: fileSize − heapOff ≠ heapLen');
  return h;
}

// Macrotask yield for the supervisor's chunked read loop. MessageChannel, NOT
// setTimeout(0): the 4 ms nesting clamp kicks in past 5 levels and would eat
// the overlap win; MessageChannel is unclamped and shares the message task
// source, so worker onmessage handlers (cancel, exec relays) interleave
// fairly between chunks. Under Node (harness/vitest) use setImmediate
// instead: it is unclamped AND ref'd-while-pending, whereas a module-scope
// MessageChannel either pins the event loop open forever (ref'd) or lets the
// process exit mid-await (unref'd).
// biome-ignore lint/suspicious/noExplicitAny: Node-only global probe
const nodeSetImmediate: ((cb: () => void) => void) | undefined = (globalThis as any).setImmediate;
let yieldChannel: MessageChannel | null = null;
let yieldWake: (() => void) | null = null;
function yieldToEvents(): Promise<void> {
  if (nodeSetImmediate) return new Promise((resolve) => nodeSetImmediate(resolve));
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => yieldWake?.();
  }
  return new Promise((resolve) => {
    yieldWake = resolve;
    (yieldChannel as MessageChannel).port2.postMessage(0);
  });
}

/** SUPERVISOR-side (L2): chunked positioned reads of the heap segment into
 * ONE exact-size buffer, folding the fast hash, awaiting a macrotask yield
 * between chunks and checking the generation signals per iteration — a
 * superseded or abandoned read stops paying I/O and resolves null (the caller
 * posts nothing). Short read / hash mismatch THROW — the caller deletes (on a
 * lock-holding rung) and posts a null heap. The u32 hash fast path holds:
 * heapOff is 4096-aligned and chunks are 8 MiB. */
export async function readSnapshotToBuffer(
  handle: SnapReadHandle,
  header: AvsHeader,
  signals: { live(): boolean; abandoned(): boolean },
): Promise<ArrayBuffer | null> {
  const buf = new ArrayBuffer(header.heapLen);
  const u8 = new Uint8Array(buf);
  const x = new Xxh32();
  for (let off = 0; off < header.heapLen; off += CHUNK) {
    if (!signals.live() || signals.abandoned()) return null;
    const n = Math.min(CHUNK, header.heapLen - off);
    const view = u8.subarray(off, off + n);
    if (handle.read(view, header.heapOff + off) !== n) throw new Error('avs2: short heap read');
    x.update(view);
    await yieldToEvents();
  }
  const got = x.hex();
  if (got !== header.heapHash.value) throw new Error(`avs2: heap hash mismatch (${got} ≠ ${header.heapHash.value})`);
  return buf;
}

// -------------------------------------------------------------- OPFS store
//
// Best-effort by contract: reads fall back to cold, writes swallow everything
// (quota, lock contention, OPFS-less contexts) — a run never blocks on
// persistence.

/** Dedicated-worker-only sync file API — absent from the bundled TS lib.
 * `mode` is a newer dictionary member; engines that predate it IGNORE unknown
 * members, so `{ mode: 'read-only' }` degrades to the exclusive default
 * automatically (no UA sniff — the whole open is try/caught for contention). */
interface SyncAccessHandle {
  read(buffer: Uint8Array, opts?: { at?: number }): number;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(opts?: { mode?: 'read-only' | 'readwrite' }): Promise<SyncAccessHandle>;
};

let gcDone = false;

/** `py/<buildHash>/` for the WRITE side, GC'ing sibling stale-build dirs on
 * first touch (a rotated buildHash auto-invalidates every held snapshot). */
async function snapDir(buildHash: string): Promise<FileSystemDirectoryHandle> {
  const py = await (await navigator.storage.getDirectory()).getDirectoryHandle('py', { create: true });
  if (!gcDone) {
    gcDone = true;
    for await (const name of py.keys()) {
      if (name !== buildHash) await py.removeEntry(name, { recursive: true }).catch(() => {});
    }
  }
  return py.getDirectoryHandle(buildHash, { create: true });
}

const wrapSync = (sync: SyncAccessHandle): SnapReadHandle => {
  let closed = false;
  return {
    size: sync.getSize(),
    read: (view, at) => sync.read(view, { at }),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        sync.close();
      } catch {
        /* already released */
      }
    },
  };
};

export interface SnapOpen {
  handle: SnapReadHandle;
  /** True iff this rung HOLDS a lock on stable bytes — the only rungs whose
   * parse/hash failures may poison-delete the file. The buffered `getFile`
   * contention rung yields UNSTABLE bytes (another tab may be mid-write), so
   * its failures are a MISS, never a delete (F9). */
  deletable: boolean;
}

/** SUPERVISOR-side probe (L2). Open order: read-only sync handle (concurrent
 * readers across tabs; engines without `mode` degrade to the exclusive
 * default — still lock-holding, still deletable) → async `getFile()` buffer
 * (lock contention — non-deletable) → null (absent / OPFS unavailable) =
 * cold. Never creates. The capture-writer's exclusive handle remains the
 * multi-tab write arbiter. */
export async function openSetSnapshotSup(buildHash: string, setKey: string): Promise<SnapOpen | null> {
  let file: FileSystemFileHandle;
  try {
    const py = await (await navigator.storage.getDirectory()).getDirectoryHandle('py');
    const dir = await py.getDirectoryHandle(buildHash);
    file = await dir.getFileHandle(`${setKey}.snap`);
  } catch {
    return null;
  }
  try {
    return { handle: wrapSync(await (file as SyncFileHandle).createSyncAccessHandle({ mode: 'read-only' })), deletable: true };
  } catch {
    /* contention (a writer holds the lock) — buffered fallback */
  }
  try {
    const buf = new Uint8Array(await (await file.getFile()).arrayBuffer());
    return {
      handle: {
        size: buf.length,
        read: (view, at) => {
          const n = Math.min(view.length, Math.max(0, buf.length - at));
          view.set(buf.subarray(at, at + n));
          return n;
        },
        close: () => {},
      },
      deletable: false,
    };
  } catch {
    return null;
  }
}

/** SUPERVISOR-side persist. Heap chunks first (folding the fast hash), header
 * block LAST — torn writes are structurally invalid on the next read. The
 * exclusive `createSyncAccessHandle()` doubles as the multi-tab arbiter: the
 * capture loser's open throws and the write skips (best-effort). */
export async function writeSetSnapshot(buildHash: string, setKey: string, meta: AvsCaptureMeta, heap: ArrayBuffer): Promise<void> {
  try {
    const t0 = performance.now();
    if (heap.byteLength !== meta.heapLen) throw new Error(`heap ${heap.byteLength} ≠ meta.heapLen ${meta.heapLen}`);
    const sized: Omit<AvsHeader, 'heapOff'> = {
      v: 2,
      buildHash,
      setKey,
      heapHash: { algo: 'xxh32', value: '00000000' },
      ...meta,
    };
    const heapOff = planAvsHeapOff(sized);
    const dir = await snapDir(buildHash);
    const handle = (await dir.getFileHandle(`${setKey}.snap`, { create: true })) as SyncFileHandle;
    const sync = await handle.createSyncAccessHandle();
    const endWrite = traceBegin('opfs-write');
    try {
      sync.truncate(0);
      const u8 = new Uint8Array(heap);
      const x = new Xxh32();
      for (let off = 0; off < u8.length; off += CHUNK) {
        const view = u8.subarray(off, Math.min(off + CHUNK, u8.length));
        sync.write(view, { at: heapOff + off });
        x.update(view);
      }
      sync.write(encodeAvsHeaderBlock({ ...sized, heapHash: { algo: 'xxh32', value: x.hex() } }, heapOff), { at: 0 });
      sync.flush();
    } finally {
      sync.close();
    }
    endWrite({ mb: Math.round((heapOff + heap.byteLength) / 1e6) });
    console.warn(
      `py: persisted ${setKey}.snap (${((heapOff + heap.byteLength) / 1e6).toFixed(1)} MB, ${(performance.now() - t0).toFixed(0)} ms)`,
    );
  } catch (err) {
    console.warn('py: snapshot persist failed (continuing snapshotless) —', err);
  }
}

export async function deleteSetSnapshot(buildHash: string, setKey: string): Promise<void> {
  try {
    await (await snapDir(buildHash)).removeEntry(`${setKey}.snap`);
  } catch {
    /* already gone / OPFS unavailable */
  }
}
