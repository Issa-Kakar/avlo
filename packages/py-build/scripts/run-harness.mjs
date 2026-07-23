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
//   pnpm harness            all sections (base / seaborn / snapshot / verify children)
//   node scripts/run-harness.mjs --section base|seaborn|snapshot|verify
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 23 || (maj === 23 && min < 6)) {
  console.error(`run-harness needs Node ≥ 23.6 (type-stripping); this is ${process.versions.node}`);
  process.exit(1);
}

// The shipped py-snapshot.ts/py-loader.ts use extensionless relative imports
// (`./py-trace`), which Node's type-stripping resolver rejects — retry with
// `.ts` appended so the harness can import the EXACT shipped modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw err;
    }
  },
});

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
  let failed = 0;
  for (const s of ['base', 'seaborn', 'snapshot', 'verify']) {
    console.log(`\n=== section ${s} ===`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--section', s], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
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

/** readFileSync Buffers ride a pooled ArrayBuffer — copy to a tight one. */
const asArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

function parseTarMeta(buf) {
  const name = buf.toString('ascii', 0, 100).replace(/\0.*$/s, '');
  if (name !== 'meta.json') throw new Error('first tar entry is not meta.json');
  const size = Number.parseInt(buf.toString('ascii', 124, 136).replace(/\0.*$/s, ''), 8);
  return JSON.parse(buf.subarray(512, 512 + size).toString('utf8'));
}

/** Executor-shaped boot: fork + the set's tars (lock order) + stdlib verify +
 * tz bridge + scrub/harden/assert + harness install. Returns { pyodide, run }. */
async function bootHardened(setKey) {
  const { HARNESS_INSTALL, RUN_INVOKE } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-harness.ts')).href);
  const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
  const pyodide = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });

  for (const bundle of LOCK.sets[setKey]) {
    const tar = readFileSync(join(forkDir, `bundles/${bundle}.tar`));
    check(`${bundle}.tar matches the committed lock`, await matchesLockEntry(asArrayBuffer(tar), LOCK.bundles[bundle]));
    const meta = parseTarMeta(tar);
    pyodide.FS.writeFile('/tmp/_avlo_bundle.tar', new Uint8Array(tar));
    pyodide.runPython(`import os, tarfile
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(meta.prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t`);
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
  const { pyodide, run } = await bootHardened('numpy');

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

  // sqlite3 — the new DSO, exercised entirely POST-freeze (the additive proof).
  r = run(
    "import sqlite3\ncon = sqlite3.connect(':memory:')\ncon.execute('CREATE TABLE t (a INTEGER, b TEXT)')\ncon.executemany('INSERT INTO t VALUES (?, ?)', [(1, 'x'), (2, 'y')])\ncon.commit()\nprint(con.execute('SELECT SUM(a), COUNT(*) FROM t').fetchone())",
  );
  check('sqlite3 :memory: CRUD post-freeze', r.ok && r.output === '(3, 2)\n', JSON.stringify(r).slice(0, 200));
  r = run(
    "import sqlite3\ncon = sqlite3.connect('/tmp/h.db')\ncon.execute('CREATE TABLE kv (k TEXT, v INTEGER)')\ncon.execute('INSERT INTO kv VALUES (?, ?)', ('a', 7))\ncon.commit()\ncon.close()\ncon = sqlite3.connect('/tmp/h.db')\nprint(con.execute('SELECT v FROM kv').fetchone()[0])\ncon.close()\nimport os\nos.remove('/tmp/h.db')",
  );
  check('sqlite3 file DB persists in MEMFS post-freeze', r.ok && r.output === '7\n', JSON.stringify(r).slice(0, 200));
  r = run('import sqlite3\nprint(len(sqlite3.sqlite_version.split(".")))');
  check('sqlite3 version reads from the DSO', r.ok && r.output === '3\n', JSON.stringify(r));

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
// The full `all` set (8 tars) under the hardened realm: seaborn plots decode
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
    'load_dataset → http tombstone (lazy urllib patch)',
    !r.ok && r.output.includes("'http'") && r.output.includes('not available'),
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
// P2 owned snapshots, the Phase A exit gate: cold boot + mounts + bake →
// owned capture via the fork APIs (getDsoLoadInfo / recordDsoHandles /
// serializeHiwireState / HEAP8 slice) → AVS2 assemble → owned restore in the
// SAME process → extract-only remount → post_restore → functional probes.
// The codec AND the restore driver are the SHIPPED web/src/core/py modules
// (py-snapshot.ts encode/parse/hash, py-loader.ts bootPyodide → makePreBlit:
// buildId → growMemory → DSO replay at recorded bases → table assert →
// chunked heap read folding the fast hash) — the harness only supplies an
// fd-backed SnapReadHandle where the executor supplies an OPFS one.
if (section === 'snapshot') {
  const SET_KEY = 'all';
  const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
  const { Xxh32, planAvsHeapOff, encodeAvsHeaderBlock, parseAvsHeader } = await import(
    pathToFileURL(join(repo, 'web/src/core/py/py-snapshot.ts')).href
  );
  const { bootPyodide } = await import(pathToFileURL(join(repo, 'web/src/core/py/py-loader.ts')).href);
  const BOOT_ENV = { PYTHONHASHSEED: '0', HOME: '/home/pyodide' };
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
  const alignUp = (n, a) => Math.ceil(n / a) * a;
  const CHUNK = 8 << 20;
  /** fd-backed SnapReadHandle — the harness's stand-in for the executor's
   * OPFS sync-access handle (same contract: positioned read, idempotent
   * close). The shipped parseAvsHeader/readHeapInto consume it verbatim. */
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
  /** Fold the fast hash over the file's heap segment (no wasm involvement) —
   * probe scaffolding for the positive/corrupt-byte checks below. */
  const foldFileHash = (fd, header, corruptAt = -1) => {
    const x = new Xxh32();
    const buf = Buffer.alloc(CHUNK);
    for (let off = 0; off < header.heapLen; off += CHUNK) {
      const n = Math.min(CHUNK, header.heapLen - off);
      if (readSync(fd, buf, 0, n, header.heapOff + off) !== n) throw new Error('avs2: short heap read');
      if (corruptAt >= off && corruptAt < off + n) buf[corruptAt - off] ^= 0xff;
      x.update(buf.subarray(0, n));
    }
    return x.hex();
  };

  const walkTarSos = (tar, prefix, out) => {
    let off = 0;
    while (off + 512 <= tar.length) {
      const name = tar.toString('ascii', off, off + 100).replace(/\0.*$/s, '');
      if (!name) break;
      const size = Number.parseInt(tar.toString('ascii', off + 124, off + 136).replace(/\0.*$/s, ''), 8) || 0;
      if (name.endsWith('.so')) out.set(`${prefix}/${name}`, new Uint8Array(tar.subarray(off + 512, off + 512 + size)));
      off += 512 + alignUp(size, 512);
    }
  };
  const extractTar = (py, tar, prefix) => {
    py.FS.writeFile('/tmp/_avlo_bundle.tar', new Uint8Array(tar));
    py.runPython(`import os, tarfile
with tarfile.open('/tmp/_avlo_bundle.tar') as _t:
    _t.extractall(${JSON.stringify(prefix)}, members=[m for m in _t.getmembers() if m.name != 'meta.json'], filter='data')
os.remove('/tmp/_avlo_bundle.tar')
del _t`);
  };

  // ---- boot 1: cold + mounts (extract + dlopen) + bake + owned capture
  let py1 = await loadPyodide({ indexURL: forkDir, packages: [], env: BOOT_ENV });
  const soBytes = new Map();
  for (const bundle of LOCK.sets[SET_KEY]) {
    const tar = readFileSync(join(forkDir, `bundles/${bundle}.tar`));
    const meta = parseTarMeta(tar);
    extractTar(py1, tar, meta.prefix);
    for (const so of meta.loadOrder) await py1._api.loadDynlib(`${meta.prefix}/${so}`);
    walkTarSos(tar, meta.prefix, soBytes);
  }
  py1.runPython(POST_RESTORE);
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

  // ---- decode/validate + negatives (shipped parseAvsHeader over an fd handle)
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
  check('avs2: positive hash fold matches', foldFileHash(fd, header) === header.heapHash.value);
  check('avs2: corrupt heap byte fails the fast hash', foldFileHash(fd, header, 4096) !== header.heapHash.value);
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

  // ---- boot 2: owned restore through the SHIPPED driver (py-loader's
  // bootPyodide → makePreBlit — the exact executor restore path; a PreBlit
  // failure here would reject, failing the section). The per-DSO tableBase
  // assert lives in the emsdk dsoBaseHook (drift throws inside the replay),
  // so a successful boot IS the post-instantiate probe.
  const py2 = await bootPyodide({ artifactBase: `${forkDir}/`, restore: { header, handle: snapHandle, soBytes } });
  check('restore: post-replay table length == tableLenAtCapture', py2._module.wasmTable.length === header.tableLenAtCapture);

  // Extract-only remount (files for lazy imports + post-restore C dlopens;
  // dlopen SKIPPED — the replay already registered the groups in LDSO).
  for (const bundle of LOCK.sets[SET_KEY]) {
    const tar = readFileSync(join(forkDir, `bundles/${bundle}.tar`));
    extractTar(py2, tar, parseTarMeta(tar).prefix);
  }
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
