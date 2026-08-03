// Startup decomposition (PR #16 review, ask 3).
//
// The review correctly rejected the "-54 ms is lazy compilation" attribution:
// Liftoff compiles a 79 KB function in single-digit ms. The direct counter-test
// (`--no-wasm-lazy-compilation`) cannot be run -- it deadlocks this module's async
// startup ("unsettled top-level await"). So instead of toggling the compiler tier,
// this splits the startup wall clock into its three phases and shows which one
// actually differs between computed-goto and tail-call builds.
//
//   phase A  process start -> preRun      wasm compile + instantiate
//   phase B  preRun        -> runtime init  emscripten runtime bring-up
//   phase C  runtime init  -> exit          Py_Initialize + run `pass`
//
// Usage: startup-probe.mjs <buildDir>   (prints PROBE_JSON:)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const dir = process.argv[2];
const SRC = '/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc/src/Python-3.14.2';
process.env.PYTHONPATH = `${SRC}/Lib`;

const t0 = performance.now();
const { default: Factory } = await import(pathToFileURL(`${dir}/python.mjs`).href);
const tImport = performance.now();

let tPreRun = 0;
let tInit = 0;

// The build links -sEXIT_RUNTIME, so the process is torn down as soon as main()
// returns and nothing after `await Factory(...)` ever runs. Report from onExit.
const report = () => {
  const tEnd = performance.now();
  console.log(
    `PROBE_JSON:${JSON.stringify({
      dir,
      importGlue: +(tImport - t0).toFixed(2),
      compileInstantiate: +(tPreRun - tImport).toFixed(2),
      runtimeInit: +(tInit - tPreRun).toFixed(2),
      pythonMain: +(tEnd - tInit).toFixed(2),
      total: +(tEnd - t0).toFixed(2),
    })}`,
  );
};

await Factory({
  arguments: ['-c', 'pass'],
  thisProgram: 'python',
  onExit: report,
  preRun(M) {
    tPreRun = performance.now();
    for (const d of fs
      .readdirSync('/')
      .filter((x) => !['dev', 'lib', 'proc'].includes(x))
      .map((x) => `/${x}`)) {
      M.FS.mkdirTree(d);
      M.FS.mount(M.FS.filesystems.NODEFS, { root: d }, d);
    }
    M.FS.chdir(process.cwd());
    Object.assign(M.ENV, process.env);
    delete M.ENV.PATH;
  },
  onRuntimeInitialized() {
    tInit = performance.now();
  },
});
