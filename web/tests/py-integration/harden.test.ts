// The scrub/freeze/0008-closure/tombstones/protocol board over the product
// `numpy+pandas` set, plus the constructor-freeze sweep and post-freeze
// sqlite3 proofs (sqlite3 is STATIC since 314 — zero tars). Runs in its own
// fork: bootHardened scrubs + FREEZES this realm.
import { beforeAll, describe, expect, it } from 'vitest';
import * as harden from '../../src/core/py/py-harden';
import { bootHardened, type HardenedBoot } from './helpers';

let boot: HardenedBoot;
const run = (code: string) => boot.run(code);

beforeAll(async () => {
  boot = await bootHardened('numpy+pandas');
});

describe('executor-shaped boot gates', () => {
  it('every mounted tar matches the committed lock', () => {
    expect(boot.tarLockOk).toEqual({ numpy: true, dateutil: true, pytz: true, pandas: true });
  });
  it('stdlib MEMFS hash == lock sha', () => {
    expect(boot.stdlibHashOk).toBe(true);
  });
  it('trampoline live: ≤16 table.get crossings per 10k METH_NOARGS calls', () => {
    expect(boot.trampolineCrossings).toBeLessThanOrEqual(16);
  });
  it('assertRealmHardened passes on a clean hardened realm', () => {
    expect(boot.hardenGateError).toBeNull();
  });
});

describe('scrub + freeze', () => {
  const g = globalThis as unknown as Record<string, unknown>;

  it('scrub removed every SCRUBBED_GLOBALS name', () => {
    const survivors = harden.SCRUBBED_GLOBALS.filter((name) => name in globalThis && g[name] !== undefined);
    expect(survivors).toEqual([]);
  });
  it('scrub: fetch / WebSocket / navigator / BroadcastChannel unreachable', () => {
    expect(typeof g.fetch).toBe('undefined');
    expect(typeof g.WebSocket).toBe('undefined');
    expect(typeof g.navigator).toBe('undefined');
    expect(typeof g.BroadcastChannel).toBe('undefined');
  });
  it('wasm compile surface gone, runtime types kept', () => {
    const wasm = WebAssembly as unknown as Record<string, unknown>;
    expect(wasm.instantiate).toBeUndefined();
    expect(wasm.compile).toBeUndefined();
    expect(wasm.Module).toBeUndefined();
    expect(typeof WebAssembly.Memory).toBe('function');
    expect(typeof WebAssembly.Table).toBe('function');
  });
  it('freeze sweep: every FREEZE_TARGET frozen (independently re-read)', () => {
    const unfrozen = harden
      .freezeTargets()
      .filter(([, o]) => !Object.isFrozen(o))
      .map(([n]) => n);
    expect(unfrozen).toEqual([]);
  });
  it('frozen Function ctor rejects expando writes (prop-tamper protection, not capability removal)', () => {
    expect(() => {
      (Function as unknown as Record<string, unknown>).x = 1; // strict mode ⇒ TypeError on a frozen object
    }).toThrow(TypeError);
    expect((Function as unknown as Record<string, unknown>).x).toBeUndefined();
  });
  it('frozen Error still subclasses', () => {
    class E extends Error {}
    expect(new E('x')).toBeInstanceOf(Error);
  });
  it('frozen RegExp still executes', () => {
    expect(/a(b)/.exec('ab')?.[1]).toBe('b');
  });
  it('frozen TextDecoder still constructs (per-run executor path)', () => {
    expect(new TextDecoder().decode(new Uint8Array([104, 105]))).toBe('hi');
  });
  it('assertRealmHardened THROWS when a scrubbed global is restored (fail-closed negative)', () => {
    g.fetch = () => {};
    try {
      expect(() => harden.assertRealmHardened()).toThrow(/fetch/);
    } finally {
      delete g.fetch;
    }
  });
});

describe('run protocol under the frozen realm', () => {
  it('print works post-harden', () => {
    const r = run('print(40 + 2)');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('42\n');
  });
  it('0008: webloop alive (pyodide_js registration intact)', () => {
    const r = run('import asyncio\nprint(type(asyncio.get_event_loop()).__name__)');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('WebLoop\n');
  });
  it('last-expression echo', () => {
    const r = run('x = 41\nx + 1');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('42\n');
  });
  it('traceback: user frames + source line', () => {
    const r = run("def f():\n    raise ValueError('boom')\nf()");
    expect(r.ok).toBe(false);
    expect(r.output).toContain('ValueError: boom');
    expect(r.output).toContain('<block>');
    expect(r.output).toContain("raise ValueError('boom')");
  });
  it('js import blocked', () => {
    const r = run('import js');
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'js'");
  });
  it('__import__ bridge blocked', () => {
    const r = run("__import__('pyodide_js')");
    expect(r.ok).toBe(false);
    expect(r.output).toContain('No module named');
  });
  it('numpy under frozen realm', () => {
    const r = run('import numpy\nprint(float(numpy.ones(4).sum()))');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('4.0\n');
  });
  it('numpy.random under frozen realm', () => {
    const r = run('import numpy.random\nnumpy.random.seed(7)\nprint(int(numpy.random.randint(0, 100)))');
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^\d+\n$/);
  });
  it('SystemExit ends the run, not the runtime', () => {
    expect(run('import sys\nsys.exit()').ok).toBe(true);
  });
  it('protocol survives json.dumps sabotage', () => {
    expect(run('import json\njson.dumps = None').ok).toBe(true);
    const r = run("print('still alive')");
    expect(r.ok).toBe(true);
    expect(r.output).toBe('still alive\n');
  });
});

// sqlite3 — static in the main module (314), exercised entirely POST-freeze.
describe('static sqlite3 post-freeze', () => {
  it(':memory: CRUD', () => {
    const r = run(
      "import sqlite3\ncon = sqlite3.connect(':memory:')\ncon.execute('CREATE TABLE t (a INTEGER, b TEXT)')\ncon.executemany('INSERT INTO t VALUES (?, ?)', [(1, 'x'), (2, 'y')])\ncon.commit()\nprint(con.execute('SELECT SUM(a), COUNT(*) FROM t').fetchone())",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('(3, 2)\n');
  });
  it('file DB persists in MEMFS across close/reopen', () => {
    const r = run(
      "import sqlite3\ncon = sqlite3.connect('/tmp/h.db')\ncon.execute('CREATE TABLE kv (k TEXT, v INTEGER)')\ncon.execute('INSERT INTO kv VALUES (?, ?)', ('a', 7))\ncon.commit()\ncon.close()\ncon = sqlite3.connect('/tmp/h.db')\nprint(con.execute('SELECT v FROM kv').fetchone()[0])\ncon.close()\nimport os\nos.remove('/tmp/h.db')",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('7\n');
  });
  it('version reads from the static builtin', () => {
    const r = run('import sqlite3\nprint(len(sqlite3.sqlite_version.split(".")))');
    expect(r.ok).toBe(true);
    expect(r.output).toBe('3\n');
  });
});

// 0008 js-bridge closure — the finder-level removal holds even with the
// python-side defense-in-depth guard stripped; then restore the guard.
describe('0008 closure with the import guard stripped', () => {
  it('guard strips cleanly for the closure probes', () => {
    const r = run(
      "import sys\nsys._avlo_saved_mp = sys.meta_path[:]\nsys.meta_path[:] = [m for m in sys.meta_path if type(m).__name__ != '_AvloImportGuard']\nprint(any(type(m).__name__ == '_AvloImportGuard' for m in sys.meta_path))",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('False\n');
  });
  it('guard-stripped `import js` → ModuleNotFoundError', () => {
    const r = run('import js');
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'js'");
  });
  it("guard-stripped importlib.import_module('js') → ModuleNotFoundError", () => {
    const r = run("import importlib\nimportlib.import_module('js')");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'js'");
  });
  it("no 'js' in sys.modules after the failed imports", () => {
    const r = run("import sys\nprint('js' in sys.modules)");
    expect(r.ok).toBe(true);
    expect(r.output).toBe('False\n');
  });
  it('run_js → ModuleNotFoundError (lazy `from js import eval`)', () => {
    const r = run("import pyodide.code\npyodide.code.run_js('1+1')");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'js'");
  });
  it('residual: pyodide_js reachable guard-stripped, jsglobals.fetch gone (scrub holds)', () => {
    const r = run("import pyodide_js\ng = pyodide_js._api.config.jsglobals\nprint(g is not None)\nprint(getattr(g, 'fetch', None))");
    expect(r.ok).toBe(true);
    expect(r.output.startsWith('True\n')).toBe(true);
    expect(r.output).toMatch(/None|undefined/);
  });
  it('guard restores', () => {
    const r = run(
      "import sys\nsys.meta_path[:] = sys._avlo_saved_mp\ndel sys._avlo_saved_mp\nsys.modules.pop('js', None)\nsys.modules.pop('pyodide_js', None)\nsys.modules.pop('pyodide.code', None)\nprint(any(type(m).__name__ == '_AvloImportGuard' for m in sys.meta_path))",
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe('True\n');
  });
  it('guard restored: import js refused', () => {
    const r = run('import js');
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'js'");
  });
  it('guard restored: import pyodide_js refused', () => {
    const r = run('import pyodide_js');
    expect(r.ok).toBe(false);
    expect(r.output).toContain("No module named 'pyodide_js'");
  });
});

describe('C-surface probes', () => {
  it('ctypes tombstoned (no in-wasm FFI)', () => {
    const r = run('import ctypes');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/ctypes/);
    expect(r.output).toMatch(/No module named|not available/);
  });
  it('subprocess.run non-functional (no fork/exec in wasm)', () => {
    const r = run(
      "out='ok'\ntry:\n    import subprocess\n    subprocess.run(['echo','hi'])\n    out='RAN'\nexcept BaseException as e:\n    out=type(e).__name__\nprint(out)",
    );
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('RAN');
  });
  it('heap size readable post-harden (MEM_KIB path)', () => {
    expect((boot.pyodide._module.HEAP8.length ?? 0) >>> 10).toBeGreaterThan(0);
  });
});
