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
//   pnpm harness            all sections (base / seaborn / verify children)
//   node scripts/run-harness.mjs --section base|seaborn|verify
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 23 || (maj === 23 && min < 6)) {
  console.error(`run-harness needs Node ≥ 23.6 (type-stripping); this is ${process.versions.node}`);
  process.exit(1);
}

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
  for (const s of ['base', 'seaborn', 'verify']) {
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
// over the product `numpy` set — which now mounts sqlite3 FIRST — plus the
// constructor-freeze sweep and post-freeze sqlite3 proofs.
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
