// Shared plumbing for the py-integration suite. Everything under test is the
// SHIPPED web/src/core/py code (imported directly — vitest resolves the TS)
// driven against the REAL staged artifacts in web/public/py-dev/fork.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILD_LOCK, matchesLockEntry } from '@avlo/py-loader';
import * as harden from '../../src/core/py/py-harden';
import { HARNESS_INSTALL, RUN_INVOKE } from '../../src/core/py/py-harness';
import type { Pyodide } from '../../src/core/py/py-loader';
import { mountBundleTree, parseTarMeta } from '../../src/core/py/py-mount';

export const LOCK = BUILD_LOCK;
export const forkDir = fileURLToPath(new URL('../../public/py-dev/fork', import.meta.url));
export const BOOT_ENV = { PYTHONHASHSEED: '0', HOME: '/home/pyodide' };

/** readFileSync Buffers ride a pooled ArrayBuffer — copy to a tight one. */
export const asArrayBuffer = (buf: Uint8Array): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

/** De-pooled tar bytes — adoption-safe (walker nodes alias the buffer; a
 * pooled Buffer would pin the whole ~8 MB pool) and exact-size like the
 * executor's transferred buffers. */
export const readTar = (bundle: string): Uint8Array => new Uint8Array(asArrayBuffer(readFileSync(join(forkDir, `bundles/${bundle}.tar`))));

interface ForkModule {
  loadPyodide(opts: { indexURL: string; stdLibURL?: string; packages: readonly string[]; env: Record<string, string> }): Promise<Pyodide>;
}

/** The staged fork glue — a runtime artifact, not a module in this graph. */
export const loadFork = async (): Promise<ForkModule> =>
  (await import(/* @vite-ignore */ pathToFileURL(join(forkDir, 'pyodide.mjs')).href)) as ForkModule;

/** Mirrors py-executor.ts: post_restore (reseed + cache drop + tz bridge)
 * runs after mounts, before user code. */
export const POST_RESTORE = 'import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime';

export interface RunResult {
  ok: boolean;
  interrupted: boolean;
  figures: readonly (readonly [string, number, number])[];
  output: string;
}

export interface HardenedBoot {
  pyodide: Pyodide;
  run: (code: string) => RunResult;
  /** bundle → its staged tar matched the committed lock. */
  tarLockOk: Readonly<Record<string, boolean>>;
  /** stdlib zip hashed AS MOUNTED in MEMFS == the committed lock sha. */
  stdlibHashOk: boolean;
  /** wasmTable.get crossings over 10k METH_NOARGS calls (trampoline census). */
  trampolineCrossings: number;
  /** null = assertRealmHardened passed on the clean hardened realm. */
  hardenGateError: string | null;
}

/** Executor-shaped boot: fork + the set's tars (lock order) + stdlib verify +
 * tz bridge + scrub/harden/assert + harness install — the exact
 * py-executor.ts boot order. Boot-time gate outcomes are recorded on the
 * returned struct; the caller asserts them as named tests. */
export async function bootHardened(setKey: string): Promise<HardenedBoot> {
  const { loadPyodide } = await loadFork();
  const pyodide = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });

  const tarLockOk: Record<string, boolean> = {};
  for (const bundle of LOCK.sets[setKey]) {
    const tar = readTar(bundle);
    tarLockOk[bundle] = await matchesLockEntry(asArrayBuffer(tar), LOCK.bundles[bundle]);
    const meta = parseTarMeta(tar);
    mountBundleTree(pyodide.FS, meta.prefix, tar);
    for (const so of meta.loadOrder) await pyodide._api.loadDynlib(`${meta.prefix}/${so}`, false);
  }

  // verifyStdlibZip semantics: hash AS MOUNTED vs the committed lock.
  const zipPath = pyodide.runPython("import sys; next(p for p in sys.path if p.endswith('.zip'))") as string;
  const mounted = pyodide.FS.readFile(zipPath);
  const stdlibHashOk = await matchesLockEntry(asArrayBuffer(mounted), LOCK.artifacts['python_stdlib.zip']);

  pyodide.runPython(POST_RESTORE);

  // Wasm-gc trampoline census (runs pre-harden — Table.prototype freezes
  // later): with the trampoline live, METH_NOARGS calls stay in wasm, so a
  // 10k-call loop crosses into JS ~0 times. The regression mode this guards
  // (MAIN_MODULE=2 never extracting emscripten_trampoline_wasm.o) measured
  // ~10.4k crossings: one _PyEM_TrampolineCall_JS per call. Companion gate:
  // `avlo-build stage`'s getWasmTrampolineModule glue grep.
  const table = pyodide._module.wasmTable as WebAssembly.Table & { get(i: number): unknown };
  const origGet = table.get;
  let trampolineCrossings = 0;
  Object.defineProperty(table, 'get', {
    value: (...a: [number]) => {
      trampolineCrossings++;
      return origGet.apply(table, a);
    },
    configurable: true,
    writable: true,
  });
  pyodide.runPython('q=(1234567890).bit_length\nfor _ in range(10000): q()\ndel q');
  delete (table as { get?: unknown }).get;

  harden.scrubWorkerScope();
  harden.hardenRealm();
  let hardenGateError: string | null = null;
  try {
    harden.assertRealmHardened();
  } catch (e) {
    hardenGateError = String((e as Error).message);
  }

  let outBuf = '';
  let stdoutDecoder = new TextDecoder();
  let stderrDecoder = new TextDecoder();
  pyodide.setStdout({
    write: (buf: Uint8Array) => {
      outBuf += stdoutDecoder.decode(buf, { stream: true });
      return buf.length;
    },
    isatty: false,
  });
  pyodide.setStderr({
    write: (buf: Uint8Array) => {
      outBuf += stderrDecoder.decode(buf, { stream: true });
      return buf.length;
    },
    isatty: false,
  });
  pyodide.setInterruptBuffer(new Uint8Array(new SharedArrayBuffer(64))); // post-freeze API liveness
  pyodide.runPython(HARNESS_INSTALL);

  const run = (code: string): RunResult => {
    outBuf = '';
    stdoutDecoder = new TextDecoder();
    stderrDecoder = new TextDecoder();
    pyodide.globals.set('_avlo_code', code);
    const res = JSON.parse(pyodide.runPython(RUN_INVOKE) as string) as Omit<RunResult, 'output'>;
    return { ...res, output: outBuf };
  };
  return { pyodide, run, tarLockOk, stdlibHashOk, trampolineCrossings, hardenGateError };
}

/** PNG signature + IHDR dims. Dims-only by design — pixel-QUALITY asserts
 * live host-side (pillow) in py-build's pytest corpus lane; this suite only
 * checks the harvest protocol's dims contract. */
export function pngDims(bytes: Uint8Array): { width: number; height: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !sig.every((b, i) => bytes[i] === b)) throw new Error('bad PNG signature');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}
