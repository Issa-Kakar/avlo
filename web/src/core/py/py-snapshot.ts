/**
 * Snapshot container parsing + the at-rest OPFS wrapper codec (P3).
 *
 * Fork container layout (src/js/snapshot.ts, upstream + patch 0007):
 *   u32[0] magic 0x706e7300 ("\x00snp")
 *   u32[1] payload offset (16-byte aligned; heap bytes start here)
 *   u32[2] JSON config length (UTF-8 bytes)
 *   u32[3] padding
 *   bytes [16, 48)  BUILD_ID (8 × u32)
 *   bytes [48, 48+jsonLen)  SnapshotConfig JSON — avlo meta v1 lives here
 *   bytes [payloadOffset, …)  raw heap image
 *
 * The fork owns that container; THIS module owns the at-rest encoding around
 * it: one OPFS file per generated set snapshot, `py/<buildHash>/<setKey>.snap`,
 * carrying the container head verbatim, the packed site-packages tree the
 * `_preRestoreHook` replays (DSO bytes + mtimes — MEMFS lives OUTSIDE the wasm
 * heap), and the heap image sparse-encoded as non-zero 64 KiB pages
 * (uncompressed — restore latency is the product metric; `v` reserves room to
 * pivot). A sha-256 trailer seals the whole file: corruption, partial writes,
 * and casual tampering all land in verify-fail → delete → regenerate, and the
 * embedded buildHash binds the snapshot to the exact lock-verified artifact +
 * bundle bytes it was generated from (buildHash IS the canonical lock digest).
 * A full same-origin attacker is out of scope — they already run arbitrary JS,
 * and even then a forged image restores into the authority-stripped executor
 * realm (scrub/harden/assert run AFTER restore, fail-closed).
 *
 * Dependency-free by design: the executor imports `packTree` and must carry
 * neither the build-lock nor any DOM lib assumptions (py-trace is the one
 * allowed import — itself dependency-free); `navigator.storage` is touched
 * only inside the store functions (supervisor-only — the executor's realm
 * scrub deletes `navigator`).
 */

import { traceBegin, traceSpan } from './py-trace';

// ---------------------------------------------------------------- container

export interface AvloDsoInfo {
  loadOrder: string[];
  soMemoryBases: Record<string, number>;
  soTableBases: Record<string, number>;
}

export interface AvloSnapshotMeta {
  version: 1;
  snapshotType: 'baseline' | 'stacked';
  dso: AvloDsoInfo;
  dsoHandles: Record<string, { handles: number[] }>;
  heapSize: number;
}

export interface ParsedSnapshot {
  payloadOffset: number;
  jsonLength: number;
  buildId: string;
  avlo: AvloSnapshotMeta | undefined;
}

const SNAPSHOT_MAGIC = 0x706e7300;
const HEADER_SIZE = 48;

export function parseSnapshotHeader(bytes: Uint8Array): ParsedSnapshot {
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, HEADER_SIZE / 4);
  if (u32[0] !== SNAPSHOT_MAGIC) {
    throw new Error(`bad snapshot magic 0x${u32[0].toString(16)}`);
  }
  const payloadOffset = u32[1];
  const jsonLength = u32[2];
  const buildId = Array.from(u32.subarray(4, 12), (n) => n.toString(16).padStart(8, '0')).join('');
  const json = new TextDecoder().decode(bytes.subarray(HEADER_SIZE, HEADER_SIZE + jsonLength));
  const config = JSON.parse(json) as { avlo?: AvloSnapshotMeta };
  return { payloadOffset, jsonLength, buildId, avlo: config.avlo };
}

// --------------------------------------------------------------- PackedTree

/** Serialized MEMFS site-packages tree — one blob, ONE transferable. Rebuilt
 * byte-identically (incl. mtimes — pyc validation) by the `_preRestoreHook`. */
export interface PackedTree {
  root: string;
  /** Parent-first (walk order), so plain sequential mkdirTree works. */
  dirs: string[];
  files: Array<{ path: string; mtimeMs: number; off: number; len: number }>;
  blob: ArrayBuffer;
}

/** The slice of Emscripten FS that packTree walks. */
interface EmFs {
  readdir(path: string): string[];
  stat(path: string): { mode: number; mtime: number | Date };
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
}

/** Walk `root` (parent-first BFS) and pack every file into one blob. MUST run
 * AFTER the set imports — import-generated __pycache__ pycs are heap-referenced
 * (P0-B G7 finding), so an earlier walk bakes an inconsistent tree. */
export function packTree(fs: EmFs, root: string): PackedTree {
  const dirs: string[] = [];
  const raw: Array<{ path: string; mtimeMs: number; bytes: Uint8Array }> = [];
  const queue = [root];
  let total = 0;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    dirs.push(dir);
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      const st = fs.stat(path);
      if (fs.isDir(st.mode)) queue.push(path);
      else {
        const bytes = fs.readFile(path);
        raw.push({ path, mtimeMs: st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime), bytes });
        total += bytes.length;
      }
    }
  }
  const blob = new Uint8Array(total);
  const files: PackedTree['files'] = new Array(raw.length);
  let off = 0;
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    blob.set(f.bytes, off);
    files[i] = { path: f.path, mtimeMs: f.mtimeMs, off, len: f.bytes.length };
    off += f.bytes.length;
  }
  return { root, dirs, files, blob: blob.buffer };
}

// ------------------------------------------------------- OPFS wrapper codec
//
// File layout v1 (`opfs:/py/<buildHash>/<setKey>.snap`):
//   [0..4)           magic 'AVS1'
//   [4..8)           u32 LE metaLen
//   [8..8+metaLen)   meta JSON { v:1, buildHash, setKey, headLen, heapLen,
//                      treeLen, pages, tree:{root,dirs,files} }
//   [..+headLen)     container head verbatim (fork header + config JSON)
//   [..+treeLen)     tree blob
//   [..]             non-zero heap pages, ascending (last page may run short)
//   [len-32..len)    sha-256 over ALL preceding bytes

const WRAPPER_MAGIC = 0x31535641; // 'AVS1' LE
const PAGE = 65_536;
const SHA_LEN = 32;

interface WrapperMeta {
  v: 1;
  buildHash: string;
  setKey: string;
  headLen: number;
  heapLen: number;
  treeLen: number;
  /** Ascending indices of non-zero 64 KiB heap pages. */
  pages: number[];
  tree: { root: string; dirs: string[]; files: PackedTree['files'] };
}

/** Exact-bit zero scan (u32 lanes — a f64 scan would miss an all--0 page). */
function pageIsZero(u32: Uint32Array, wordOff: number, words: number): boolean {
  for (let i = wordOff; i < wordOff + words; i++) {
    if (u32[i] !== 0) return false;
  }
  return true;
}

export interface SetSnapshot {
  /** Dense fork container — feed straight to `_loadSnapshot`. */
  container: ArrayBuffer;
  tree: PackedTree;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

function encodeWrapper(buildHash: string, setKey: string, container: Uint8Array, tree: PackedTree): Uint8Array {
  const headLen = parseSnapshotHeader(container).payloadOffset;
  const heapLen = container.length - headLen;
  // Heap is 16-byte aligned at headLen inside a zero-offset buffer — u32 view is safe.
  const heapWords = new Uint32Array(container.buffer, container.byteOffset + headLen, heapLen >>> 2);
  const pages: number[] = [];
  for (let p = 0; p * PAGE < heapLen; p++) {
    const words = Math.min(PAGE, heapLen - p * PAGE) >>> 2;
    if (!pageIsZero(heapWords, (p * PAGE) >>> 2, words)) pages.push(p);
  }
  const meta: WrapperMeta = {
    v: 1,
    buildHash,
    setKey,
    headLen,
    heapLen,
    treeLen: tree.blob.byteLength,
    pages,
    tree: { root: tree.root, dirs: tree.dirs, files: tree.files },
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const pagesBytes = pages.reduce((n, p) => n + Math.min(PAGE, heapLen - p * PAGE), 0);
  const out = new Uint8Array(8 + metaBytes.length + headLen + meta.treeLen + pagesBytes + SHA_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WRAPPER_MAGIC, true);
  dv.setUint32(4, metaBytes.length, true);
  out.set(metaBytes, 8);
  let off = 8 + metaBytes.length;
  out.set(container.subarray(0, headLen), off);
  off += headLen;
  out.set(new Uint8Array(tree.blob), off);
  off += meta.treeLen;
  for (const p of pages) {
    const len = Math.min(PAGE, heapLen - p * PAGE);
    out.set(container.subarray(headLen + p * PAGE, headLen + p * PAGE + len), off);
    off += len;
  }
  return out; // sha trailer stamped by the caller (async)
}

/** Verify chain — ANY failure throws; the caller deletes + returns null. */
async function decodeWrapper(bytes: Uint8Array, buildHash: string, setKey: string): Promise<SetSnapshot> {
  if (bytes.length < 8 + SHA_LEN) throw new Error('wrapper: truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  if (dv.getUint32(0, true) !== WRAPPER_MAGIC) throw new Error('wrapper: bad magic');
  const metaLen = dv.getUint32(4, true);
  if (8 + metaLen + SHA_LEN > bytes.length) throw new Error('wrapper: meta overruns file');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + metaLen))) as WrapperMeta;
  if (meta.v !== 1) throw new Error(`wrapper: unknown version ${meta.v}`);
  if (meta.buildHash !== buildHash) throw new Error('wrapper: buildHash mismatch (stale build)');
  if (meta.setKey !== setKey) throw new Error('wrapper: setKey mismatch');
  const pagesBytes = meta.pages.reduce((n, p) => n + Math.min(PAGE, meta.heapLen - p * PAGE), 0);
  const body = 8 + metaLen + meta.headLen + meta.treeLen + pagesBytes;
  if (body + SHA_LEN !== bytes.length) throw new Error('wrapper: segment arithmetic mismatch');
  const want = bytes.subarray(body);
  const endSha = traceBegin('snap-verify-sha');
  const got = await sha256(bytes.subarray(0, body));
  endSha({ mb: Math.round(body / 1e6) });
  for (let i = 0; i < SHA_LEN; i++) {
    if (got[i] !== want[i]) throw new Error('wrapper: sha-256 trailer mismatch');
  }
  // Reconstruct the dense container: head verbatim, listed pages, zeros elide.
  const endRec = traceBegin('snap-reconstruct');
  const container = new Uint8Array(meta.headLen + meta.heapLen);
  let off = 8 + metaLen;
  container.set(bytes.subarray(off, off + meta.headLen), 0);
  off += meta.headLen;
  const treeBlob = bytes.slice(off, off + meta.treeLen); // own buffer — transferable
  off += meta.treeLen;
  for (const p of meta.pages) {
    const len = Math.min(PAGE, meta.heapLen - p * PAGE);
    container.set(bytes.subarray(off, off + len), meta.headLen + p * PAGE);
    off += len;
  }
  endRec({ pages: meta.pages.length, heapMB: Math.round(meta.heapLen / 1e6) });
  return {
    container: container.buffer,
    tree: { root: meta.tree.root, dirs: meta.tree.dirs, files: meta.tree.files, blob: treeBlob.buffer },
  };
}

// ---------------------------------------------------------------- OPFS store
//
// Supervisor-owned. Best-effort by contract: reads verify-or-delete, writes
// swallow everything (quota included) — a run must never block on persistence.

const LRU_MAX_FILES = 4;
const LRU_MAX_BYTES = 1 << 30; // 1 GB

/** Dedicated-worker-only sync file API — absent from the bundled TS lib. */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

let gcDone = false;

/** `py/<buildHash>/`, GC'ing sibling stale-build dirs on first touch. */
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

export async function readSetSnapshot(buildHash: string, setKey: string): Promise<SetSnapshot | null> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await snapDir(buildHash);
  } catch {
    return null; // OPFS unavailable — snapshotless, never broken
  }
  const name = `${setKey}.snap`;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    const endRead = traceBegin('opfs-read');
    const bytes = new Uint8Array(await file.arrayBuffer());
    endRead({ mb: Math.round(bytes.length / 1e6) });
    return await decodeWrapper(bytes, buildHash, setKey);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
      console.warn(`py: dropping snapshot ${name} —`, err);
      await dir.removeEntry(name).catch(() => {});
    }
    return null;
  }
}

export async function writeSetSnapshot(buildHash: string, setKey: string, container: ArrayBuffer, tree: PackedTree): Promise<void> {
  try {
    const t0 = performance.now();
    const out = traceSpan('snap-encode', () => encodeWrapper(buildHash, setKey, new Uint8Array(container), tree));
    const endSeal = traceBegin('snap-seal-sha');
    out.set(await sha256(out.subarray(0, out.length - SHA_LEN)), out.length - SHA_LEN);
    endSeal({ mb: Math.round(out.length / 1e6) });
    const dir = await snapDir(buildHash);
    const handle = (await dir.getFileHandle(`${setKey}.snap`, { create: true })) as SyncFileHandle;
    // No temp+rename: a crash mid-write is a sha-trailer fail on the next read.
    const sync = await handle.createSyncAccessHandle();
    const endWrite = traceBegin('opfs-write');
    try {
      sync.truncate(0);
      sync.write(out, { at: 0 });
      sync.flush();
    } finally {
      sync.close();
    }
    endWrite({ mb: Math.round(out.length / 1e6) });
    console.warn(`py: persisted ${setKey}.snap (${(out.length / 1e6).toFixed(1)} MB, ${(performance.now() - t0).toFixed(0)} ms)`);
    await evictLru(dir);
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

async function evictLru(dir: FileSystemDirectoryHandle): Promise<void> {
  const entries: Array<{ name: string; size: number; mtime: number }> = [];
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file') continue;
    const f = await (handle as FileSystemFileHandle).getFile();
    entries.push({ name: handle.name, size: f.size, mtime: f.lastModified });
  }
  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  let count = entries.length;
  let bytes = entries.reduce((n, e) => n + e.size, 0);
  for (const e of entries) {
    if (count <= LRU_MAX_FILES && bytes <= LRU_MAX_BYTES) break;
    await dir.removeEntry(e.name).catch(() => {});
    count--;
    bytes -= e.size;
  }
}
