"""Shared pack-time primitives for the pack-stdlib / pack-bundles commands.

Everything here serves byte-reproducibility (G0/G-M2.R):
- ensure_hashseed(): marshalled frozensets/dicts in .pyc bodies iterate in
  hash order — the CLI re-execs itself under PYTHONHASHSEED=0 so two runs
  marshal identically.
- deterministic writers: fixed dates/mtimes, sorted entries, per-entry
  compression settings (an explicit ZipInfo IGNORES the archive default —
  pass compress_type per entry).
- canonical_json(): one JSON byte-form for meta.json and post-processed
  caches (sorted keys, compact separators).

pyc COMPILATION deliberately does not live here: pyc bytes depend on the
compiling process's import history (marshal encodes interned-string state),
so every artifact pyc compiles in the hermetic _pyc_worker subprocesses via
pyc_compile.py — never in the orchestrating process.

Prune rules ('name/' tree, 'name.py' module) map to EXACT dotted tombstone
keys ('xml/sax/' -> 'xml.sax') — the sitecustomize finder walks dotted
prefixes longest-first, so pruned subtrees tombstone without claiming their
shipped parents (the pre-D6 bug).
"""

import io
import json
import os
import sys
import tarfile
import zipfile
from pathlib import Path

ZIP_FIXED_DATE = (2026, 1, 1, 0, 0, 0)
TAR_MTIME = 1767225600  # 2026-01-01T00:00:00Z


def ensure_hashseed() -> None:
    """Re-exec under PYTHONHASHSEED=0 (idempotent). cli.main() calls this
    before dispatch; nothing else should need to."""
    if os.environ.get("PYTHONHASHSEED") != "0":
        os.execve(
            sys.executable,
            [sys.executable, "-m", "avlo_py_build", *sys.argv[1:]],
            {**os.environ, "PYTHONHASHSEED": "0"},
        )


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


def zip_bytes(entries: dict[str, bytes], *, codec: str = "deflate", level: int = 9) -> bytes:
    """Deterministic zip, sorted entries, fixed date. Codec/level come from
    config `pack.stdlibZip` (the RO-FS phase flips deflate→stored as a config
    edit, not a code hunt)."""
    compress_type = {"deflate": zipfile.ZIP_DEFLATED, "stored": zipfile.ZIP_STORED}[codec]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compress_type, compresslevel=level) as out:
        for name in sorted(entries):
            zi = zipfile.ZipInfo(name, date_time=ZIP_FIXED_DATE)
            zi.external_attr = 0o644 << 16
            # explicit ZipInfo bypasses the archive default -> set per-entry
            out.writestr(zi, entries[name], compress_type, level)
    return buf.getvalue()


def write_zip(out_path: Path, entries: dict[str, bytes], *, codec: str = "deflate", level: int = 9) -> bytes:
    data = zip_bytes(entries, codec=codec, level=level)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    return data


def tar_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    """Deterministic ustar in the GIVEN order (caller puts meta.json first,
    rest sorted). Files only, mode 0644, uid/gid 0, empty uname/gname,
    fixed mtime. USTAR caps names at 100 chars — pre-checked, no silent
    GNU-format fallback."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as out:
        for name, data in entries:
            if len(name) > 100:
                raise ValueError(f"ustar name over 100 chars: {name}")
            if not name.isascii():
                # The client-side walker (web/src/core/py/py-mount.ts) parses
                # names with a charCode loop — ASCII-only by contract.
                raise ValueError(f"tar name is not ASCII: {name}")
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mtime = TAR_MTIME
            ti.mode = 0o644
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            out.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def write_tar(out_path: Path, entries: list[tuple[str, bytes]]) -> bytes:
    data = tar_bytes(entries)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    return data


def parse_tar_meta(buf: bytes) -> dict:
    """First-entry meta.json via a single 512-byte ustar header parse — the
    same contract the shipped walker (py-mount.ts parseTarMeta) relies on."""
    name = buf[0:100].split(b"\0", 1)[0].decode("ascii")
    if name != "meta.json":
        raise ValueError(f"first tar entry is {name!r}, want meta.json")
    size = int(buf[124:136].split(b"\0", 1)[0].decode("ascii"), 8)
    return json.loads(buf[512 : 512 + size])
