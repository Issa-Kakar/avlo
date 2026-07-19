#!/usr/bin/env python3.14
"""Build the pruned, pyc-only stdlib zip for the AVLO Python runtime.

Input : dist/raw/python_stdlib.zip  (fork build output)
        config/stdlib-prune.txt     (committed prune list)
        overlay/stdlib/*.py         (sitecustomize, _avlo_runtime, ...)
Output: dist/stage/python_stdlib.zip
        dist/stage/stdlib-modules.json  (top-level names for the generated
                                         import-gate allowlist, D9)

Must run under the CPython minor pinned in build.config.json (pyc MAGIC must
match the wasm interpreter); re-execs itself with PYTHONHASHSEED=0
(marshalled sets iterate in hash order).

Layout notes:
- zipimport loads `foo.pyc` stored NEXT TO where foo.py would live (legacy
  layout, not __pycache__) — so we compile each .py to a sibling .pyc and ship
  only the .pyc. Source lines vanish from tracebacks for stdlib frames
  (accepted: gate-pinned file+line-only contract).
- unchecked-hash invalidation: restored MEMFS mtimes are meaningless, and
  zipimport wouldn't revalidate anyway — unchecked pycs make the contract
  explicit.
- ZIP_DEFLATED(9): the zip's bytes are MEMFS-resident for the runtime's whole
  life — stored-vs-deflated is 7.2MB vs ~2MB RAM, while zipimport's per-module
  inflate is microseconds and almost every import is baked into a snapshot
  anyway. Sorted entries + fixed timestamps keep it byte-reproducible (G0).
- Tombstone registry keys are EXACT dotted prune paths ('xml.sax', not 'xml')
  so partially-pruned packages keep their shipped parents importable (D6).
"""

import hashlib
import json
import py_compile
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import packlib

packlib.ensure_hashseed()

ROOT = Path(__file__).resolve().parent.parent
SRC_ZIP = ROOT / "dist/raw/python_stdlib.zip"
PRUNE_TXT = ROOT / "config/stdlib-prune.txt"
OVERLAY = ROOT / "overlay/stdlib"
OUT_ZIP = ROOT / "dist/stage/python_stdlib.zip"
OUT_MODULES = ROOT / "dist/stage/stdlib-modules.json"

CONFIG = json.loads((ROOT / "build.config.json").read_text())
# "3.13.2" -> "313" — the zip mounts at /lib/python313.zip in MEMFS.
PYTAG = "".join(CONFIG["toolchain"]["python"].split(".")[:2])
DFILE_PREFIX = f"/lib/python{PYTAG}.zip/"

DEFAULT_REASON = "stripped from the canvas Python build"


def main() -> None:
    want = tuple(int(p) for p in CONFIG["toolchain"]["python"].split(".")[:2])
    if sys.version_info[:2] != want:
        sys.exit(f"need CPython {want[0]}.{want[1]} (pyc magic must match the wasm interpreter), got {sys.version}")
    rules = packlib.load_prune_rules(PRUNE_TXT)
    reasons = packlib.parse_reasons(PRUNE_TXT, DEFAULT_REASON)
    src = zipfile.ZipFile(SRC_ZIP)

    entries: dict[str, bytes] = {}
    pruned: dict[str, str] = {}
    skipped = failed = 0

    for info in sorted(src.infolist(), key=lambda i: i.filename):
        name = info.filename
        if name.endswith("/"):
            continue
        if packlib.is_pruned(name, rules):
            skipped += 1
            continue
        data = src.read(name)
        if name.endswith(".py"):
            try:
                entries[name[:-3] + ".pyc"] = packlib.compile_pyc(
                    data, f"{DFILE_PREFIX}{name}", optimize=2
                )
            except py_compile.PyCompileError as e:
                print(f"!! compile failed, shipping source: {name}: {e}")
                entries[name] = data
                failed += 1
        else:
            entries[name] = data  # data files (encodings aliases etc.)

    # Every prune RULE becomes an exact dotted tombstone (not just its top).
    for rule in rules:
        key = packlib.dotted_key(rule)
        pruned[key] = reasons.get(key, DEFAULT_REASON)

    # Overlay modules (compiled like the rest).
    for p in sorted(OVERLAY.glob("*.py")):
        entries[p.name[:-3] + ".pyc"] = packlib.compile_pyc(
            p.read_bytes(), f"{DFILE_PREFIX}{p.name}", optimize=2
        )

    entries["_avlo_pruned.pyc"] = packlib.compile_pyc(
        packlib.registry_source("by pack-stdlib.py", pruned),
        f"{DFILE_PREFIX}_avlo_pruned.py",
        optimize=2,
    )

    data = packlib.write_zip(OUT_ZIP, entries)

    # D9: the generated import-gate allowlist inputs. `modules` = importable
    # top-level names actually in the zip; `tombstoned` = exact dotted pruned
    # keys (their top-levels stay click-time-allowed — the runtime tombstone
    # error is more precise than a pre-run refusal).
    tops = sorted(
        {n.split("/")[0].removesuffix(".pyc") for n in entries if n.endswith(".pyc")}
    )
    OUT_MODULES.write_text(
        json.dumps({"modules": tops, "tombstoned": sorted(pruned)}, indent=2) + "\n"
    )

    digest = hashlib.sha256(data).hexdigest()
    print(
        f"packed {len(entries)} entries ({skipped} pruned, {failed} src-fallback) "
        f"{SRC_ZIP.stat().st_size:,} -> {OUT_ZIP.stat().st_size:,} bytes\n"
        f"tombstones ({len(pruned)}): {', '.join(sorted(pruned))}\n"
        f"top-level modules: {len(tops)} -> {OUT_MODULES.name}\n"
        f"sha256 {digest}"
    )


if __name__ == "__main__":
    main()
