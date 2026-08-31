// L1 walker equivalence, the STANDING gate: boot 1 mounts all bundles via the
// in-wasm `tarfile.extractall(filter='data')` REFERENCE (the pre-walker mount
// path, re-enacted here and only here), dumps the full live MEMFS tree; boot 2
// mounts via the SHIPPED walker (py-mount.mountBundleTree) and must dump a
// ZERO-DIFF tree — every path, type, mode, mtime-sec, size, and content xxh32
// (dir mtimes out of scope: both paths leave them wall-clock). This theorem is
// what lets py-build's pytest corpus lane mount python-side and still speak
// for the shipped walker. Sequential boots with an explicit release between
// (9 GB host — never two live `all` images at once).
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pyodide } from '../../src/core/py/py-loader';
import { mountBundleTree, parseTarMeta } from '../../src/core/py/py-mount';
import { Xxh32 } from '../../src/core/py/py-snapshot';
import { BOOT_ENV, forkDir, LOCK, loadFork, readTar } from './helpers';

const S_IFDIR = 0o040000;
const hashOf = (u8: Uint8Array): string => {
  const x = new Xxh32();
  x.update(u8);
  return x.hex();
};

interface TreeEntry {
  t: 'd' | 'f';
  mode: number;
  mt?: number;
  size?: number;
  h?: string;
}
interface MemfsNode {
  mode: number;
  mtime: number;
  usedBytes: number;
  contents: Record<string, MemfsNode> | Uint8Array | null;
}

/** Full live-tree manifest — walks the node graph directly; byte views are
 * rebuilt via (buffer, byteOffset, usedBytes) so copies AND adopted
 * subarrays read identically. Files: {t,mode,mt,size,h}; dirs: {t,mode}. */
const dumpTree = (py: Pyodide, prefixes: readonly string[]): Record<string, TreeEntry> => {
  const out: Record<string, TreeEntry> = {};
  const walk = (node: MemfsNode, path: string): void => {
    for (const [name, child] of Object.entries(node.contents as Record<string, MemfsNode>)) {
      const p = `${path}/${name}`;
      if ((child.mode & 0o170000) === S_IFDIR) {
        out[p] = { t: 'd', mode: child.mode & 0o7777 };
        walk(child, p);
      } else {
        const contents = child.contents as Uint8Array | null;
        const bytes = contents ? new Uint8Array(contents.buffer, contents.byteOffset, child.usedBytes) : new Uint8Array(0);
        out[p] = { t: 'f', mode: child.mode & 0o7777, mt: Math.floor(child.mtime / 1000), size: child.usedBytes, h: hashOf(bytes) };
      }
    }
  };
  for (const prefix of prefixes) {
    if (!(prefix in out)) {
      const rootNode = (py.FS as unknown as { lookupPath(p: string): { node: MemfsNode } }).lookupPath(prefix).node;
      out[prefix] = { t: 'd', mode: rootNode.mode & 0o7777 };
      walk(rootNode, prefix);
    }
  }
  return out;
};

let ref!: Record<string, TreeEntry>;
let got!: Record<string, TreeEntry>;
let py!: Pyodide;
let prefixes!: string[];
let bundleCount = 0;

beforeAll(async () => {
  const parityTars = LOCK.sets.all.map((bundle) => {
    const tar = readTar(bundle);
    return { tar, meta: parseTarMeta(tar) };
  });
  bundleCount = parityTars.length;
  prefixes = [...new Set(parityTars.map(({ meta }) => meta.prefix))];
  const { loadPyodide } = await loadFork();

  // ---- boot 1: the tarfile reference re-enactment
  let py1: Pyodide | null = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });
  for (const { tar, meta } of parityTars) {
    py1.FS.writeFile('/tmp/_avlo_bundle.tar', tar);
    py1.runPython(`import os, tarfile
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(meta.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t`);
  }
  ref = dumpTree(py1, prefixes);
  py1 = null; // release boot-1 heap before boot 2

  // ---- boot 2: the shipped walker
  py = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });
  for (const { tar, meta } of parityTars) mountBundleTree(py.FS, meta.prefix, tar);
  got = dumpTree(py, prefixes);
});

describe('walker ≡ tarfile', () => {
  it('zero-diff tree over all bundles (path/type/mode/mtime/size/content-hash)', () => {
    const refKeys = Object.keys(ref);
    const missing = refKeys.filter((k) => !(k in got));
    const extra = Object.keys(got).filter((k) => !(k in ref));
    const diffs: string[] = [];
    for (const k of refKeys) {
      if (!(k in got)) continue;
      for (const f of ['t', 'mode', 'mt', 'size', 'h'] as const) {
        if (ref[k][f] !== got[k][f]) diffs.push(`${k}: ${f} ${ref[k][f]} → ${got[k][f]}`);
      }
    }
    expect(missing, `missing from walker mount (of ${bundleCount} bundles)`).toEqual([]);
    expect(extra, 'extra in walker mount').toEqual([]);
    expect(diffs.slice(0, 12), `${diffs.length} field diffs`).toEqual([]);
  });
  it('parity tree is non-trivial', () => {
    expect(Object.keys(ref).length).toBeGreaterThan(1000);
  });
  it('walker probes: listdir/open/stat/import/tz all live on the walker-mounted boot', () => {
    const probe = JSON.parse(
      py.runPython(`
import os, json
p = ${JSON.stringify(prefixes[0])}
tz = open(p + '/pytz/__init__.pyc', 'rb').read()
st = os.stat(p + '/pytz/zoneinfo/UTC')
json.dumps({
  'listdir': len(os.listdir(p)),
  'pytzInitLen': len(tz),
  'utcSize': st.st_size,
  'importOk': __import__('dateutil') is not None and __import__('pytz') is not None,
  'tzProbe': __import__('pytz').timezone('Europe/Paris').zone,
})
`) as string,
    ) as { listdir: number; pytzInitLen: number; utcSize: number; importOk: boolean; tzProbe: string };
    expect(probe.listdir).toBeGreaterThan(0);
    expect(probe.pytzInitLen).toBeGreaterThan(0);
    expect(probe.utcSize).toBeGreaterThan(0);
    expect(probe.importOk).toBe(true);
    expect(probe.tzProbe).toBe('Europe/Paris');
  });
});
