"""Shared pack-time primitives for pack-stdlib.py / pack-package.py.

Everything here serves byte-reproducibility (G0/G-M2.R):
- ensure_hashseed(): marshalled frozensets/dicts in .pyc bodies iterate in
  hash order — pack scripts re-exec themselves under PYTHONHASHSEED=0 so two
  runs marshal identically.
- deterministic writers: fixed dates/mtimes, sorted entries, per-entry
  compression settings (an explicit ZipInfo IGNORES the archive default —
  pass compress_type per entry).
- canonical_json(): one JSON byte-form for meta.json and post-processed
  caches (sorted keys, compact separators).

Prune rules ('name/' tree, 'name.py' module) map to EXACT dotted tombstone
keys ('xml/sax/' -> 'xml.sax') — the sitecustomize finder walks dotted
prefixes longest-first, so pruned subtrees tombstone without claiming their
shipped parents (the pre-D6 bug).
"""

import io
import json
import os
import py_compile
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ZIP_FIXED_DATE = (2026, 1, 1, 0, 0, 0)
TAR_MTIME = 1767225600  # 2026-01-01T00:00:00Z


def ensure_hashseed() -> None:
    """Re-exec under PYTHONHASHSEED=0 (idempotent). Call before any work."""
    if os.environ.get("PYTHONHASHSEED") != "0":
        os.execve(
            sys.executable,
            [sys.executable, *sys.argv],
            {**os.environ, "PYTHONHASHSEED": "0"},
        )


def compile_pyc(source: bytes, dfile: str, optimize: int) -> bytes:
    """py source -> UNCHECKED_HASH pyc bytes; dfile becomes co_filename."""
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


def load_prune_rules(path: Path) -> list[str]:
    rules = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            rules.append(line)
    return rules


def is_pruned(name: str, rules: list[str]) -> bool:
    """name = archive-relative path. Rules: exact file or 'dir/' prefix."""
    return any(name == r or (r.endswith("/") and name.startswith(r)) for r in rules)


def dotted_key(rule: str) -> str:
    """Prune rule -> exact dotted tombstone key: 'xml/sax/' -> 'xml.sax'."""
    return rule.rstrip("/").removesuffix(".py").replace("/", ".")


def is_module_rule(rule: str) -> bool:
    """Only package trees and .py modules mint tombstones — a pruned DATA
    file (dateutil's tz tarball) or non-importable dir (mpl-data/) has no
    importable name."""
    if not (rule.endswith("/") or rule.endswith(".py")):
        return False
    base = rule.rstrip("/").removesuffix(".py")
    return all(seg.isidentifier() for seg in base.split("/"))


def parse_reasons(path: Path, default: str) -> dict[str, str]:
    """dotted key -> nearest preceding '# reason:' comment, per rule."""
    reasons: dict[str, str] = {}
    current = default
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("# reason:"):
            current = line.removeprefix("# reason:").strip()
        elif line and not line.startswith("#"):
            reasons[dotted_key(line)] = current
    return reasons


def registry_source(module_doc: str, pruned: dict[str, str]) -> bytes:
    """Generated tombstone-registry module source (sorted, reproducible)."""
    lines = [f"# GENERATED {module_doc} — do not edit", "PRUNED = {"]
    for key, why in sorted(pruned.items()):
        lines.append(f"    {key!r}: {why!r},")
    lines.append("}")
    return "\n".join(lines).encode()


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def write_zip(out_path: Path, entries: dict[str, bytes]) -> bytes:
    """Deterministic DEFLATED(9) zip, sorted entries, fixed date. Returns bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name in sorted(entries):
            zi = zipfile.ZipInfo(name, date_time=ZIP_FIXED_DATE)
            zi.external_attr = 0o644 << 16
            # explicit ZipInfo bypasses the archive default -> set per-entry
            out.writestr(zi, entries[name], zipfile.ZIP_DEFLATED, 9)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data


def write_tar(out_path: Path, entries: list[tuple[str, bytes]]) -> bytes:
    """Deterministic ustar in the GIVEN order (caller puts meta.json first,
    rest sorted). Files only, mode 0644, uid/gid 0, empty uname/gname,
    fixed mtime. USTAR caps names at 100 chars — pre-checked, no silent
    GNU-format fallback. Returns bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as out:
        for name, data in entries:
            if len(name) > 100:
                raise ValueError(f"ustar name over 100 chars: {name}")
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mtime = TAR_MTIME
            ti.mode = 0o644
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            out.addfile(ti, io.BytesIO(data))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = buf.getvalue()
    out_path.write_bytes(data)
    return data
