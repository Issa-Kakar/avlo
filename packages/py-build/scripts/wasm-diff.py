#!/usr/bin/env python3
"""Bucket the byte difference between two wasm binaries — the tool that rooted
the "cpython nukes are not byte-reproducible" finding (NOTES learnings,
2026-09-02). Per section, per code function, per data segment, plus the
build-info strings (`__DATE__`/`__TIME__` from CPython's getbuildinfo.c) and
a shift-alignment probe after the first divergence (a merged-string-table
insertion shows up as "matches at delta +N" where N = strlen(new string)+1).

  uv run python scripts/wasm-diff.py A.wasm B.wasm

Same-size inputs give per-section diffs; different-size inputs still get the
section table + strings so you can see WHERE the layout moved.
"""

import re
import sys

NAMES = {0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global",
         7: "export", 8: "start", 9: "elem", 10: "code", 11: "data", 12: "datacount", 13: "tag"}


def leb(buf, pos):
    r = s = 0
    while True:
        b = buf[pos]
        pos += 1
        r |= (b & 0x7F) << s
        s += 7
        if not b & 0x80:
            return r, pos


def sections(buf):
    pos, out = 8, []
    while pos < len(buf):
        sid = buf[pos]
        pos += 1
        size, pos = leb(buf, pos)
        name = None
        if sid == 0:
            n, p2 = leb(buf, pos)
            name = buf[p2 : p2 + n].decode("utf8", "replace")
        out.append((sid, name, pos, size))
        pos += size
    return out


def ndiff(a, b, lo, hi):
    return sum(1 for i in range(lo, hi) if a[i] != b[i])


def strings(buf, tag):
    for m in re.finditer(rb"\x00([A-Z][a-z]{2} [ \d]\d \d{4})\x00", buf):
        print(f"  {tag} __DATE__ {m.group(1).decode()!r} at {m.start() + 1}")
    for m in re.finditer(rb"\x00(\d\d:\d\d:\d\d)\x00", buf):
        print(f"  {tag} __TIME__ {m.group(1).decode()!r} at {m.start() + 1}")
    m = re.search(rb"Clang [^\x00]{5,120}", buf)
    if m:
        print(f"  {tag} compiler {m.group(0)[:100].decode('ascii', 'replace')!r}")


def main(pa, pb):
    a, b = open(pa, "rb").read(), open(pb, "rb").read()
    print(f"sizes {len(a)} {len(b)}")
    sa, sb = sections(a), sections(b)
    same_layout = [(s, n, sz) for s, n, _, sz in sa] == [(s, n, sz) for s, n, _, sz in sb]
    print("section layout", "IDENTICAL" if same_layout else "DIFFERS")
    for (sid, name, off, sz), (_, _, offb, szb) in zip(sa, sb):
        d = ndiff(a, b, off, off + sz) if same_layout else "-"
        print(f"  {NAMES.get(sid, sid):10s} {name or '':12s} off={off:9d} size={sz:9d} diff={d}")
    print("build-info strings:")
    strings(a, "A")
    strings(b, "B")
    if not same_layout:
        return
    for sid, name, off, sz in sa:
        if sid == 10:
            pos = off
            n, pos = leb(a, pos)
            diffs = []
            for fi in range(n):
                fsz, p2 = leb(a, pos)
                d = ndiff(a, b, p2, p2 + fsz)
                if d:
                    diffs.append((fi, fsz, d))
                pos = p2 + fsz
            print(f"code: {n} funcs, {len(diffs)} differ, {sum(d for *_, d in diffs)} bytes; first 12: {diffs[:12]}")
        if sid == 11:
            pos = off
            n, pos = leb(a, pos)
            diffs, first = [], None
            for si in range(n):
                flags, pos = leb(a, pos)
                base = None
                if flags in (0, 2):
                    if flags == 2:
                        _, pos = leb(a, pos)
                    assert a[pos] == 0x41
                    pos += 1
                    base, pos = leb(a, pos)
                    assert a[pos] == 0x0B
                    pos += 1
                dsz, p2 = leb(a, pos)
                d = ndiff(a, b, p2, p2 + dsz)
                if d:
                    fo = next(i for i in range(p2, p2 + dsz) if a[i] != b[i])
                    diffs.append((si, hex(base) if base is not None else None, dsz, d, fo - p2))
                    if first is None:
                        first = fo
                pos = p2 + dsz
            print(f"data: {n} segments, {len(diffs)} differ, {sum(d for *_, d, _ in diffs)} bytes; "
                  f"(seg, base, size, diff, firstOff) first 10: {diffs[:10]}")
            if first is not None:
                lo, hi = max(0, first - 160), first + 96
                for buf, tag in ((a, "A"), (b, "B")):
                    print(f"  {tag} around first diff: {re.sub(rb'[^\x20-\x7e]', b'.', buf[lo:hi]).decode()}")
                span = min(3000, len(a) - first - 64)
                for delta in (-24, -16, -12, -9, -8, -4, 4, 8, 9, 12, 16, 24):
                    if 0 <= first + delta and first + span + delta < len(b):
                        m = sum(1 for i in range(first, first + span) if a[i] == b[i + delta])
                        if m > span * 0.5:
                            print(f"  shift probe: A[i] == B[i{delta:+d}] for {m}/{span} bytes after the divergence")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
