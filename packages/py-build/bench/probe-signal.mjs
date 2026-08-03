// Signal-check deep probe: exact crossing counts + in-process interleaved armed/unarmed timing.
// Usage: node probe-signal.mjs [--shim]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = '/home/issak/dev/avlo';
const forkDir = process.argv.find((a) => a.startsWith('--fork='))?.split('=')[1] ?? join(repo, 'web/public/py-dev/fork');
const SHIM = process.argv.includes('--shim');
if (SHIM) {
  const src = readFileSync(
    join(repo, 'packages/py-build/.work/pyodide/cpython/build/Python-3.14.2/Python/emscripten_trampoline_wasm.c'),
    'utf8',
  );
  const hex = src.match(/hexStringToUTF8Array\("([0-9a-f]+)"\)/)[1];
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  globalThis.getWasmTrampolineModule = () => new WebAssembly.Module(bytes);
}
const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });

// ---- Phase 1: count signal-helper crossings per subtest (accessor fake buffer).
const counter = { n: 0 };
const fakeBuf = {
  get 0() {
    counter.n++;
    return 0;
  },
  set 0(_v) {},
};
const SUBTESTS = {
  pass_loop: ['for _ in range(N): pass', 2_000_000],
  meth_noargs: ['q=(12345678901234).bit_length\nfor _ in range(N): q()', 1_000_000],
  list_grow: ['l=[]\nap=l.append\nfor i in range(N): ap(i)', 1_000_000],
  fib_rec: ['def F(k):\n    return k if k < 2 else F(k-1)+F(k-2)\nF(21)', 35_421],
  json_round: ["import json\nobj={'a':[1,2,3],'b':'text','c':{'d':4.5}}\nfor _ in range(N): json.loads(json.dumps(obj))", 20_000],
};
const crossings = {};
for (const [name, [src, n]] of Object.entries(SUBTESTS)) {
  py.setInterruptBuffer(fakeBuf);
  counter.n = 0;
  py.runPython(`N=${n}\n${src}`);
  py.setInterruptBuffer(null);
  crossings[name] = {
    crossings: counter.n,
    perIterX1000: Math.round((counter.n / n) * 1000 * 1000) / 1000,
    ticksPerIter: Math.round(((counter.n * 51) / n) * 100) / 100,
  };
}

// ---- Phase 2 (shipped only): trampoline-vs-signal crossing ratio on mixed workload.
let ratio = null;
if (!SHIM) {
  const origGet = WebAssembly.Table.prototype.get;
  let tramp = 0;
  WebAssembly.Table.prototype.get = function (...a) {
    tramp++;
    return origGet.apply(this, a);
  };
  py.setInterruptBuffer(fakeBuf);
  counter.n = 0;
  py.runPython("import json\nobj={'a':[1,2,3],'b':'text','c':{'d':4.5}}\nfor _ in range(20000): json.loads(json.dumps(obj))");
  py.setInterruptBuffer(null);
  WebAssembly.Table.prototype.get = origGet;
  ratio = { trampolineCrossings: tramp, signalCrossings: counter.n, ratio: Math.round((tramp / Math.max(1, counter.n)) * 10) / 10 };
}

// ---- Phase 3: interleaved in-process armed/unarmed timing (real SAB), paired deltas.
const sab = new SharedArrayBuffer(64);
const realBuf = new Uint8Array(sab);
py.runPython(`
import time, json
def _bench(src, n):
    g = {'N': n}
    code = compile('def _f():\\n' + '\\n'.join('    ' + l for l in src.splitlines()), '<b>', 'exec')
    exec(code, g)
    f = g['_f']
    f()  # warm
    t0 = time.perf_counter(); f(); t1 = time.perf_counter()
    return (t1 - t0) * 1e9 / n
`);
const mkRun = (name, [src, n]) => py.runPython(`_bench(${JSON.stringify(src)}, ${n})`);
const PAIRS = 10;
const results = {};
for (const name of Object.keys(SUBTESTS)) results[name] = { armed: [], unarmed: [] };
for (let p = 0; p < PAIRS; p++) {
  for (const armFirst of [p % 2 === 0, !(p % 2 === 0)]) {
    if (armFirst) py.setInterruptBuffer(realBuf);
    else py.setInterruptBuffer(null);
    for (const [name, spec] of Object.entries(SUBTESTS)) {
      results[name][armFirst ? 'armed' : 'unarmed'].push(mkRun(name, spec));
    }
  }
}
py.setInterruptBuffer(null);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const timing = {};
for (const [name, r] of Object.entries(results)) {
  const mA = median(r.armed),
    mU = median(r.unarmed);
  timing[name] = {
    unarmed_ns: Math.round(mU * 100) / 100,
    armed_ns: Math.round(mA * 100) / 100,
    delta_ns: Math.round((mA - mU) * 100) / 100,
    delta_pct: Math.round(((mA - mU) / mU) * 1000) / 10,
    ns_per_crossing: crossings[name].crossings ? Math.round(((mA - mU) * SUBTESTS[name][1]) / crossings[name].crossings) : null,
  };
}
console.log(JSON.stringify({ shim: SHIM, crossings, ratio, timing }, null, 1));
process.exit(0);
