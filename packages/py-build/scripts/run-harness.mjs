#!/usr/bin/env node
// Node verification harness — boots the REAL staged fork, mounts the REAL
// bundle tars, then applies the SHIPPED web/src/core/py/py-harden.ts (scrub +
// freeze + fail-closed gate) and the SHIPPED py-harness.ts, and drives
// executor-shaped runs through them. Mirrors py-executor.ts boot order:
//   boot → mounts (set order) → verifyStdlibZip → tz bridge → scrub → harden
//   → ASSERT → harness install.
// Committed (formerly a per-session scratchpad — sessions 5/6/7 boards) so
// every harden/verify change re-runs the full board. NOT wired into
// Turbo/CI: needs staged artifacts (`pnpm run stage`) and Node ≥ 23.6
// (native type-stripping imports the shipped TS directly).
//
//   pnpm harness            all sections (base / seaborn / snapshot / parity / verify children)
//   node scripts/run-harness.mjs --section base|seaborn|snapshot|parity|verify
import './lib/ts-resolve.mjs'; // FIRST: Node ≥23.6 guard + `.ts` resolve shim for shipped-module imports
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkgRoot, '../..');
const forkDir = join(repo, 'web/public/py-dev/fork');
const LOCK = JSON.parse(readFileSync(join(repo, 'packages/py-loader/build-lock.json'), 'utf8'));

const args = process.argv.slice(2);
const section = (() => {
  const i = args.indexOf('--section');
  return i >= 0 ? args[i + 1] : null;
})();

// ---------------------------------------------------------------- parent
if (!section) {
  // Sections run in a 2-wide pool (each child boots a full fork — RAM-bound on
  // the ~9 GB WSL2 box; 5-wide would thrash). Output is buffered per child and
  // printed on completion so interleaving can't scramble the PASS/FAIL lines.
  const SECTIONS = ['base', 'seaborn', 'snapshot', 'parity', 'verify'];
  const WIDTH = 2;
  const runSection = (s) =>
    new Promise((resolveDone) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--section', s], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = [];
      child.stdout.on('data', (d) => chunks.push(d));
      child.stderr.on('data', (d) => chunks.push(d));
      child.on('close', (code) => {
        console.log(`\n=== section ${s} ===`);
        process.stdout.write(Buffer.concat(chunks));
        resolveDone(code === 0 ? 0 : 1);
      });
    });
  let failed = 0;
  const queue = [...SECTIONS];
  await Promise.all(
    Array.from({ length: WIDTH }, async () => {
      for (let s = queue.shift(); s !== undefined; s = queue.shift()) failed += await runSection(s);
    }),
  );
  console.log(failed ? `\nharness: ${failed} section(s) FAILED` : '\nharness: all sections pass');
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- shared
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const finish = () => {
  console.log(`${section}: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
};

const harden = await import(pathToFileURL(join(repo, 'web/src/core/py/py-harden.ts')).href);
const { matchesLockEntry } = await import(pathToFileURL(join(repo, 'packages/py-loader/src/verify.ts')).href);
// The SHIPPED tar walker + direct-node mounter — the exact module the
// executor/supervisor run (single home; the old per-script copies are gone).
const { mountBundleTree, parseTarMeta, collectSoBytes } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-mount.ts')).href);

/** readFileSync Buffers ride a pooled ArrayBuffer — copy to a tight one. */
const asArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/** De-pooled tar bytes — adoption-safe (walker nodes alias the buffer; a
 * pooled Buffer would pin the whole ~8 MB pool) and exact-size like the
 * executor's transferred buffers. */
const readTar = (bundle) => new Uint8Array(asArrayBuffer(readFileSync(join(forkDir, `bundles/${bundle}.tar`))));

/** Executor-shaped boot: fork + the set's tars (lock order) + stdlib verify +
 * tz bridge + scrub/harden/assert + harness install. Returns { pyodide, run }. */
async function bootHardened(setKey) {
  const { HARNESS_INSTALL, RUN_INVOKE } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-harness.ts')).href);
  const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
  const pyodide = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });

  for (const bundle of LOCK.sets[setKey]) {
    const tar = readTar(bundle);
    check(`${bundle}.tar matches the committed lock`, await matchesLockEntry(tar.buffer, LOCK.bundles[bundle]));
    const meta = parseTarMeta(tar);
    mountBundleTree(pyodide.FS, meta.prefix, tar);
    for (const so of meta.loadOrder) await pyodide._api.loadDynlib(`${meta.prefix}/${so}`);
  }

  // verifyStdlibZip semantics: hash AS MOUNTED vs the committed lock.
  const zipPath = pyodide.runPython("import sys; next(p for p in sys.path if p.endswith('.zip'))");
  const mounted = pyodide.FS.readFile(zipPath);
  check(
    'stdlib MEMFS hash == lock sha',
    await matchesLockEntry(
      mounted.buffer.slice(mounted.byteOffset, mounted.byteOffset + mounted.byteLength),
      LOCK.artifacts['python_stdlib.zip'],
    ),
  );

  // Mirrors py-executor.ts boot exactly: post_restore (reseed + cache drop +
  // tz bridge) replaced ensure_tzpath at P3.
  pyodide.runPython('import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime');

  // Wasm-gc trampoline census (runs pre-harden — Table.prototype freezes
  // later): with the trampoline live, METH_NOARGS calls stay in wasm, so a
  // 10k-call loop crosses into JS ~0 times. The regression mode this guards
  // (MAIN_MODULE=2 never extracting emscripten_trampoline_wasm.o — dead from
  // P1 until 2026-08) measured ~10.4k crossings: one _PyEM_TrampolineCall_JS
  // per call. Companion gate: stage.mjs's getWasmTrampolineModule glue grep.
  {
    const table = pyodide._module.wasmTable;
    const origGet = table.get;
    let crossings = 0;
    Object.defineProperty(table, 'get', {
      value: (...a) => {
        crossings++;
        return origGet.apply(table, a);
      },
      configurable: true,
      writable: true,
    });
    pyodide.runPython('q=(1234567890).bit_length\nfor _ in range(10000): q()\ndel q');
    delete table.get;
    check(`trampoline live: ≤16 table.get crossings /10k METH_NOARGS (${setKey})`, crossings <= 16, `${crossings} crossings`);
  }

  harden.scrubWorkerScope();
  harden.hardenRealm();
  let gateThrew = null;
  try {
    harden.assertRealmHardened();
  } catch (e) {
    gateThrew = e.message;
  }
  check('assertRealmHardened passes on a clean hardened realm', gateThrew === null, gateThrew ?? '');

  let outBuf = '';
  let stdoutDecoder = new TextDecoder();
  let stderrDecoder = new TextDecoder();
  pyodide.setStdout({
    write: (buf) => {
      outBuf += stdoutDecoder.decode(buf, { stream: true });
      return buf.length;
    },
    isatty: false,
  });
  pyodide.setStderr({
    write: (buf) => {
      outBuf += stderrDecoder.decode(buf, { stream: true });
      return buf.length;
    },
    isatty: false,
  });
  pyodide.setInterruptBuffer(new Uint8Array(new SharedArrayBuffer(64))); // post-freeze API liveness
  pyodide.runPython(HARNESS_INSTALL);

  const run = (code) => {
    outBuf = '';
    stdoutDecoder = new TextDecoder();
    stderrDecoder = new TextDecoder();
    pyodide.globals.set('_avlo_code', code);
    const res = JSON.parse(pyodide.runPython(RUN_INVOKE));
    return { ...res, output: outBuf };
  };
  return { pyodide, run };
}

// ---------------------------------------------------------------- base
// The sessions-5/6/7 board (scrub/freeze/0008-closure/tombstones/protocol)
// over the product `numpy` set, plus the constructor-freeze sweep and
// post-freeze sqlite3 proofs (sqlite3 is STATIC since 314 — zero tars).
if (section === 'base') {
  const { pyodide, run } = await bootHardened('numpy+pandas');

  for (const name of harden.SCRUBBED_GLOBALS) {
    if (name in globalThis && globalThis[name] !== undefined) check(`scrub removed ${name}`, false, 'still reachable');
  }
  check('scrub: fetch unreachable', typeof globalThis.fetch === 'undefined');
  check('scrub: WebSocket unreachable', typeof globalThis.WebSocket === 'undefined');
  check('scrub: navigator unreachable', typeof globalThis.navigator === 'undefined');
  check('scrub: BroadcastChannel unreachable', typeof globalThis.BroadcastChannel === 'undefined');
  check(
    'wasm compile surface gone',
    WebAssembly.instantiate === undefined && WebAssembly.compile === undefined && WebAssembly.Module === undefined,
  );
  check('wasm runtime types kept', typeof WebAssembly.Memory === 'function' && typeof WebAssembly.Table === 'function');

  // Full freeze sweep — every target the writer froze, independently re-read.
  const unfrozen = harden
    .freezeTargets()
    .filter(([, o]) => !Object.isFrozen(o))
    .map(([n]) => n);
  check('freeze sweep: every FREEZE_TARGET frozen', unfrozen.length === 0, unfrozen.join(', '));
  // Constructor freezes are prop-tamper protection, NOT capability removal:
  let ctorWriteThrew = false;
  try {
    Function.x = 1; // strict mode ⇒ TypeError on a frozen object
  } catch {
    ctorWriteThrew = true;
  }
  check('frozen Function ctor rejects expando writes', ctorWriteThrew && Function.x === undefined);
  check(
    'frozen Error still subclasses',
    (() => {
      class E extends Error {}
      return new E('x') instanceof Error;
    })(),
  );
  check('frozen RegExp still executes', /a(b)/.exec('ab')?.[1] === 'b');
  check('frozen TextDecoder still constructs (per-run executor path)', new TextDecoder().decode(new Uint8Array([104, 105])) === 'hi');

  // Fail-closed negative: a restored authority must abort the gate.
  globalThis.fetch = () => {};
  let restoredThrew = false;
  try {
    harden.assertRealmHardened();
  } catch {
    restoredThrew = true;
  }
  delete globalThis.fetch;
  check('assertRealmHardened THROWS when a scrubbed global is restored', restoredThrew);

  let r = run('print(40 + 2)');
  check('print works post-harden', r.ok && r.output === '42\n', JSON.stringify(r));
  r = run('import asyncio\nprint(type(asyncio.get_event_loop()).__name__)');
  check('0008: webloop alive (pyodide_js registration intact)', r.ok && r.output === 'WebLoop\n', JSON.stringify(r).slice(0, 200));
  r = run('x = 41\nx + 1');
  check('last-expression echo', r.ok && r.output === '42\n', JSON.stringify(r));
  r = run("def f():\n    raise ValueError('boom')\nf()");
  check(
    'traceback: user frames + source line',
    !r.ok && r.output.includes('ValueError: boom') && r.output.includes('<block>') && r.output.includes("raise ValueError('boom')"),
    JSON.stringify(r).slice(0, 300),
  );
  r = run('import js');
  check('js import blocked', !r.ok && r.output.includes("No module named 'js'"), JSON.stringify(r).slice(0, 200));
  r = run("__import__('pyodide_js')");
  check('__import__ bridge blocked', !r.ok && r.output.includes('No module named'), JSON.stringify(r).slice(0, 200));
  r = run('import numpy\nprint(float(numpy.ones(4).sum()))');
  check('numpy under frozen realm', r.ok && r.output === '4.0\n', JSON.stringify(r).slice(0, 200));
  r = run('import numpy.random\nnumpy.random.seed(7)\nprint(int(numpy.random.randint(0, 100)))');
  check('numpy.random under frozen realm', r.ok && /^\d+\n$/.test(r.output), JSON.stringify(r).slice(0, 200));
  r = run('import sys\nsys.exit()');
  check('SystemExit ends run, not runtime', r.ok, JSON.stringify(r));
  r = run('import json\njson.dumps = None');
  check('json.dumps sabotage run completes', r.ok, JSON.stringify(r));
  r = run("print('still alive')");
  check('protocol survives json.dumps sabotage', r.ok && r.output === 'still alive\n', JSON.stringify(r));

  // sqlite3 — static in the main module (314), exercised entirely POST-freeze.
  r = run(
    "import sqlite3\ncon = sqlite3.connect(':memory:')\ncon.execute('CREATE TABLE t (a INTEGER, b TEXT)')\ncon.executemany('INSERT INTO t VALUES (?, ?)', [(1, 'x'), (2, 'y')])\ncon.commit()\nprint(con.execute('SELECT SUM(a), COUNT(*) FROM t').fetchone())",
  );
  check('sqlite3 :memory: CRUD post-freeze', r.ok && r.output === '(3, 2)\n', JSON.stringify(r).slice(0, 200));
  r = run(
    "import sqlite3\ncon = sqlite3.connect('/tmp/h.db')\ncon.execute('CREATE TABLE kv (k TEXT, v INTEGER)')\ncon.execute('INSERT INTO kv VALUES (?, ?)', ('a', 7))\ncon.commit()\ncon.close()\ncon = sqlite3.connect('/tmp/h.db')\nprint(con.execute('SELECT v FROM kv').fetchone()[0])\ncon.close()\nimport os\nos.remove('/tmp/h.db')",
  );
  check('sqlite3 file DB persists in MEMFS post-freeze', r.ok && r.output === '7\n', JSON.stringify(r).slice(0, 200));
  r = run('import sqlite3\nprint(len(sqlite3.sqlite_version.split(".")))');
  check('sqlite3 version reads from the static builtin', r.ok && r.output === '3\n', JSON.stringify(r));

  // 0008 js-bridge closure — guard-stripped probes, then restore.
  r = run(
    "import sys\nsys._avlo_saved_mp = sys.meta_path[:]\nsys.meta_path[:] = [m for m in sys.meta_path if type(m).__name__ != '_AvloImportGuard']\nprint(any(type(m).__name__ == '_AvloImportGuard' for m in sys.meta_path))",
  );
  check('0008: guard stripped for closure probes', r.ok && r.output === 'False\n', JSON.stringify(r).slice(0, 200));
  r = run('import js');
  check(
    '0008: guard-stripped `import js` → ModuleNotFoundError',
    !r.ok && r.output.includes("No module named 'js'"),
    JSON.stringify(r).slice(0, 250),
  );
  r = run("import importlib\nimportlib.import_module('js')");
  check(
    "0008: importlib.import_module('js') → ModuleNotFoundError",
    !r.ok && r.output.includes("No module named 'js'"),
    JSON.stringify(r).slice(0, 250),
  );
  r = run("import sys\nprint('js' in sys.modules)");
  check("0008: no 'js' in sys.modules after failed imports", r.ok && r.output === 'False\n', JSON.stringify(r));
  r = run("import pyodide.code\npyodide.code.run_js('1+1')");
  check(
    '0008: run_js → ModuleNotFoundError (lazy `from js import eval`)',
    !r.ok && r.output.includes("No module named 'js'"),
    JSON.stringify(r).slice(0, 300),
  );
  r = run("import pyodide_js\ng = pyodide_js._api.config.jsglobals\nprint(g is not None)\nprint(getattr(g, 'fetch', None))");
  check(
    '0008 residual: pyodide_js reachable guard-stripped, jsglobals.fetch gone (scrub holds)',
    r.ok && r.output.startsWith('True\n') && /None|undefined/.test(r.output),
    JSON.stringify(r).slice(0, 300),
  );
  r = run(
    "import sys\nsys.meta_path[:] = sys._avlo_saved_mp\ndel sys._avlo_saved_mp\nsys.modules.pop('js', None)\nsys.modules.pop('pyodide_js', None)\nsys.modules.pop('pyodide.code', None)\nprint(any(type(m).__name__ == '_AvloImportGuard' for m in sys.meta_path))",
  );
  check('0008: guard restored', r.ok && r.output === 'True\n', JSON.stringify(r).slice(0, 200));
  r = run('import js');
  check('guard restored: import js refused', !r.ok && r.output.includes("No module named 'js'"), JSON.stringify(r).slice(0, 200));
  r = run('import pyodide_js');
  check(
    'guard restored: import pyodide_js refused',
    !r.ok && r.output.includes("No module named 'pyodide_js'"),
    JSON.stringify(r).slice(0, 200),
  );

  // C-surface probes.
  r = run('import ctypes');
  check(
    'ctypes tombstoned (no in-wasm FFI)',
    !r.ok && /ctypes/.test(r.output) && /No module named|not available/.test(r.output),
    JSON.stringify(r).slice(0, 220),
  );
  r = run(
    "out='ok'\ntry:\n    import subprocess\n    subprocess.run(['echo','hi'])\n    out='RAN'\nexcept BaseException as e:\n    out=type(e).__name__\nprint(out)",
  );
  check('subprocess.run non-functional (no fork/exec in wasm)', r.ok && !r.output.includes('RAN'), JSON.stringify(r).slice(0, 220));
  const heapKib = (pyodide._module?.HEAP8?.length ?? 0) >>> 10;
  check('heap size readable post-harden (MEM_KIB path)', heapKib > 0, String(heapKib));
  finish();
}

// ---------------------------------------------------------------- seaborn
// The full `all` set (7 tars) under the hardened realm: seaborn plots decode
// to real pixels, the vendored KDE keeps scipy out, tombstone probes are
// precise, and pandas↔sqlite3 roundtrips — all POST-freeze.
if (section === 'seaborn') {
  const { decodePng } = await import('./lib/png.mjs');
  // Dependency-free like verify.ts — safe to type-strip directly. Drives the
  // harvest-cap checks so py-harness's local MAX_FIGS/MAX_FIG_PX literals
  // (the file must stay import-free) cannot silently drift from PY_LIMITS.
  const { PY_LIMITS } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-protocol.ts')).href);
  const { pyodide, run } = await bootHardened('all');

  pyodide.runPython(`import logging
_avlo_mpl_logs = []
class _AvloLogTap(logging.Handler):
    def emit(self, record):
        _avlo_mpl_logs.append(record.getMessage())
_mpl_logger = logging.getLogger('matplotlib')
_mpl_logger.addHandler(_AvloLogTap(level=logging.INFO))
_mpl_logger.setLevel(logging.INFO)`);

  let r = run('import seaborn\nprint(seaborn.__version__)');
  check('import seaborn post-freeze', r.ok && r.output === '0.13.2\n', JSON.stringify(r).slice(0, 300));
  r = run(
    "import numpy as np, pandas as pd, seaborn as sns\nimport matplotlib.pyplot as plt\nrng = np.random.default_rng(7)\ndf = pd.DataFrame({'x': rng.normal(size=40), 'y': rng.normal(size=40), 'k': ['a', 'b'] * 20})\nax = sns.scatterplot(data=df, x='x', y='y', hue='k')\nax.get_figure().savefig('/tmp/h_scatter.png', dpi=100)\nplt.close('all')\nprint('saved')",
  );
  check('sns.scatterplot renders', r.ok && r.output === 'saved\n', JSON.stringify(r).slice(0, 300));
  if (r.ok) {
    const png = decodePng(Buffer.from(pyodide.FS.readFile('/tmp/h_scatter.png')));
    const colors = new Set();
    for (let i = 0; i < png.pixels.length; i += png.channels)
      colors.add(png.pixels[i] | (png.pixels[i + 1] << 8) | (png.pixels[i + 2] << 16));
    check('scatter PNG decodes to real pixels', png.width > 0 && colors.size >= 2, `${png.width}x${png.height}, ${colors.size} colors`);
  }
  r = run(
    "import sys, numpy as np, seaborn as sns\nimport matplotlib.pyplot as plt\nsns.kdeplot(x=np.random.default_rng(11).normal(size=200))\nplt.close('all')\nprint('scipy' in sys.modules)",
  );
  check('kdeplot on vendored KDE — scipy never enters sys.modules', r.ok && r.output === 'False\n', JSON.stringify(r).slice(0, 300));
  r = run("import seaborn as sns\nsns.load_dataset('penguins')");
  check(
    'load_dataset → urllib.request tombstone (lazy urllib patch)',
    !r.ok && r.output.includes("'urllib.request'") && r.output.includes('not available'),
    JSON.stringify(r).slice(0, 300),
  );
  r = run('import seaborn.objects');
  check(
    'seaborn.objects → prune tombstone (PIL-dead)',
    !r.ok && r.output.includes('seaborn.objects') && r.output.includes('not available'),
    JSON.stringify(r).slice(0, 300),
  );
  r = run(
    "import sqlite3, pandas as pd\ncon = sqlite3.connect(':memory:')\npd.DataFrame({'g': ['a', 'a', 'b'], 'x': [1.0, 2.0, 3.5]}).to_sql('t', con, index=False)\nprint(pd.read_sql_query('SELECT SUM(x) AS s FROM t', con)['s'].iloc[0])\ncon.close()",
  );
  check('pandas↔sqlite3 read_sql roundtrip post-freeze', r.ok && r.output === '6.5\n', JSON.stringify(r).slice(0, 300));

  // ---- figure harvest (session 9): open pyplot figures come back as
  // [path, w, h] triples in the run JSON and are ALWAYS closed across runs.
  r = run("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()\nprint('plotted')");
  check(
    'harvest: open figure → one [path,w,h] triple; plt.show() warning filtered',
    r.ok && r.figures.length === 1 && r.output === 'plotted\n',
    JSON.stringify(r).slice(0, 300),
  );
  if (r.ok && r.figures.length === 1) {
    const [p, w, h] = r.figures[0];
    const png = decodePng(Buffer.from(pyodide.FS.readFile(p)));
    check(
      'harvest: figure PNG decodes, dims match the triple',
      png.width === w && png.height === h,
      `${png.width}x${png.height} vs ${w}x${h}`,
    );
    pyodide.FS.unlink(p); // executor-shaped cleanup
  }
  r = run('import matplotlib._pylab_helpers as h\nprint(len(h.Gcf.get_all_fig_managers()))');
  check(
    'harvest: Gcf empty on the NEXT run (unconditional close-all)',
    r.ok && r.output === '0\n' && r.figures.length === 0,
    JSON.stringify(r).slice(0, 200),
  );
  r = run("import matplotlib.pyplot as plt\nfor i in range(6):\n    plt.figure()\nprint('made 6')");
  check(
    'harvest: 6 open figures capped at PY_LIMITS.maxFigures',
    r.ok && r.figures.length === PY_LIMITS.maxFigures,
    JSON.stringify(r).slice(0, 200),
  );
  if (r.ok) for (const [p] of r.figures) pyodide.FS.unlink(p);
  r = run("import matplotlib.pyplot as plt\nplt.figure(figsize=(30, 10), dpi=100)\nprint('big')");
  check(
    'harvest: oversize figure dpi-scaled to ≤ PY_LIMITS.maxFigurePx long side',
    r.ok &&
      r.figures.length === 1 &&
      Math.max(r.figures[0][1], r.figures[0][2]) <= PY_LIMITS.maxFigurePx &&
      r.figures[0][1] >= PY_LIMITS.maxFigurePx - 64,
    JSON.stringify(r.figures).slice(0, 200),
  );
  if (r.ok) for (const [p] of r.figures) pyodide.FS.unlink(p);

  const logs = JSON.parse(pyodide.runPython('import json; json.dumps(_avlo_mpl_logs)'));
  check(
    'font gates: no findfont, no fontManager rebuild',
    !logs.some((l) => /findfont|generated new fontManager/.test(l)),
    logs.filter((l) => /findfont|generated/.test(l)).join(' | '),
  );
  finish();
}

// ---------------------------------------------------------------- snapshot
// P2 owned snapshots over the L2 uniform boot, the standing exit gate:
// UNIFORM cold boot (shipped driver, headerP:null → deferred Module.callMain
// — THE cold-path equivalence probe) + mounts + bake → owned capture via the
// fork APIs → AVS2 assemble → sup-style verified read (readSnapshotToBuffer)
// → dirty-restore negative (heapP:null ⇒ DirtyRestoreError) → owned restore
// through the SHIPPED feeds driver (precompiled WebAssembly.Modules, exactly
// the executor's path) → extract-only remount → functional probes. The codec
// AND the driver are the SHIPPED web/src/core/py modules — the harness only
// supplies an fd-backed SnapReadHandle where the supervisor supplies OPFS.
if (section === 'snapshot') {
  const SET_KEY = 'all';
  const { Xxh32, planAvsHeapOff, encodeAvsHeaderBlock, parseAvsHeader, readSnapshotToBuffer } = await import(
    pathToFileURL(join(repo, 'web/src/core/py/py-snapshot.ts')).href
  );
  const { bootPyodide, DirtyRestoreError, freeDsoFileData } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-loader.ts')).href);
  const LIVE = { live: () => true, abandoned: () => false };
  /** Uniform-boot feed bundles for the shipped driver (executor-shaped). */
  const mkFeeds = ({ header = null, heap = null, modules = null, onInvalid = null } = {}) => {
    const outcome = { restored: false };
    const invalids = [];
    return {
      feeds: {
        headerP: Promise.resolve(header),
        heapP: Promise.resolve(heap),
        modulesP: modules ?? Promise.resolve(null),
        onSnapInvalid: (reason) => {
          invalids.push(reason);
          onInvalid?.(reason);
        },
        outcome,
      },
      outcome,
      invalids,
    };
  };
  const POST_RESTORE = 'import _avlo_runtime; _avlo_runtime.post_restore(); del _avlo_runtime';
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

  // Shipped-impl sanity: known XXH32 vectors (seed 0) — pins the codec the
  // executor/supervisor will actually run.
  {
    const t1 = new Xxh32();
    const t2 = new Xxh32();
    t2.update(Buffer.from('Nobody inspects the spammish repetition'));
    check('xxh32 known-answer vectors', t1.hex() === '02cc5d05' && t2.hex() === 'e2293b2f', `${t1.hex()} ${t2.hex()}`);
  }
  const CHUNK = 8 << 20;
  /** fd-backed SnapReadHandle — the harness's stand-in for the supervisor's
   * OPFS sync-access handle (same contract: positioned read, idempotent
   * close). The shipped parseAvsHeader/readSnapshotToBuffer consume it
   * verbatim. */
  const mkSnapHandle = (fd, size) => {
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

  // Tars read once (de-pooled — walker nodes + soBytes alias these buffers,
  // exactly like the executor's transferred boot payloads).
  const bootTars = LOCK.sets[SET_KEY].map((bundle) => {
    const tar = readTar(bundle);
    return { tar, meta: parseTarMeta(tar) };
  });
  // Shipped collectSoBytes — the same subarray-view mapping the executor's
  // precompile task consumes.
  const soBytes = collectSoBytes(bootTars.map(({ tar, meta }) => ({ prefix: meta.prefix, bytes: tar.buffer })));

  // ---- boot 1: UNIFORM cold boot (headerP:null → deferred Module.callMain,
  // the executor's exact cold+capture path — the full board below over this
  // interpreter IS the deferred-main equivalence probe) + mounts + bake +
  // owned capture.
  const cold = mkFeeds();
  let py1 = await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: cold.feeds });
  check('uniform cold boot: cold outcome, zero snap-invalids', cold.outcome.restored === false && cold.invalids.length === 0);
  for (const { tar, meta } of bootTars) {
    mountBundleTree(py1.FS, meta.prefix, tar);
    for (const so of meta.loadOrder) await py1._api.loadDynlib(`${meta.prefix}/${so}`);
  }
  py1.runPython(POST_RESTORE);
  // Cold-boot file_data knife (executor order: after all dlopens, before the
  // bake — freed pages get reused by bake allocations, the capture shrinks).
  {
    const before = py1._module.HEAP8.length;
    const { freedBytes, aborted } = freeDsoFileData(py1);
    check(
      'dso-free: freed the group ELF copies (>8 MB, no abort)',
      freedBytes > 8 << 20 && !aborted,
      `freed ${freedBytes} aborted ${aborted}`,
    );
    console.log(`  dso-free: freed ${(freedBytes / 1e6).toFixed(1)} MB of file_data (heap ${(before / 1e6).toFixed(1)} MB)`);
  }
  py1.runPython(BAKE);
  const pin1 = py1.runPython('import json, numpy\njson.dumps([int(x) for x in numpy.random.RandomState(42).randint(0, 1000, 6)])');

  // Expected-keys: walk the LIVE hiwire table; on any mismatch dump it so a
  // future boot-sequence change re-derives 0008b in one command.
  const expected = py1._api.getExpectedKeys();
  const live = [];
  for (let i = 0; ; i++) {
    try {
      live.push(py1._module.__hiwire_get(i));
    } catch {
      break;
    }
  }
  const label = (v) =>
    v === null
      ? 'null'
      : v === py1._api.public_api
        ? 'public_api'
        : v === py1._api
          ? 'API'
          : typeof v === 'function'
            ? `function ${v.name || '<anon>'}`
            : Object.prototype.toString.call(v);
  const keysMatch = live.length === expected.length && live.every((v, i) => v === expected[i]);
  if (!keysMatch) {
    console.error(`live hiwire table (${live.length} entries) vs getExpectedKeys (${expected.length}):`);
    for (let i = 0; i < Math.max(live.length, expected.length); i++) {
      console.error(`  [${i}] live=${label(live[i])}  expected=${label(expected[i])}`);
    }
  }
  check('0008b: live hiwire table == getExpectedKeys (identity + count)', keysMatch);

  const capMeta = {
    dso: JSON.parse(JSON.stringify(py1._api.getDsoLoadInfo())),
    dsoHandles: py1._api.recordDsoHandles(),
    hiwire: py1._api.serializeHiwireState(),
    buildId: py1._api.config.BUILD_ID,
    tableLenAtCapture: py1._module.wasmTable.length,
    heapLen: py1._module.HEAP8.length,
  };
  check('capture: 4 grouped DSOs recorded', capMeta.dso.loadOrder.length === 4, JSON.stringify(capMeta.dso.loadOrder));
  console.log(`  capture heapLen ${capMeta.heapLen.toLocaleString('en-US')} B (${(capMeta.heapLen / 1e6).toFixed(1)} MB)`);
  check(
    'capture: hiwireKeys empty at the pre-harden point',
    capMeta.hiwire.hiwireKeys.length === 0,
    `${capMeta.hiwire.hiwireKeys.length} keys`,
  );
  check(
    'capture: every loadOrder path has tar bytes',
    capMeta.dso.loadOrder.every((p) => soBytes.has(p)),
    [...soBytes.keys()].join(', '),
  );

  // ---- AVS2 assemble → temp file via the SHIPPED codec (hash folded over
  // the LIVE heap, chunked — heap first at heapOff, header block last, the
  // same torn-write posture as writeSetSnapshot; the supervisor writes the
  // transferred slice instead of a live view, codec mechanics identical)
  const hx = new Xxh32();
  const heapU8 = new Uint8Array(py1._module.HEAP8.buffer, py1._module.HEAP8.byteOffset, capMeta.heapLen);
  for (let off = 0; off < capMeta.heapLen; off += CHUNK) hx.update(heapU8.subarray(off, Math.min(off + CHUNK, capMeta.heapLen)));
  const sized = {
    v: 2,
    buildHash: LOCK.buildHash,
    setKey: SET_KEY,
    heapHash: { algo: 'xxh32', value: hx.hex() },
    ...capMeta,
  };
  const heapOff1 = planAvsHeapOff(sized);
  const header1 = encodeAvsHeaderBlock(sized, heapOff1);
  const snapPath = join(tmpdir(), `avlo-harness-${process.pid}.snap`);
  {
    const wfd = openSync(snapPath, 'w');
    for (let off = 0; off < capMeta.heapLen; off += CHUNK) {
      const n = Math.min(CHUNK, capMeta.heapLen - off);
      writeSync(wfd, heapU8.subarray(off, off + n), 0, n, heapOff1 + off);
    }
    writeSync(wfd, header1, 0, header1.length, 0);
    closeSync(wfd);
  }
  const fileSize = heapOff1 + capMeta.heapLen;
  py1 = null; // release boot-1 heap before boot 2 (two ~200 MB images otherwise)

  // ---- decode/validate + negatives (shipped parseAvsHeader + the shipped
  // SUP-side reader over fd handles — hash verdicts are pre-transfer now)
  const fd = openSync(snapPath, 'r');
  const snapHandle = mkSnapHandle(fd, fileSize);
  let header = null;
  try {
    header = parseAvsHeader(snapHandle, { buildHash: LOCK.buildHash, setKey: SET_KEY });
  } catch (e) {
    check('avs2 header parses + cross-checks', false, e.message);
    finish();
  }
  check('avs2 header parses + cross-checks', header !== null);

  // Positive sup-style read — the verified buffer FEEDS the restore below,
  // exactly as the supervisor transfers it to the executor.
  const heapBuffer = await readSnapshotToBuffer(snapHandle, header, LIVE);
  snapHandle.close();
  check(
    'sup read: verified heap buffer lands (fused hash, exact length)',
    heapBuffer !== null && heapBuffer.byteLength === header.heapLen,
    String(heapBuffer?.byteLength),
  );
  {
    // Corrupt-byte negative at the READ layer: a decorated handle flips one
    // byte inside the heap segment — the fused hash must refuse.
    const cfd = openSync(snapPath, 'r');
    const inner = mkSnapHandle(cfd, fileSize);
    const corruptAt = header.heapOff + 4096;
    const corrupting = {
      size: inner.size,
      read: (view, at) => {
        const n = inner.read(view, at);
        if (corruptAt >= at && corruptAt < at + n) view[corruptAt - at] ^= 0xff;
        return n;
      },
      close: inner.close,
    };
    let msg = null;
    try {
      await readSnapshotToBuffer(corrupting, header, LIVE);
    } catch (e) {
      msg = e.message;
    }
    corrupting.close();
    check('sup read: corrupt heap byte fails the fused hash', msg?.includes('hash mismatch'), msg ?? 'did not throw');
  }
  {
    // Abandoned-generation abort: resolves null, no throw (F16/F17 contract).
    const afd = openSync(snapPath, 'r');
    const h = mkSnapHandle(afd, fileSize);
    const aborted = await readSnapshotToBuffer(h, header, { live: () => true, abandoned: () => true });
    h.close();
    check('sup read: abandoned generation aborts to null', aborted === null);
  }
  {
    const bad = Buffer.from(header1);
    bad[20] ^= 0xff; // inside the header JSON
    let msg = null;
    const badPath = `${snapPath}.bad`;
    const bfd = openSync(badPath, 'w');
    writeSync(bfd, bad, 0, bad.length, 0);
    closeSync(bfd);
    const rfd = openSync(badPath, 'r');
    try {
      parseAvsHeader(mkSnapHandle(rfd, fileSize), { buildHash: LOCK.buildHash, setKey: SET_KEY });
    } catch (e) {
      msg = e.message;
    }
    closeSync(rfd);
    rmSync(badPath);
    check('avs2: corrupt header byte fails the crc', msg?.includes('crc'), msg ?? 'did not throw');
  }

  // ---- DSO precompile (executor-shaped): the 4 group Modules compile once
  // and serve BOTH the dirty-restore negative and the real restore — proving
  // precompiled-Module replay end-to-end (the 0005 union widening).
  const modulesP = (async () => {
    const pairs = await Promise.all(header.dso.loadOrder.map(async (p) => [p, await WebAssembly.compile(soBytes.get(p))]));
    return new Map(pairs);
  })();

  // ---- dirty-restore negative: heapP resolves null AFTER a successful
  // replay → the mutation zone must throw DirtyRestoreError (same-Module
  // cold is forbidden — the executor re-instantiates fresh on this class),
  // and onSnapInvalid must NOT fire (that channel is pre-mutation only).
  {
    const dirty = mkFeeds({ header, heap: null, modules: modulesP });
    let err = null;
    try {
      await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: dirty.feeds });
    } catch (e) {
      err = e;
    }
    check('dirty negative: heapP:null → DirtyRestoreError', err instanceof DirtyRestoreError, String(err).slice(0, 200));
    check(
      'dirty negative: outcome stays cold, no pre-mutation snap-invalid',
      dirty.outcome.restored === false && dirty.invalids.length === 0,
    );
  }

  // ---- boot 2: owned restore through the SHIPPED feeds driver (py-loader's
  // bootPyodide → makePreBlit — the exact executor restore path: precompiled
  // Modules, verified transferred buffer, pre-touch loop). The per-DSO
  // tableBase assert lives in the emsdk dsoBaseHook (drift throws inside the
  // replay), so a successful boot IS the post-instantiate probe.
  const restoreRun = mkFeeds({ header, heap: heapBuffer, modules: modulesP });
  const py2 = await bootPyodide({ artifactBase: `${forkDir}/`, snapshot: restoreRun.feeds });
  check(
    'restore: outcome.restored true (blit landed), zero snap-invalids',
    restoreRun.outcome.restored === true && restoreRun.invalids.length === 0,
  );
  check('restore: post-replay table length == tableLenAtCapture', py2._module.wasmTable.length === header.tableLenAtCapture);

  // Extract-only remount (files for lazy imports + post-restore C dlopens;
  // dlopen SKIPPED — the replay already registered the groups in LDSO).
  for (const { tar, meta } of bootTars) mountBundleTree(py2.FS, meta.prefix, tar);
  py2.runPython(POST_RESTORE);

  let out = py2.runPython('import json, numpy\njson.dumps(float(numpy.ones(4).sum()))');
  check('restore: numpy usable', out === '4.0', out);
  const pin2 = py2.runPython('import json, numpy\njson.dumps([int(x) for x in numpy.random.RandomState(42).randint(0, 1000, 6)])');
  check('restore: corpus-class RandomState(42) stream matches capture boot', pin1 === pin2, `${pin1} vs ${pin2}`);
  out = py2.runPython(
    "import json, pandas as pd\njson.dumps(float(pd.DataFrame({'g': ['a', 'a', 'b'], 'x': [1.0, 2.0, 3.5]}).groupby('g')['x'].sum().sum()))",
  );
  check('restore: pandas usable', out === '6.5', out);
  {
    const tblBefore = py2._module.wasmTable.length;
    out = py2.runPython('import json, matplotlib._tri\njson.dumps(type(matplotlib._tri).__name__)');
    check('restore: lazy matplotlib._tri import works', out === '"module"', out);
    check('restore: lazy import is an LDSO registry hit (no table growth)', py2._module.wasmTable.length === tblBefore);
  }
  out = py2.runPython(
    "import json\ntry:\n    import ctypes\n    _r = 'imported'\nexcept BaseException as _e:\n    _r = f'{type(_e).__name__}: {_e}'\njson.dumps(_r)",
  );
  check('restore: ctypes tombstone precise', /ModuleNotFoundError/.test(out) && /ctypes/.test(out), out.slice(0, 200));

  // Blit-reset probe on the restored generation (the executor's per-run reset).
  {
    const img = py2._module.HEAP8.slice();
    py2.runPython('leak_probe = 12345');
    py2._module.HEAP8.set(img);
    out = py2.runPython("import json\njson.dumps('leak_probe' in globals())");
    check('restore: blit reset clears run globals', out === 'false', out);
    out = py2.runPython('import json, numpy\njson.dumps(float(numpy.ones(3).sum()))');
    check('restore: numpy alive after blit reset', out === '3.0', out);
  }
  rmSync(snapPath, { force: true });
  finish();
}

// ---------------------------------------------------------------- parity
// L1 walker equivalence, the STANDING gate: boot 1 mounts all bundles via the
// in-wasm `tarfile.extractall(filter='data')` REFERENCE (the pre-walker mount
// path, re-enacted here and only here), dumps the full live MEMFS tree; boot 2
// mounts via the SHIPPED walker (py-mount.mountBundleTree) and must dump a
// ZERO-DIFF tree — every path, type, mode, mtime-sec, size, and content xxh32
// (dir mtimes out of scope: both paths leave them wall-clock). Sequential
// boots with an explicit release between (9 GB WSL2 host — never two live
// `all` images at once).
if (section === 'parity') {
  const { Xxh32 } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-snapshot.ts')).href);
  const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
  const BOOT_ENV = { PYTHONHASHSEED: '0', HOME: '/home/pyodide' };
  const S_IFDIR = 0o040000;
  const hashOf = (u8) => {
    const x = new Xxh32();
    x.update(u8);
    return x.hex();
  };
  /** Full live-tree manifest — walks the node graph directly; byte views are
   * rebuilt via (buffer, byteOffset, usedBytes) so copies AND adopted
   * subarrays read identically. Files: {t,mode,mt,size,h}; dirs: {t,mode}. */
  const dumpTree = (py, prefixes) => {
    const out = {};
    const walk = (node, path) => {
      for (const [name, child] of Object.entries(node.contents)) {
        const p = `${path}/${name}`;
        if ((child.mode & 0o170000) === S_IFDIR) {
          out[p] = { t: 'd', mode: child.mode & 0o7777 };
          walk(child, p);
        } else {
          const bytes = child.contents
            ? new Uint8Array(child.contents.buffer, child.contents.byteOffset, child.usedBytes)
            : new Uint8Array(0);
          out[p] = { t: 'f', mode: child.mode & 0o7777, mt: Math.floor(child.mtime / 1000), size: child.usedBytes, h: hashOf(bytes) };
        }
      }
    };
    for (const prefix of prefixes) {
      if (!(prefix in out)) {
        const rootNode = py.FS.lookupPath(prefix).node;
        out[prefix] = { t: 'd', mode: rootNode.mode & 0o7777 };
        walk(rootNode, prefix);
      }
    }
    return out;
  };

  const parityTars = LOCK.sets.all.map((bundle) => {
    const tar = readTar(bundle);
    return { tar, meta: parseTarMeta(tar) };
  });
  const prefixes = [...new Set(parityTars.map(({ meta }) => meta.prefix))];

  // ---- boot 1: the tarfile reference re-enactment
  let py = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });
  for (const { tar, meta } of parityTars) {
    py.FS.writeFile('/tmp/_avlo_bundle.tar', tar);
    py.runPython(`import os, tarfile
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(meta.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t`);
  }
  const ref = dumpTree(py, prefixes);
  py = null; // release boot-1 heap before boot 2

  // ---- boot 2: the shipped walker
  py = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });
  for (const { tar, meta } of parityTars) mountBundleTree(py.FS, meta.prefix, tar);
  const got = dumpTree(py, prefixes);

  const refKeys = Object.keys(ref);
  const missing = refKeys.filter((k) => !(k in got));
  const extra = Object.keys(got).filter((k) => !(k in ref));
  const diffs = [];
  for (const k of refKeys) {
    if (!(k in got)) continue;
    for (const f of ['t', 'mode', 'mt', 'size', 'h']) {
      if (ref[k][f] !== got[k][f]) diffs.push(`${k}: ${f} ${ref[k][f]} → ${got[k][f]}`);
    }
  }
  check(
    `walker parity: zero-diff tree over all ${parityTars.length} bundles (${refKeys.length} entries)`,
    missing.length === 0 && extra.length === 0 && diffs.length === 0,
    [
      missing.length ? `${missing.length} missing e.g. ${missing.slice(0, 4).join(', ')}` : '',
      extra.length ? `${extra.length} extra e.g. ${extra.slice(0, 4).join(', ')}` : '',
      diffs.length ? `${diffs.length} field diffs: ${diffs.slice(0, 8).join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' | '),
  );
  check('walker parity tree is non-trivial', refKeys.length > 1000, `${refKeys.length} entries`);

  // Functional probes on the walker-mounted boot: nameTable lookups, stat,
  // open/read of a .pyc, listdir, real imports through the mounted tree.
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
`),
  );
  check(
    'walker probes: listdir/open/stat/import/tz all live',
    probe.listdir > 0 && probe.pytzInitLen > 0 && probe.utcSize > 0 && probe.importOk === true && probe.tzProbe === 'Europe/Paris',
    JSON.stringify(probe),
  );
  finish();
}

// ---------------------------------------------------------------- verify
// No fork boot: (1) the assert gate names unfrozen intrinsics in a scrubbed-
// but-unfrozen realm (the under-sampling fix), (2) matchesLockEntry over the
// staged serving tree — positive on every artifact, negative on a flipped
// byte and a truncated buffer.
if (section === 'verify') {
  harden.scrubWorkerScope();
  for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming', 'Module']) {
    delete WebAssembly[name]; // isolate the freeze branch of the gate
  }
  let msg = null;
  try {
    harden.assertRealmHardened();
  } catch (e) {
    msg = e.message;
  }
  check('gate names unfrozen intrinsics pre-harden', msg?.includes('not frozen') && msg.includes('JSON'), msg ?? 'did not throw');
  harden.hardenRealm();
  let clean = true;
  try {
    harden.assertRealmHardened();
  } catch (e) {
    clean = false;
    msg = e.message;
  }
  check('gate passes once hardenRealm runs', clean, msg ?? '');

  for (const [name, entry] of Object.entries(LOCK.artifacts)) {
    const bytes = asArrayBuffer(readFileSync(join(forkDir, name)));
    check(`staged ${name} matches the committed lock`, await matchesLockEntry(bytes, entry));
  }
  const wasm = asArrayBuffer(readFileSync(join(forkDir, 'pyodide.asm.wasm')));
  const flipped = wasm.slice(0);
  new Uint8Array(flipped)[1000] ^= 0xff;
  check('flipped byte fails the lock', !(await matchesLockEntry(flipped, LOCK.artifacts['pyodide.asm.wasm'])));
  check(
    'truncated buffer fails the lock',
    !(await matchesLockEntry(wasm.slice(0, wasm.byteLength - 1), LOCK.artifacts['pyodide.asm.wasm'])),
  );
  finish();
}

console.error(`unknown --section ${section}`);
process.exit(1);
