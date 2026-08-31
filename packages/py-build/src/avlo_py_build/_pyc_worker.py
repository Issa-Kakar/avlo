"""Hermetic pyc-compile worker. Executed BY PATH (never -m) as a standalone
subprocess:  python _pyc_worker.py <jobs.json>

  jobs.json: [[src_path, dest_path, dfile, optimize], ...]

WHY THIS EXISTS — read before touching the import list below. Marshal encodes
interned-string state, so a pyc's BYTES depend on which modules the compiling
process imported first (proven flip: compiling stdlib argparse.py before vs
after `import argparse` yields different bytes; the sensitivity is
value-specific and self-import-shaped). The committed build-lock's bytes were
produced by pack scripts whose import surface was exactly packlib's stdlib
set — so compilation now happens ONLY in these workers, whose surface is
FROZEN to that historic set. The orchestrating CLI can grow any dependency it
likes (pydantic, httpx, …) without touching artifact bytes.

THE IMPORT LIST BELOW IS THE DETERMINISM CONTRACT. Every import is
deliberate, including the "unused" ones — do not clean them up, reorder them,
or add to them outside a planned buildHash rotation.
"""

# ── frozen import surface (mirrors the legacy pack-stdlib.py process) ──────
import hashlib  # noqa: F401  — part of the frozen surface
import io  # noqa: F401
import json
import os  # noqa: F401
import py_compile
import sys
import tarfile  # noqa: F401
import tempfile
import zipfile  # noqa: F401
from pathlib import Path

# ────────────────────────────────────────────────────────────────────────────

assert os.environ.get("PYTHONHASHSEED") == "0", "_pyc_worker requires PYTHONHASHSEED=0 (marshalled set order)"


def compile_pyc(source: bytes, dfile: str, optimize: int) -> bytes:
    """py source -> UNCHECKED_HASH pyc bytes; dfile becomes co_filename.
    (Same contract as packlib.compile_pyc — inlined so this file stays
    import-hermetic.)"""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "m.py"
        src.write_bytes(source)
        pyc = Path(td) / "m.pyc"
        py_compile.compile(
            str(src),
            cfile=str(pyc),
            dfile=dfile,
            doraise=True,
            optimize=optimize,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
        return pyc.read_bytes()


def main() -> None:
    jobs = json.loads(Path(sys.argv[1]).read_text())
    for src, dest, dfile, optimize in jobs:
        try:
            Path(dest).write_bytes(compile_pyc(Path(src).read_bytes(), dfile, optimize))
        except py_compile.PyCompileError as e:
            # Source that won't compile: leave a marker; the orchestrator
            # decides (stdlib pack ships the source as fallback, bundle pack
            # hard-fails on any missing dest).
            Path(dest + ".fail").write_text(str(e))


if __name__ == "__main__":
    main()
