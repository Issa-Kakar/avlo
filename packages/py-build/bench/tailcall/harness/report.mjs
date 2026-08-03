import { readFileSync, writeFileSync } from "node:fs";

const TC = "/tmp/claude-0/-home-user-avlo/80de0d9c-acb2-50c4-9c1a-d238eb42e5f5/scratchpad/tc";
const R = JSON.parse(readFileSync(`${TC}/results.json`, "utf8"));

const LABEL = {
  "goto-O2": "goto −O2 **(AVLO today)**",
  "goto-O3": "goto −O3",
  "tc0-O2": "tail v0 −O2",
  "tc0-O3": "tail v0 −O3",
  "tc1-O3": "tail v1 −O3 central indirect",
  "tc2-O3": "tail v2 −O3 switch→fnptr",
  "tc3-O3": "tail v3 −O3 switch direct",
  "tc4-O3": "tail v4 −O3 switch+default",
  "tc5-O3": "tail v5 −O3 br_table multivalue",
  "tc6-O3": "tail v6 −O3 br_table asm",
};
const BASE = "goto-O2";
const vs = R.meta.variants;
const B = R.meta.benches;

const pct = (v, b) => (b ? ((v - b) / b) * 100 : 0);
const sp = (x) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";
const geo = (xs) => (xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : NaN);

const L = [];
const P = (s = "") => L.push(s);

P("# Tail-call interpreter + `−O3` on wasm — independent benchmark");
P();
P("Independent verification of AVLO Workstream A3 (V2 `−O3`, V3 tail-call interpreter),");
P("plus the dispatcher-variant sweep pyodide PR #6122 left unmeasured.");
P();
P("| | |");
P("|---|---|");
P(`| CPython | ${R.meta.cpython} (AVLO's pin) |`);
P(`| Emscripten | ${R.meta.emscripten} (AVLO's pin) |`);
P(`| V8 | node26 ${R.meta.engines.node26} (≈Chrome 145) · node24 ${R.meta.engines.node24} |`);
P("| Host | 4-core Xeon @2.80 GHz, 15 GB, idle |");
P("| Build | standalone CPython-for-emscripten, `--enable-wasm-dynamic-linking`, static link |");
P();
P("> **V8 compiles wasm function bodies lazily.** `WebAssembly.compile()` only decodes and");
P("> validates; a function is compiled on first call. Interpreter compile cost therefore lands");
P("> during *execution*, which is why cold-isolated runs — not steady-state pystone — are the");
P("> decision-relevant metric here.");
P();

// 1 structural
P("## 1. Structural");
P();
P("| variant | wasm | brotli | Δbr | funcs | `_PyEval_EvalFrameDefault` | handlers | median handler | dispatcher |");
P("|---|--:|--:|--:|--:|--:|--:|--:|--:|");
const bBr = R.structural[BASE].brotliBytes;
for (const v of vs) {
  const s = R.structural[v];
  P(`| ${LABEL[v] ?? v} | ${(s.wasmBytes / 1e6).toFixed(2)} MB | ${(s.brotliBytes / 1e6).toFixed(2)} MB | ${sp(pct(s.brotliBytes, bBr))} | ${s.bodyCount} | **${s.evalFrameTotal.toLocaleString()} B** | ${s.tailCallFuncs || "—"} | ${s.tailCallMedianBytes || "—"} B | ${s.dispatcherBytes || "—"} B |`);
}
P();

// 2 validate + startup
P("## 2. Decode+validate, and bare startup");
P();
P("| variant | decode+validate (ms) | bare startup `-c pass` (ms) | Δ startup |");
P("|---|--:|--:|--:|");
const bSt = R.startupBare[BASE]?.median;
for (const v of vs) {
  P(`| ${LABEL[v] ?? v} | ${R.validate[v] ? R.validate[v].median.toFixed(1) : "—"} | ${R.startupBare[v]?.median ?? "—"} | ${R.startupBare[v] ? sp(pct(R.startupBare[v].median, bSt)) : "—"} |`);
}
P();

// 3 cold
P("## 3. Cold isolated — fresh process, one benchmark, one iteration");
P();
P("Wall time of the whole process: instantiate + lazy-compile the handlers that benchmark");
P("touches + execute. **This is the metric that matches AVLO's workload** (restore a snapshot,");
P("run one user block). Speedup vs baseline; >1.00 = faster.");
P();
P("| variant | " + B.map((b) => b.replace(/_/g, " ")).join(" | ") + " | **geomean** |");
P("|---|" + B.map(() => "--:").join("|") + "|--:|");
for (const v of vs) {
  const rs = [];
  const cells = B.map((b) => {
    const a = R.cold[BASE]?.[b], c = R.cold[v]?.[b];
    if (!a || !c) return "—";
    const r = a.median / c.median; rs.push(r); return r.toFixed(2);
  });
  P(`| ${LABEL[v] ?? v} | ${cells.join(" | ")} | **${geo(rs).toFixed(3)}** |`);
}
P();
P("Absolute cold medians (ms):");
P();
P("| variant | " + B.map((b) => b.replace(/_/g, " ")).join(" | ") + " | total |");
P("|---|" + B.map(() => "--:").join("|") + "|--:|");
for (const v of vs) {
  const cells = B.map((b) => (R.cold[v]?.[b] ? R.cold[v][b].median : "—"));
  const tot = B.reduce((a, b) => a + (R.cold[v]?.[b]?.median ?? 0), 0);
  P(`| ${LABEL[v] ?? v} | ${cells.join(" | ")} | ${tot} |`);
}
P();

// 4 steady
for (const [eng, tier, title] of [
  ["node26", "default", "node26 (V8 14.6 ≈ Chrome 145), default tier"],
  ["node26", "liftoff", "node26, `--liftoff-only` (baseline tier only)"],
  ["node24", "default", "node24 (V8 13.6), default tier"],
]) {
  const base = R.steady[`${BASE}|${eng}|${tier}`];
  if (!base) continue;
  P(`## Steady state — ${title}`);
  P();
  P("Speedup vs baseline, median of 9 in-process iterations. >1.00 = faster.");
  P();
  P("| variant | " + B.map((b) => b.replace(/_/g, " ")).join(" | ") + " | **geomean** |");
  P("|---|" + B.map(() => "--:").join("|") + "|--:|");
  for (const v of vs) {
    const r = R.steady[`${v}|${eng}|${tier}`];
    if (!r) continue;
    const rs = [];
    const cells = B.map((b) => {
      if (!r[b] || !base[b]) return "—";
      const x = base[b].median / r[b].median; rs.push(x); return x.toFixed(2);
    });
    P(`| ${LABEL[v] ?? v} | ${cells.join(" | ")} | **${geo(rs).toFixed(3)}** |`);
  }
  P();
}

P("## Absolute steady-state medians (node26 default, ms)");
P();
P("| variant | " + B.map((b) => b.replace(/_/g, " ")).join(" | ") + " |");
P("|---|" + B.map(() => "--:").join("|") + "|");
for (const v of vs) {
  const r = R.steady[`${v}|node26|default`];
  if (!r) continue;
  P(`| ${LABEL[v] ?? v} | ${B.map((b) => (r[b] ? r[b].median.toFixed(1) : "—")).join(" | ")} |`);
}
P();

writeFileSync(`${TC}/REPORT.md`, L.join("\n"));
console.log(L.join("\n"));
