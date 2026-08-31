/**
 * Bundle-tar walking + direct-node MEMFS mounting — the single home for every
 * ustar consumer (executor mounts, DSO byte collection, supervisor/test-suite
 * meta parsing). Dependency-FREE by design: no py-trace (callers wrap
 * spans), no protocol imports — the web py-integration suite imports this
 * exact shipped module (py-build's pytest corpus lane mounts pure-python
 * instead, equivalent by the parity gate below).
 *
 * Why a JS walker instead of in-wasm `tarfile.extractall` (the pre-L1 path):
 * the Python route costs ~855 ms for the `all` set (tar→MEMFS copy, tarfile
 * header objects, per-file open/write/close through the FS syscall layer);
 * grafting nodes directly into MEMFS via parent NODE references costs ~11 ms
 * with byte-identical results (docs(local)/ColdRestoreAttack.md §3; bench
 * strategy D — full-tree parity over all entries: path/type/mode/mtime/size/
 * xxh32 vs the real `tarfile.extractall(filter='data')`). The py-integration
 * `mount-parity.test.ts` gate re-proves that equivalence on every run.
 *
 * Tar-shape contract (packlib.write_tar, enforced build-side): USTAR_FORMAT,
 * files only (typeflag '0' — the walker THROWS on anything else), names ≤ 100
 * chars ASCII (isascii pre-checked at pack time), meta.json FIRST, fixed
 * mtime, mode 0644, uid/gid 0. The ustar `prefix` field @345 is read anyway
 * (empty in every live entry — costs nothing, buys headroom).
 *
 * Emscripten-glue facts the walker relies on (verified against the shipped
 * fork glue):
 * - `FS.filesystems.MEMFS` is reachable; `MEMFS.createNode` delegates to
 *   `FS.createNode` → `FS.hashAddNode` (nameTable insert done for us) and
 *   itself sets `parent.contents[name] = node` + stamps parent/node times —
 *   the walker must duplicate neither.
 * - Nodes carry split `atime`/`mtime`/`ctime` ms fields (this glue has NO
 *   `node.timestamp` — that's pre-3.1.45 emscripten).
 * - `MEMFS.node_ops.lookup` always throws — the nameTable is the only lookup
 *   path, so probing `parent.contents` for dir reuse is safe and REQUIRED:
 *   all bundles share the site-packages prefix and several create `.avlo/`;
 *   re-creating an existing dir node would orphan its children (the one bug
 *   the bench parity diff caught).
 *
 * Adoption aliasing (accepted): file `contents` are subarray VIEWS over the
 * caller's tar buffer, so a Python in-place write ≤ usedBytes to a mounted
 * file would scribble into that file's own region of the shared buffer —
 * bounds-limited to its own bytes, and nothing writes to site-packages files
 * (pycache lands as NEW nodes; the mpl config dir is `/home/pyodide`). Same
 * class as the files-survive-blit residual; WasmFS is the structural fix.
 */

// ---------------------------------------------------------------- ustar walk

export interface TarEntry {
  /** Full member path (ustar prefix field joined if ever non-empty). */
  name: string;
  /** Absolute payload offset into the tar buffer. */
  off: number;
  size: number;
  mode: number;
  /** Seconds since epoch (raw octal field). */
  mtime: number;
}

/** Octal field parse — breaks on NUL/space terminators (ustar padding). */
export function octal(u8: Uint8Array, off: number, len: number): number {
  let v = 0;
  for (let i = off; i < off + len; i++) {
    const c = u8[i];
    if (c === 0 || c === 32) break;
    v = v * 8 + (c - 48);
  }
  return v;
}

/** NUL-terminated ASCII field — charCode loop (walker names are ASCII-only,
 * enforced at pack time; TextDecoder would cost an object per call). */
export function asciiName(u8: Uint8Array, off: number, max: number): string {
  let end = off;
  const lim = off + max;
  while (end < lim && u8[end] !== 0) end++;
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/** Walk a bundle ustar → regular-file entries (meta.json skipped by name —
 * its header is still consumed and the offset advanced). EOF on a NUL block.
 * Typeflag MUST be '0'/NUL (regular file) — anything else throws: these tars
 * carry no dir/link/pax entries by construction, and the walker is only
 * parity-proven over that shape. */
export function walkTar(u8: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= u8.length) {
    if (u8[off] === 0) break;
    const type = u8[off + 156];
    if (type !== 48 && type !== 0) throw new Error(`unexpected tar typeflag ${type} at ${off}`);
    const prefix = asciiName(u8, off + 345, 155);
    const name0 = asciiName(u8, off, 100);
    const name = prefix ? `${prefix}/${name0}` : name0;
    const size = octal(u8, off + 124, 12);
    if (name !== 'meta.json') {
      entries.push({ name, off: off + 512, size, mode: octal(u8, off + 100, 8), mtime: octal(u8, off + 136, 12) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** `tarfile.extractall(filter='data')` mode transform for regular files
 * (PEP 706): drop setuid/setgid/sticky, drop x-bits unless owner-executable,
 * force owner rw. All live headers are 0644 ⇒ identity today — parsed
 * per-entry anyway so a future pack change can't silently break parity. */
export function dataFilterMode(mode: number): number {
  let m = mode & 0o7777 & ~0o7000;
  if (!(m & 0o100)) m &= ~0o111;
  return m | 0o600;
}

// ------------------------------------------------------------------ tar meta

/** Every path from a tar meta may only address INTO its mount root. */
const safePathSegs = (p: string): boolean => p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

/** meta.json is the FIRST ustar entry by construction (pack-package D2).
 * The tar is sha-pinned by the build-lock before this runs; the path checks
 * guard the remaining trust link — a bad meta minted by the BUILD side would
 * otherwise steer MEMFS mounting/dlopen outside the mount root. */
export function parseTarMeta(bytes: Uint8Array): { prefix: string; loadOrder: readonly string[] } {
  if (asciiName(bytes, 0, 100) !== 'meta.json') throw new Error('bundle tar: first entry is not meta.json');
  const size = octal(bytes, 124, 12);
  if (!Number.isInteger(size) || size <= 0 || size > 65_536) throw new Error('bundle tar: implausible meta.json size');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(512, 512 + size))) as {
    prefix?: unknown;
    loadOrder?: unknown;
  };
  const { prefix, loadOrder } = meta;
  if (typeof prefix !== 'string' || !prefix.startsWith('/') || !safePathSegs(prefix.slice(1))) {
    throw new Error(`bundle tar: unsafe prefix ${JSON.stringify(prefix)}`);
  }
  if (!Array.isArray(loadOrder) || !loadOrder.every((s): s is string => typeof s === 'string' && safePathSegs(s))) {
    throw new Error('bundle tar: unsafe loadOrder');
  }
  return { prefix, loadOrder: Object.freeze([...loadOrder]) };
}

// ---------------------------------------------------------------- DSO bytes

/** Map every `.so` member of the boot tars to its recorded ABSOLUTE dlopen
 * path (`bundle.prefix + '/' + member` — the exact string mountBundle dlopens
 * and the emsdk hook records, U7). DSO replay consumes bytes straight out of
 * the transferred tar buffers (subarray views) — no FS involvement pre-blit. */
export function collectSoBytes(bundles: ReadonlyArray<{ prefix: string; bytes: ArrayBuffer }>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const b of bundles) {
    const tar = new Uint8Array(b.bytes);
    for (const e of walkTar(tar)) {
      if (e.name.endsWith('.so')) out.set(`${b.prefix}/${e.name}`, tar.subarray(e.off, e.off + e.size));
    }
  }
  return out;
}

// ------------------------------------------------------------ direct mounter

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

// biome-ignore lint/suspicious/noExplicitAny: live emscripten FS — no types in-app
type EmscriptenFS = any;

/** Graft one bundle tar's tree directly into MEMFS: per-file
 * `MEMFS.createNode` via parent NODE references (zero path lookups), contents
 * adopted as tar subarray views (zero copies), times/mode stamped to match
 * the `tarfile.extractall(filter='data')` reference byte-for-byte
 * (py-integration `mount-parity.test.ts` is the standing gate). Node-side
 * callers MUST de-pool
 * `readFileSync` Buffers (`.buffer.slice()`) before adoption or the whole
 * ~8 MB pool stays alive per node; browser-side transferred buffers arrive
 * exact-size. */
export function mountBundleTree(FS: EmscriptenFS, prefix: string, tar: Uint8Array): void {
  const MEMFS = FS.filesystems.MEMFS;
  FS.mkdirTree(prefix); // idempotent; installStdlib already made site-packages
  const root = FS.lookupPath(prefix).node;
  const dirNodes = new Map<string, unknown>([['', root]]);
  // biome-ignore lint/suspicious/noExplicitAny: live MEMFS node graph
  const ensureDirNode = (p: string): any => {
    let node = dirNodes.get(p);
    if (node) return node;
    const slash = p.lastIndexOf('/');
    const parent = ensureDirNode(slash < 0 ? '' : p.slice(0, slash));
    const name = slash < 0 ? p : p.slice(slash + 1);
    // Reuse a dir another bundle already created (shared prefixes like
    // `.avlo/`) — re-creating would orphan its existing children.
    node = parent.contents[name] ?? MEMFS.createNode(parent, name, S_IFDIR | 0o777, 0);
    dirNodes.set(p, node);
    return node;
  };
  for (const e of walkTar(tar)) {
    const slash = e.name.lastIndexOf('/');
    const parent = ensureDirNode(slash < 0 ? '' : e.name.slice(0, slash));
    const node = MEMFS.createNode(parent, slash < 0 ? e.name : e.name.slice(slash + 1), S_IFREG | dataFilterMode(e.mode), 0);
    node.contents = tar.subarray(e.off, e.off + e.size);
    node.usedBytes = e.size;
    node.atime = node.mtime = node.ctime = e.mtime * 1000;
  }
}
