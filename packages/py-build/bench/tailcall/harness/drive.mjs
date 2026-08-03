// Measurement sweep.
//
// V8 14.6 compiles wasm LAZILY by default: WebAssembly.compile() only decodes +
// validates, and function bodies are compiled on first call. So the compilation
// cost of the interpreter shows up during EXECUTION, not during compile(). That
// makes cold-isolated runs (fresh process, one benchmark, one iteration) the
// decision-relevant metric for AVLO's workload, and it is exactly what upstream's
// steady-state pystone measurement cannot see.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./analyze-wasm.mjs";

const TC = "/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc";
const SRC = `${TC}/src/Python-3.14.2`;
const BUILDS = `${TC}/builds`;

const ENGINES = {
  node26: `${TC}/tools/node26/bin/node`, // V8 14.6  ~= Chrome 145
  node24: `${TC}/tools/node24/bin/node`, // V8 13.6
};

const ORDER = ["goto-O2", "goto-O3", "tc0-O2", "tc0-O3", "tc1-O3", "tc2-O3", "tc3-O3", "tc4-O3", "tc5-O3", "tc6-O3"];
const variants = ORDER.filter((v) => existsSync(join(BUILDS, v, "python.wasm")));

const BENCHES = [
  "dispatch_tight", "nbody", "fannkuch", "spectralnorm", "fib",
  "binary_trees", "meth_noargs", "dict_ops", "str_ops", "json_roundtrip", "pystone",
];

const run = (bin, args, opts = {}) =>
  execFileSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: opts.timeout ?? 600000,
    env: { ...process.env, PYTHONPATH: `${SRC}/Lib` },
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

const grabJson = (out, tag) => {
  const line = out.split("\n").find((l) => l.startsWith(tag));
  if (!line) throw new Error(`no ${tag}`);
  return JSON.parse(line.slice(tag.length));
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const R = { meta: {}, structural: {}, validate: {}, startupBare: {}, cold: {}, steady: {} };

R.meta = {
  cpython: "3.14.2",
  emscripten: "5.0.3",
  note: "V8 lazily compiles wasm function bodies; compile() = decode+validate only.",
  engines: Object.fromEntries(
    Object.entries(ENGINES).map(([k, b]) => [k, run(b, ["-p", "process.versions.v8"]).trim()]),
  ),
  variants,
  benches: BENCHES,
};

// 1. structural -----------------------------------------------------------------
console.error("== structural ==");
for (const v of variants) {
  R.structural[v] = analyze(join(BUILDS, v, "python.wasm"));
  const s = R.structural[v];
  console.error(`  ${v.padEnd(8)} wasm=${(s.wasmBytes / 1e6).toFixed(2)} br=${(s.brotliBytes / 1e6).toFixed(2)} eval=${s.evalFrameTotal} tc=${s.tailCallFuncs} disp=${s.dispatcherBytes}`);
}

// 2. decode+validate ------------------------------------------------------------
console.error("== decode+validate ==");
for (const v of variants) {
  try {
    R.validate[v] = grabJson(
      run(ENGINES.node26, [`${TC}/compile-bench.mjs`, join(BUILDS, v, "python.wasm"), "5"]),
      "COMPILE_JSON:",
    );
    console.error(`  ${v.padEnd(8)} ${R.validate[v].median.toFixed(1)}ms`);
  } catch (e) { console.error(`  ${v} FAIL`); }
}

// 3. bare startup (fresh process, -c pass) ---------------------------------------
console.error("== bare startup ==");
for (const v of variants) {
  const s = [];
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    run(ENGINES.node26, ["node_entry.mjs", "--this-program=python", "-c", "pass"], { cwd: join(BUILDS, v) });
    s.push(Date.now() - t0);
  }
  R.startupBare[v] = { median: med(s), min: Math.min(...s), all: s };
  console.error(`  ${v.padEnd(8)} ${med(s)}ms`);
}

// 4. COLD isolated: fresh process, one benchmark, one iteration -------------------
//    = init + lazy-compile of the handlers that benchmark touches + execute.
console.error("== cold isolated (node26) ==");
for (const v of variants) {
  R.cold[v] = {};
  for (const b of BENCHES) {
    const s = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      try {
        run(ENGINES.node26, ["node_entry.mjs", "--this-program=python", `${TC}/bench.py`, "1", b], {
          cwd: join(BUILDS, v), timeout: 300000,
        });
        s.push(Date.now() - t0);
      } catch { /* ignore */ }
    }
    if (s.length) R.cold[v][b] = { median: med(s), min: Math.min(...s), all: s };
  }
  const tot = Object.values(R.cold[v]).reduce((a, x) => a + x.median, 0);
  console.error(`  ${v.padEnd(8)} total=${tot}ms`);
}

// 5. steady state ----------------------------------------------------------------
console.error("== steady ==");
for (const [eng, bin] of Object.entries(ENGINES)) {
  for (const [tier, flags] of Object.entries({ default: [], liftoff: ["--liftoff-only"] })) {
    if (eng === "node24" && tier !== "default") continue;
    for (const v of variants) {
      const key = `${v}|${eng}|${tier}`;
      try {
        R.steady[key] = grabJson(
          run(bin, [...flags, "node_entry.mjs", "--this-program=python", `${TC}/bench.py`, "9"], {
            cwd: join(BUILDS, v), timeout: 900000,
          }),
          "BENCH_JSON:",
        );
        const t = Object.values(R.steady[key]).reduce((a, x) => a + x.median, 0);
        console.error(`  ${key.padEnd(28)} ${t.toFixed(0)}ms`);
      } catch (e) { console.error(`  ${key.padEnd(28)} FAIL`); }
    }
  }
}

writeFileSync(`${TC}/results.json`, JSON.stringify(R, null, 2));
console.error("\nwrote results.json");
