"""Fan pyc compilation out to the hermetic _pyc_worker subprocesses.

All artifact pycs — stdlib, bundles, generated registries — compile HERE,
never in the orchestrating process: pyc bytes depend on the compiling
process's import history (see _pyc_worker.py), so the CLI's own imports must
never reach a compile. Workers inherit PYTHONHASHSEED=0 from the CLI's
re-exec; job order is byte-irrelevant (each job writes its own pre-created
destination path).
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_WORKER = Path(__file__).with_name("_pyc_worker.py")
_JOBS = min(os.cpu_count() or 2, 8)

Job = tuple[str, str, str, int]  # (src_path, dest_path, dfile, optimize)


def _run_workers(jobs: list[Job]) -> None:
    if not jobs:
        return
    width = min(_JOBS, max(1, len(jobs) // 16), len(jobs))
    chunks = [jobs[i::width] for i in range(width)]
    with tempfile.TemporaryDirectory() as td:
        procs = []
        for i, chunk in enumerate(chunks):
            jf = Path(td) / f"jobs{i}.json"
            jf.write_text(json.dumps(chunk))
            procs.append(subprocess.Popen([sys.executable, str(_WORKER), str(jf)]))
        for p in procs:
            if p.wait() != 0:
                sys.exit("pyc worker failed")


def compile_files(jobs: list[Job]) -> None:
    """Compile every (src, dest, dfile, optimize) job across worker processes.
    Any uncompilable source is fatal here (a wheel .py that stops compiling is
    a pin bug, never something to ship around)."""
    _run_workers(jobs)
    bad = [dest for _, dest, _, _ in jobs if not Path(dest).exists()]
    if bad:
        sys.exit(f"pyc compile failed for {len(bad)} file(s), first: {bad[0]} (see {bad[0]}.fail)")


def compile_bytes(items: list[tuple[bytes, str, int]]) -> list[bytes | str]:
    """Compile in-memory sources: [(source, dfile, optimize)] -> pyc bytes in
    input order; an uncompilable source yields its error STRING instead (the
    stdlib pack ships the source as fallback)."""
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        jobs: list[Job] = []
        for i, (source, dfile, optimize) in enumerate(items):
            src = root / f"{i}.py"
            src.write_bytes(source)
            jobs.append((str(src), str(root / f"{i}.pyc"), dfile, optimize))
        _run_workers(jobs)
        out: list[bytes | str] = []
        for i in range(len(items)):
            pyc = root / f"{i}.pyc"
            out.append(pyc.read_bytes() if pyc.exists() else (root / f"{i}.pyc.fail").read_text())
        return out


def compile_one(source: bytes, dfile: str, optimize: int) -> bytes:
    result = compile_bytes([(source, dfile, optimize)])[0]
    if isinstance(result, str):
        sys.exit(f"pyc compile failed for {dfile}: {result}")
    return result
