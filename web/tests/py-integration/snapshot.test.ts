// P2 owned snapshots over the L2 uniform boot, the standing exit gate:
// UNIFORM cold boot (shipped driver, headerP:null → deferred Module.callMain
// — THE cold-path equivalence probe) + mounts + bake → owned capture via the
// fork APIs → AVS2 assemble → sup-style verified read (readSnapshotToBuffer)
// → dirty-restore negative (heapP:null ⇒ DirtyRestoreError) → owned restore
// through the SHIPPED feeds driver (precompiled WebAssembly.Modules, exactly
// the executor's path) → extract-only remount → functional probes. The codec
// AND the driver are the SHIPPED web/src/core/py modules — this file only
// supplies an fd-backed SnapReadHandle where the supervisor supplies OPFS.
// Pure-codec negatives (xxh32 vectors, header-crc, abandoned-read) live in
// src/core/py/py-snapshot.test.ts — not duplicated here.
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPyodide, DirtyRestoreError, freeDsoFileData, type Pyodide, type PySnapshotFeeds } from '../../src/core/py/py-loader';
import { collectSoBytes, mountBundleTree, parseTarMeta } from '../../src/core/py/py-mount';
import {
  type AvsCaptureMeta,
  type AvsDsoInfo,
  type AvsHeader,
  encodeAvsHeaderBlock,
  parseAvsHeader,
  planAvsHeapOff,
  readSnapshotToBuffer,
  type SnapReadHandle,
  Xxh32,
} from '../../src/core/py/py-snapshot';
import { forkDir, LOCK, POST_RESTORE, readTar } from './helpers';

const SET_KEY = 'all';
const CHUNK = 8 << 20;
const LIVE = { live: () => true, abandoned: () => false };
const snapPath = join(tmpdir(), `avlo-py-integration-${process.pid}.snap`);

// Mirrors py-executor's BUNDLE_IMPORTS for the `all` set (numpy MUST bake
// numpy.random — G8R; mpl-deps has no top-level import).
const BAKE = `import numpy, numpy.random
_ = numpy.random.get_state()
del _
import dateutil
import pytz
import pandas
import matplotlib, matplotlib.pyplot
import seaborn
import gc
gc.collect()
gc.collect()`;

/** Uniform-boot feed bundles for the shipped driver (executor-shaped). */
const mkFeeds = ({
  header = null,
  heap = null,
  modules = null,
}: {
  header?: AvsHeader | null;
  heap?: ArrayBuffer | null;
  modules?: Promise<Map<string, WebAssembly.Module>> | null;
} = {}) => {
  const outcome = { restored: false };
  const invalids: string[] = [];
  const feeds: PySnapshotFeeds = {
    headerP: Promise.resolve(header),
    heapP: Promise.resolve(heap),
    modulesP: modules ?? Promise.resolve(null),
    onSnapInvalid: (reason) => invalids.push(reason),
    outcome,
  };
  return { feeds, outcome, invalids };
};

/** fd-backed SnapReadHandle — this suite's stand-in for the supervisor's
 * OPFS sync-access handle (same contract: positioned read, idempotent
 * close). The shipped parseAvsHeader/readSnapshotToBuffer consume it
 * verbatim. */
const mkSnapHandle = (fd: number, size: number): SnapReadHandle => {
  let closed = false;
  return {
    size,
    read: (view, at) => readSync(fd, view, 0, view.length, at),
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
};

interface SnapFlow {
  coldRestored: boolean;
  coldInvalids: string[];
  freedBytes: number;
  freedAborted: boolean;
  pin1: string;
  keysMatch: boolean;
  capMeta: AvsCaptureMeta;
  soBytes: Map<string, Uint8Array>;
  header: AvsHeader;
  heapBuffer: ArrayBuffer | null;
  corruptReadError: string | null;
  dirtyError: unknown;
  dirtyRestored: boolean;
  dirtyInvalids: string[];
  restoreRestored: boolean;
  restoreInvalids: string[];
  restoreTableLen: number;
  py2: Pyodide;
}
let S!: SnapFlow;

beforeAll(async () => {
  // Tars read once (de-pooled — walker nodes + soBytes alias these buffers,
  // exactly like the executor's transferred boot payloads).
  const bootTars = LOCK.sets[SET_KEY].map((bundle) => {
    const tar = readTar(bundle);
    return { tar, meta: parseTarMeta(tar) };
  });
  const soBytes = collectSoBytes(bootTars.map(({ tar, meta }) => ({ prefix: meta.prefix, bytes: tar.buffer as ArrayBuffer })));

  // ---- boot 1: UNIFORM cold boot (headerP:null → deferred Module.callMain,
  // the executor's exact cold+capture path) + mounts + bake + owned capture.
  const cold = mkFeeds();
  let py1: Pyodide | null = await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: cold.feeds });
  const coldRestored = cold.outcome.restored;
  const coldInvalids = [...cold.invalids];
  for (const { tar, meta } of bootTars) {
    mountBundleTree(py1.FS, meta.prefix, tar);
    for (const so of meta.loadOrder) await py1._api.loadDynlib(`${meta.prefix}/${so}`, false);
  }
  py1.runPython(POST_RESTORE);
  // Cold-boot file_data knife (executor order: after all dlopens, before the
  // bake — freed pages get reused by bake allocations, the capture shrinks).
  const { freedBytes, aborted: freedAborted } = freeDsoFileData(py1);
  py1.runPython(BAKE);
  const pin1 = py1.runPython(
    'import json, numpy\njson.dumps([int(x) for x in numpy.random.RandomState(42).randint(0, 1000, 6)])',
  ) as string;

  // Expected-keys: walk the LIVE hiwire table; on any mismatch dump it so a
  // future boot-sequence change re-derives 0008b in one command.
  const expected = py1._api.getExpectedKeys() as unknown[];
  const live: unknown[] = [];
  for (let i = 0; ; i++) {
    try {
      live.push(py1._module.__hiwire_get(i));
    } catch {
      break;
    }
  }
  const keysMatch = live.length === expected.length && live.every((v, i) => v === expected[i]);
  if (!keysMatch) {
    const api = py1._api as unknown as { public_api: unknown };
    const label = (v: unknown) =>
      v === null
        ? 'null'
        : v === api.public_api
          ? 'public_api'
          : v === py1?._api
            ? 'API'
            : typeof v === 'function'
              ? `function ${v.name || '<anon>'}`
              : Object.prototype.toString.call(v);
    console.error(`live hiwire table (${live.length} entries) vs getExpectedKeys (${expected.length}):`);
    for (let i = 0; i < Math.max(live.length, expected.length); i++) {
      console.error(`  [${i}] live=${label(live[i])}  expected=${label(expected[i])}`);
    }
  }

  const buildId = py1._api.config.BUILD_ID;
  if (!buildId) throw new Error('fork BUILD_ID missing from _api.config');
  const capMeta: AvsCaptureMeta = {
    dso: JSON.parse(JSON.stringify(py1._api.getDsoLoadInfo())) as AvsDsoInfo,
    dsoHandles: py1._api.recordDsoHandles(),
    hiwire: py1._api.serializeHiwireState(),
    buildId,
    tableLenAtCapture: py1._module.wasmTable.length,
    heapLen: py1._module.HEAP8.length,
  };

  // ---- AVS2 assemble → temp file via the SHIPPED codec (hash folded over
  // the LIVE heap, chunked — heap first at heapOff, header block last, the
  // same torn-write posture as writeSetSnapshot; the supervisor writes the
  // transferred slice instead of a live view, codec mechanics identical).
  const hx = new Xxh32();
  const heapU8 = new Uint8Array(py1._module.HEAP8.buffer, py1._module.HEAP8.byteOffset, capMeta.heapLen);
  for (let off = 0; off < capMeta.heapLen; off += CHUNK) hx.update(heapU8.subarray(off, Math.min(off + CHUNK, capMeta.heapLen)));
  const sized = {
    v: 2 as const,
    buildHash: LOCK.buildHash,
    setKey: SET_KEY,
    heapHash: { algo: 'xxh32' as const, value: hx.hex() },
    ...capMeta,
  };
  const heapOff = planAvsHeapOff(sized);
  const headerBlock = encodeAvsHeaderBlock(sized, heapOff);
  {
    const wfd = openSync(snapPath, 'w');
    for (let off = 0; off < capMeta.heapLen; off += CHUNK) {
      const n = Math.min(CHUNK, capMeta.heapLen - off);
      writeSync(wfd, heapU8.subarray(off, off + n), 0, n, heapOff + off);
    }
    writeSync(wfd, headerBlock, 0, headerBlock.length, 0);
    closeSync(wfd);
  }
  const fileSize = heapOff + capMeta.heapLen;
  py1 = null; // release boot-1 heap before boot 2 (two ~200 MB images otherwise)

  // ---- decode/validate via the shipped parser + SUP-side reader over fd
  // handles (hash verdicts are pre-transfer, exactly the supervisor's shape).
  const handle = mkSnapHandle(openSync(snapPath, 'r'), fileSize);
  const header = parseAvsHeader(handle, { buildHash: LOCK.buildHash, setKey: SET_KEY });
  const heapBuffer = await readSnapshotToBuffer(handle, header, LIVE);
  handle.close();

  // Corrupt-byte negative at the READ layer: a decorated handle flips one
  // byte inside the heap segment — the fused hash must refuse.
  let corruptReadError: string | null = null;
  {
    const inner = mkSnapHandle(openSync(snapPath, 'r'), fileSize);
    const corruptAt = header.heapOff + 4096;
    const corrupting: SnapReadHandle = {
      size: inner.size,
      read: (view, at) => {
        const n = inner.read(view, at);
        if (corruptAt >= at && corruptAt < at + n) view[corruptAt - at] ^= 0xff;
        return n;
      },
      close: inner.close,
    };
    try {
      await readSnapshotToBuffer(corrupting, header, LIVE);
    } catch (e) {
      corruptReadError = String((e as Error).message);
    }
    corrupting.close();
  }

  // ---- DSO precompile (executor-shaped): the 4 group Modules compile once
  // and serve BOTH the dirty-restore negative and the real restore — proving
  // precompiled-Module replay end-to-end (the 0005 union widening).
  const modulesP = (async () => {
    const pairs = await Promise.all(
      header.dso.loadOrder.map(
        async (p): Promise<[string, WebAssembly.Module]> => [p, await WebAssembly.compile(soBytes.get(p) as Uint8Array<ArrayBuffer>)],
      ),
    );
    return new Map(pairs);
  })();

  // ---- dirty-restore negative: heapP resolves null AFTER a successful
  // replay → the mutation zone must throw DirtyRestoreError (same-Module
  // cold is forbidden — the executor re-instantiates fresh on this class),
  // and onSnapInvalid must NOT fire (that channel is pre-mutation only).
  const dirty = mkFeeds({ header, heap: null, modules: modulesP });
  let dirtyError: unknown = null;
  try {
    await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: dirty.feeds });
  } catch (e) {
    dirtyError = e;
  }

  // ---- boot 2: owned restore through the SHIPPED feeds driver (py-loader's
  // bootPyodide → makePreBlit — the exact executor restore path: precompiled
  // Modules, verified transferred buffer, pre-touch loop). The per-DSO
  // tableBase assert lives in the emsdk dsoBaseHook (drift throws inside the
  // replay), so a successful boot IS the post-instantiate probe.
  const restore = mkFeeds({ header, heap: heapBuffer, modules: modulesP });
  const py2 = await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: restore.feeds });

  // Extract-only remount (files for lazy imports + post-restore C dlopens;
  // dlopen SKIPPED — the replay already registered the groups in LDSO).
  for (const { tar, meta } of bootTars) mountBundleTree(py2.FS, meta.prefix, tar);
  py2.runPython(POST_RESTORE);

  S = {
    coldRestored,
    coldInvalids,
    freedBytes,
    freedAborted,
    pin1,
    keysMatch,
    capMeta,
    soBytes,
    header,
    heapBuffer,
    corruptReadError,
    dirtyError,
    dirtyRestored: dirty.outcome.restored,
    dirtyInvalids: [...dirty.invalids],
    restoreRestored: restore.outcome.restored,
    restoreInvalids: [...restore.invalids],
    restoreTableLen: py2._module.wasmTable.length,
    py2,
  };
});

afterAll(() => {
  rmSync(snapPath, { force: true });
});

describe('capture over the uniform cold boot', () => {
  it('uniform cold boot: cold outcome, zero snap-invalids', () => {
    expect(S.coldRestored).toBe(false);
    expect(S.coldInvalids).toEqual([]);
  });
  it('dso-free knife freed the group ELF copies (>8 MB, no abort)', () => {
    expect(S.freedAborted).toBe(false);
    expect(S.freedBytes).toBeGreaterThan(8 << 20);
  });
  it('0008b: live hiwire table == getExpectedKeys (identity + count)', () => {
    expect(S.keysMatch).toBe(true);
  });
  it('capture: 4 grouped DSOs recorded', () => {
    expect(S.capMeta.dso.loadOrder).toHaveLength(4);
  });
  it('capture: hiwireKeys empty at the pre-harden point', () => {
    expect((S.capMeta.hiwire as { hiwireKeys: unknown[] }).hiwireKeys).toHaveLength(0);
  });
  it('capture: every loadOrder path has tar bytes', () => {
    expect(S.capMeta.dso.loadOrder.filter((p) => !S.soBytes.has(p))).toEqual([]);
  });
});

describe('sup-style verified read', () => {
  it('avs2 header parses + cross-checks against the real capture file', () => {
    expect(S.header.heapLen).toBe(S.capMeta.heapLen);
    expect(S.header.tableLenAtCapture).toBe(S.capMeta.tableLenAtCapture);
  });
  it('verified heap buffer lands (fused hash, exact length)', () => {
    expect(S.heapBuffer).not.toBeNull();
    expect(S.heapBuffer?.byteLength).toBe(S.header.heapLen);
  });
  it('corrupt heap byte fails the fused hash', () => {
    expect(S.corruptReadError).toContain('hash mismatch');
  });
});

describe('dirty-restore negative', () => {
  it('heapP:null after replay → DirtyRestoreError', () => {
    expect(S.dirtyError).toBeInstanceOf(DirtyRestoreError);
  });
  it('outcome stays cold, no pre-mutation snap-invalid', () => {
    expect(S.dirtyRestored).toBe(false);
    expect(S.dirtyInvalids).toEqual([]);
  });
});

describe('owned restore through the shipped feeds driver', () => {
  it('outcome.restored true (blit landed), zero snap-invalids', () => {
    expect(S.restoreRestored).toBe(true);
    expect(S.restoreInvalids).toEqual([]);
  });
  it('post-replay table length == tableLenAtCapture', () => {
    expect(S.restoreTableLen).toBe(S.header.tableLenAtCapture);
  });
  it('numpy usable', () => {
    expect(S.py2.runPython('import json, numpy\njson.dumps(float(numpy.ones(4).sum()))')).toBe('4.0');
  });
  it('corpus-class RandomState(42) stream matches the capture boot', () => {
    const pin2 = S.py2.runPython(
      'import json, numpy\njson.dumps([int(x) for x in numpy.random.RandomState(42).randint(0, 1000, 6)])',
    ) as string;
    expect(pin2).toBe(S.pin1);
  });
  it('pandas usable', () => {
    const out = S.py2.runPython(
      "import json, pandas as pd\njson.dumps(float(pd.DataFrame({'g': ['a', 'a', 'b'], 'x': [1.0, 2.0, 3.5]}).groupby('g')['x'].sum().sum()))",
    );
    expect(out).toBe('6.5');
  });
  it('lazy matplotlib._tri import works and is an LDSO registry hit (no table growth)', () => {
    const tblBefore = S.py2._module.wasmTable.length;
    expect(S.py2.runPython('import json, matplotlib._tri\njson.dumps(type(matplotlib._tri).__name__)')).toBe('"module"');
    expect(S.py2._module.wasmTable.length).toBe(tblBefore);
  });
  it('ctypes tombstone precise on the restored generation', () => {
    const out = S.py2.runPython(
      "import json\ntry:\n    import ctypes\n    _r = 'imported'\nexcept BaseException as _e:\n    _r = f'{type(_e).__name__}: {_e}'\njson.dumps(_r)",
    ) as string;
    expect(out).toMatch(/ModuleNotFoundError/);
    expect(out).toMatch(/ctypes/);
  });
  it('blit reset clears run globals and numpy stays alive (the executor per-run reset)', () => {
    const img = S.py2._module.HEAP8.slice();
    S.py2.runPython('leak_probe = 12345');
    S.py2._module.HEAP8.set(img);
    expect(S.py2.runPython("import json\njson.dumps('leak_probe' in globals())")).toBe('false');
    expect(S.py2.runPython('import json, numpy\njson.dumps(float(numpy.ones(3).sum()))')).toBe('3.0');
  });
});
