"""Minimal wasm binary parser (was scripts/lib/wasm-parse.mjs): sections 2
(imports: func/global/tag kinds only) + 7 (export names) + the dylink.0
custom section (MEM_INFO, NEEDED, export/import flags). Enough for the DSO
census / grouping gates / link.rsp generation — not a general decoder.

Honesty note from the replatform plan (§2.9): this port exists for the
language policy and to delete duplicated container-readers — the mjs parser
was already fast (0.3–0.8 ms per module; the "native" WebAssembly.Module
route is SLOWER because it validates and compiles).
"""

from dataclasses import dataclass, field


@dataclass
class Dylink:
    memSize: int = 0
    tableSize: int = 0
    needed: list[str] = field(default_factory=list)
    exportInfo: dict[str, int] = field(default_factory=dict)
    importInfo: dict[str, int] = field(default_factory=dict)


@dataclass
class ParsedWasm:
    imports: list[tuple[str, str, str]] = field(default_factory=list)  # (mod, field, kind)
    exports: list[str] = field(default_factory=list)
    dylink: Dylink | None = None


def _leb(buf: bytes, s: list[int]) -> int:
    r = 0
    sh = 0
    while True:
        b = buf[s[0]]
        s[0] += 1
        r |= (b & 0x7F) << sh
        if not (b & 0x80):
            break
        sh += 7
    return r


def _str(buf: bytes, s: list[int]) -> str:
    n = _leb(buf, s)
    v = buf[s[0] : s[0] + n].decode("utf-8")
    s[0] += n
    return v


def _limits(buf: bytes, s: list[int]) -> None:
    f = buf[s[0]]
    s[0] += 1
    _leb(buf, s)
    if f & 1:
        _leb(buf, s)


def parse_wasm(buf: bytes, want_dylink: bool = True) -> ParsedWasm:
    s = [8]
    out = ParsedWasm()
    n_buf = len(buf)
    while s[0] < n_buf:
        sec_id = buf[s[0]]
        s[0] += 1
        size = _leb(buf, s)
        end = s[0] + size
        if sec_id == 0:
            name = _str(buf, s)
            if want_dylink and name == "dylink.0":
                d = Dylink()
                while s[0] < end:
                    sub = buf[s[0]]
                    s[0] += 1
                    # NB: read the length FIRST, then anchor the end — the mjs
                    # original inlined `s.p + leb(buf, s)`, whose left-to-right
                    # evaluation anchored one byte short; harmless on shipped
                    # MEM_INFO-only dylinks (the outer section snap rescued
                    # it), wrong for any multi-subsection dylink.0.
                    sub_size = _leb(buf, s)
                    sub_end = s[0] + sub_size
                    if sub == 1:
                        d.memSize = _leb(buf, s)
                        _leb(buf, s)
                        d.tableSize = _leb(buf, s)
                        _leb(buf, s)
                    elif sub == 2:
                        for _ in range(_leb(buf, s)):
                            d.needed.append(_str(buf, s))
                    elif sub == 3:
                        for _ in range(_leb(buf, s)):
                            nm = _str(buf, s)
                            d.exportInfo[nm] = _leb(buf, s)
                    elif sub == 4:
                        for _ in range(_leb(buf, s)):
                            m = _str(buf, s)
                            f = _str(buf, s)
                            d.importInfo[f"{m}.{f}"] = _leb(buf, s)
                    s[0] = sub_end
                out.dylink = d
        elif sec_id == 2:
            for _ in range(_leb(buf, s)):
                mod = _str(buf, s)
                fld = _str(buf, s)
                kind = buf[s[0]]
                s[0] += 1
                if kind == 0:
                    _leb(buf, s)
                    out.imports.append((mod, fld, "func"))
                elif kind == 1:
                    s[0] += 1
                    _limits(buf, s)
                elif kind == 2:
                    _limits(buf, s)
                elif kind == 3:
                    s[0] += 2
                    out.imports.append((mod, fld, "global"))
                elif kind == 4:
                    s[0] += 1
                    _leb(buf, s)
                    out.imports.append((mod, fld, "tag"))
                else:
                    raise ValueError(f"bad import kind {kind}")
        elif sec_id == 7:
            for _ in range(_leb(buf, s)):
                name = _str(buf, s)
                s[0] += 1
                _leb(buf, s)
                out.exports.append(name)
        s[0] = end
    return out


# dlopen-relevant imports, matching the census filter: env/GOT.mem/GOT.func
# mods only, invoke_* trampolines and dylink plumbing excluded.
PLUMBING = frozenset(
    ["__memory_base", "__table_base", "__stack_pointer", "__indirect_function_table", "memory", "__heap_base"]
)


def census_imports(parsed: ParsedWasm) -> list[tuple[str, str, str]]:
    return [
        (mod, fld, kind)
        for (mod, fld, kind) in parsed.imports
        if mod in ("env", "GOT.mem", "GOT.func") and not fld.startswith("invoke_") and fld not in PLUMBING
    ]
