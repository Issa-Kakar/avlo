// Minimal wasm binary parser shared by analyze-dsos.mjs and verify-groups.mjs:
// sections 2 (imports: func/global/tag kinds only) + 7 (export names) + the
// dylink.0 custom section (MEM_INFO, NEEDED, export/import flags). Enough for
// the DSO census / grouping gates — not a general decoder.

function leb(buf, s) {
  let r = 0,
    sh = 0;
  for (;;) {
    const b = buf[s.p++];
    r |= (b & 0x7f) << sh;
    if (!(b & 0x80)) break;
    sh += 7;
  }
  return r >>> 0;
}
function str(buf, s) {
  const n = leb(buf, s);
  const v = buf.toString('utf8', s.p, s.p + n);
  s.p += n;
  return v;
}
function limits(buf, s) {
  const f = buf[s.p++];
  leb(buf, s);
  if (f & 1) leb(buf, s);
}

export function parseWasm(buf, wantDylink = true) {
  const s = { p: 8 };
  const out = { imports: [], exports: [], dylink: null };
  while (s.p < buf.length) {
    const id = buf[s.p++];
    const size = leb(buf, s);
    const end = s.p + size;
    if (id === 0) {
      const name = str(buf, s);
      if (wantDylink && name === 'dylink.0') {
        const d = { memSize: 0, tableSize: 0, needed: [], exportInfo: {}, importInfo: {} };
        while (s.p < end) {
          const sub = buf[s.p++];
          const subEnd = s.p + leb(buf, s);
          if (sub === 1) {
            d.memSize = leb(buf, s);
            leb(buf, s);
            d.tableSize = leb(buf, s);
            leb(buf, s);
          } else if (sub === 2) {
            for (let n = leb(buf, s); n--; ) d.needed.push(str(buf, s));
          } else if (sub === 3) {
            for (let n = leb(buf, s); n--; ) {
              const nm = str(buf, s);
              d.exportInfo[nm] = leb(buf, s);
            }
          } else if (sub === 4) {
            for (let n = leb(buf, s); n--; ) {
              const m = str(buf, s);
              const f = str(buf, s);
              d.importInfo[`${m}.${f}`] = leb(buf, s);
            }
          }
          s.p = subEnd;
        }
        out.dylink = d;
      }
    } else if (id === 2) {
      for (let n = leb(buf, s); n--; ) {
        const mod = str(buf, s);
        const field = str(buf, s);
        const kind = buf[s.p++];
        if (kind === 0) {
          leb(buf, s);
          out.imports.push({ mod, field, kind: 'func' });
        } else if (kind === 1) {
          s.p++;
          limits(buf, s);
        } else if (kind === 2) {
          limits(buf, s);
        } else if (kind === 3) {
          s.p += 2;
          out.imports.push({ mod, field, kind: 'global' });
        } else if (kind === 4) {
          s.p++;
          leb(buf, s);
          out.imports.push({ mod, field, kind: 'tag' });
        } else throw new Error(`bad import kind ${kind}`);
      }
    } else if (id === 7) {
      for (let n = leb(buf, s); n--; ) {
        const name = str(buf, s);
        s.p++;
        leb(buf, s);
        out.exports.push(name);
      }
    }
    s.p = end;
  }
  return out;
}

/** dlopen-relevant imports, matching the census filter: env/GOT.mem/GOT.func
 * mods only, invoke_* trampolines and dylink plumbing excluded. */
export const PLUMBING = new Set(['__memory_base', '__table_base', '__stack_pointer', '__indirect_function_table', 'memory', '__heap_base']);
export function censusImports(parsed) {
  return parsed.imports
    .filter((i) => i.mod === 'env' || i.mod === 'GOT.mem' || i.mod === 'GOT.func')
    .filter((i) => !i.field.startsWith('invoke_') && !PLUMBING.has(i.field));
}
