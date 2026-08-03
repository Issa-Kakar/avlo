// Boot one saved fork build, run the REMOTE agent's bench.py suite (9 in-process
// iterations, their protocol), print BENCH_JSON. Fresh process per invocation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const forkDir = process.argv[2];
const benchPy = process.argv[3];
const iters = process.argv[4] ?? '9';

const { loadPyodide } = await import(pathToFileURL(join(forkDir, 'pyodide.mjs')).href);
const t0 = performance.now();
const py = await loadPyodide({ indexURL: forkDir, packages: [], env: { PYTHONHASHSEED: '0', HOME: '/home/pyodide' } });
const bootMs = Math.round(performance.now() - t0);

// Strip the __main__ guard so exec defines but does not run main().
const src = readFileSync(benchPy, 'utf8').replace(/if __name__ == "__main__":\s*\n\s*main\(\)\s*$/m, '');
py.runPython(src);
const out = py.runPython(`
import json as _json
_res = {}
for _name, _fn in BENCHMARKS:
    _times = []
    for _ in range(${iters}):
        _t0 = perf(); _fn(); _times.append((perf() - _t0) * 1000.0)
    _o = sorted(_times)
    _res[_name] = {"first": _times[0], "min": _o[0], "median": _o[len(_o)//2], "all": [round(t,3) for t in _times]}
_json.dumps(_res)
`);
console.log(`BOOT_MS:${bootMs}`);
console.log('BENCH_JSON:' + out);
