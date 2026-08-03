// Structural analysis of a wasm module: section sizes, per-function body sizes,
// name-section lookup. Tests the "megafunction vs N small functions" hypothesis
// directly. No opcode decoding needed — the code section carries explicit
// per-body byte lengths.
import { readFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const SECTION_NAMES = {
  0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory",
  6: "global", 7: "export", 8: "start", 9: "element", 10: "code", 11: "data",
  12: "datacount", 13: "tag",
};

export function analyze(path) {
  const buf = readFileSync(path);
  let p = 8; // skip magic + version

  const u32 = () => {
    let r = 0, s = 0, b;
    do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return r >>> 0;
  };
  const str = () => { const n = u32(); const s = buf.toString("utf8", p, p + n); p += n; return s; };

  const sections = [];
  let codeStart = -1, codeEnd = -1, importedFuncs = 0, declaredFuncs = 0;
  const names = new Map();

  while (p < buf.length) {
    const id = buf[p++];
    const size = u32();
    const start = p;
    sections.push({ id, name: SECTION_NAMES[id] ?? `id${id}`, size });

    if (id === 2) {
      // import section — count function imports (they occupy low func indices)
      const n = u32();
      for (let i = 0; i < n; i++) {
        str(); str();                       // module, field
        const kind = buf[p++];
        if (kind === 0) { u32(); importedFuncs++; }
        else if (kind === 1) { p++; const lim = buf[p++]; u32(); if (lim & 1) u32(); }
        else if (kind === 2) { const lim = buf[p++]; u32(); if (lim & 1) u32(); }
        else if (kind === 3) { p++; p++; }
        else if (kind === 4) { p++; u32(); }
      }
    } else if (id === 3) {
      declaredFuncs = u32();
    } else if (id === 7) {
      // export section — recovers names when the name section is stripped (-g0).
      // The tail-dispatch patch marks every _TAIL_CALL_* with export_name.
      const n = u32();
      for (let i = 0; i < n; i++) {
        const nm = str();
        const kind = buf[p++];
        const idx = u32();
        if (kind === 0 && !names.has(idx)) names.set(idx, nm);
      }
    } else if (id === 10) {
      codeStart = start; codeEnd = start + size;
    } else if (id === 0) {
      const save = p;
      const cname = str();
      if (cname === "name") {
        const end = start + size;
        while (p < end) {
          const sub = buf[p++];
          const subSize = u32();
          const subEnd = p + subSize;
          if (sub === 1) {
            const cnt = u32();
            for (let i = 0; i < cnt; i++) { const idx = u32(); names.set(idx, str()); }
          }
          p = subEnd;
        }
      }
      p = save;
    }
    p = start + size;
  }

  // per-function body sizes from the code section
  const bodies = [];
  if (codeStart >= 0) {
    p = codeStart;
    const n = u32();
    for (let i = 0; i < n; i++) {
      const bodySize = u32();
      bodies.push({ idx: importedFuncs + i, size: bodySize, name: names.get(importedFuncs + i) ?? null });
      p += bodySize;
    }
  }

  const codeSection = sections.find((s) => s.id === 10)?.size ?? 0;
  const sorted = [...bodies].sort((a, b) => b.size - a.size);
  const tailCall = bodies.filter((b) => b.name?.startsWith("_TAIL_CALL_"));
  const evalFrame = bodies.filter((b) => b.name && /_PyEval_EvalFrameDefault/.test(b.name));
  const dispatcher = bodies.filter((b) => b.name === "tail_call_dispatcher");

  return {
    file: path,
    wasmBytes: buf.length,
    brotliBytes: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
    codeSectionBytes: codeSection,
    importedFuncs,
    declaredFuncs,
    bodyCount: bodies.length,
    largestFunc: sorted[0] ? { name: sorted[0].name, size: sorted[0].size } : null,
    top10: sorted.slice(0, 10).map((f) => ({ name: f.name, size: f.size })),
    evalFrameDefault: evalFrame.map((f) => ({ name: f.name, size: f.size })),
    evalFrameTotal: evalFrame.reduce((a, b) => a + b.size, 0),
    tailCallFuncs: tailCall.length,
    tailCallTotalBytes: tailCall.reduce((a, b) => a + b.size, 0),
    tailCallMaxBytes: tailCall.length ? Math.max(...tailCall.map((f) => f.size)) : 0,
    tailCallMedianBytes: tailCall.length
      ? [...tailCall].sort((a, b) => a.size - b.size)[Math.floor(tailCall.length / 2)].size
      : 0,
    dispatcherBytes: dispatcher.length ? dispatcher[0].size : 0,
    sections: sections.map((s) => ({ name: s.name, size: s.size })),
  };
}

if (process.argv[1] && process.argv[1].endsWith("analyze-wasm.mjs")) {
  console.log(JSON.stringify(analyze(process.argv[2]), null, 2));
}
