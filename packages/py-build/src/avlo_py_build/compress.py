"""Pre-compress every servable artifact to a .br sibling (brotli quality from
config `pack.brotliQuality` — the bytes R2 will store; the py worker
negotiates via Accept-Encoding). Skips up-to-date siblings (mtime marker)
unless --force. Artifacts compress across a process pool (the brotli binding
holds the GIL; pandas.tar at q11 is the pole).

  avlo-build compress [--force]
"""

import os
import time
from concurrent.futures import ProcessPoolExecutor

from .config import load
from .paths import BUNDLES_OUT, PKG_ROOT

_POOL = min(os.cpu_count() or 2, 4)


def _artifact_rels() -> list[str]:
    rels = ["dist/raw/pyodide.asm.mjs", "dist/raw/pyodide.asm.wasm", "dist/raw/pyodide.mjs", "dist/stage/python_stdlib.zip"]
    if BUNDLES_OUT.is_dir():
        rels += [f"dist/stage/bundles/{p.name}" for p in sorted(BUNDLES_OUT.glob("*.tar"))]
    return rels


def _compress_one(rel: str, quality: int) -> str:
    import brotli  # imported in the worker process

    p = PKG_ROOT / rel
    raw = p.read_bytes()
    t0 = time.monotonic()
    out = brotli.compress(raw, quality=quality)
    p.with_name(p.name + ".br").write_bytes(out)
    return (
        f"{rel}: {len(raw) / 1e6:.2f} MB -> {len(out) / 1e6:.2f} MB br "
        f"({len(out) / len(raw) * 100:.0f}%, {time.monotonic() - t0:.1f}s)"
    )


def run(args) -> int:
    quality = load().pack.brotliQuality
    todo: list[str] = []
    bad = 0
    for rel in _artifact_rels():
        p = PKG_ROOT / rel
        if not p.exists():
            print(f"missing artifact: {rel} (build it first)")
            bad = 1
            continue
        br = p.with_name(p.name + ".br")
        if not args.force and br.exists() and br.stat().st_mtime >= p.stat().st_mtime:
            print(f"up-to-date {rel}.br")
            continue
        todo.append(rel)
    if todo:
        with ProcessPoolExecutor(_POOL) as pool:
            for line in pool.map(_compress_one, todo, [quality] * len(todo)):
                print(line)
    return bad
