"""Build the pruned, pyc-only stdlib zip for the AVLO Python runtime.

Input : dist/raw/python_stdlib.zip  (fork build output)
        config/stdlib-prune.txt     (committed prune list)
        overlay/stdlib/*.py         (sitecustomize, _avlo_runtime, ...)
Output: dist/stage/python_stdlib.zip
        dist/stage/stdlib-modules.json  (top-level names for the generated
                                         import-gate allowlist, D9)

Must run under the CPython minor pinned in build.config.json (pyc MAGIC must
match the wasm interpreter); the CLI already re-exec'd under
PYTHONHASHSEED=0 (marshalled sets iterate in hash order).

Layout notes:
- zipimport loads `foo.pyc` stored NEXT TO where foo.py would live (legacy
  layout, not __pycache__) — so we compile each .py to a sibling .pyc and ship
  only the .pyc. Source lines vanish from tracebacks for stdlib frames
  (accepted: gate-pinned file+line-only contract).
- unchecked-hash invalidation: restored MEMFS mtimes are meaningless, and
  zipimport wouldn't revalidate anyway — unchecked pycs make the contract
  explicit.
- pyc -O level + zip codec/level come from config `pack` (stdlibPycOptimize,
  stdlibZip) — see config.py for the rationale prose.
- Tombstone registry keys are EXACT dotted prune paths ('xml.sax', not 'xml')
  so partially-pruned packages keep their shipped parents importable (D6).
"""

import hashlib
import json
import zipfile

from . import packlib, pyc_compile
from .config import Config, load
from .paths import PKG_ROOT, RAW_DIR, STAGE_DIR

SRC_ZIP = RAW_DIR / "python_stdlib.zip"
PRUNE_TXT = PKG_ROOT / "config/stdlib-prune.txt"
OVERLAY = PKG_ROOT / "overlay/stdlib"
OUT_ZIP = STAGE_DIR / "python_stdlib.zip"
OUT_MODULES = STAGE_DIR / "stdlib-modules.json"

DEFAULT_REASON = "stripped from the canvas Python build"


def build(cfg: Config) -> tuple[dict[str, bytes], dict[str, str], int, int]:
    """One full pack pass → (zip entries, tombstones, skipped, failed)."""
    dfile_prefix = f"/lib/python{cfg.py_tag}.zip/"
    optimize = cfg.pack.stdlibPycOptimize
    rules = packlib.load_prune_rules(PRUNE_TXT)
    reasons = packlib.parse_reasons(PRUNE_TXT, DEFAULT_REASON)
    src = zipfile.ZipFile(SRC_ZIP)

    entries: dict[str, bytes] = {}
    pruned: dict[str, str] = {}
    skipped = failed = 0

    # (source name, source bytes) queued for the hermetic compile workers —
    # pyc bytes depend on the compiling process's import history, so nothing
    # compiles in THIS process (see _pyc_worker.py).
    py_items: list[tuple[str, bytes]] = []
    for info in sorted(src.infolist(), key=lambda i: i.filename):
        name = info.filename
        if name.endswith("/"):
            continue
        if packlib.is_pruned(name, rules):
            skipped += 1
            continue
        data = src.read(name)
        if name.endswith(".py"):
            py_items.append((name, data))
        else:
            entries[name] = data  # data files (encodings aliases etc.)

    # Every prune RULE becomes an exact dotted tombstone (not just its top).
    for rule in rules:
        key = packlib.dotted_key(rule)
        pruned[key] = reasons.get(key, DEFAULT_REASON)

    # Overlay modules (compiled like the rest).
    for p in sorted(OVERLAY.glob("*.py")):
        py_items.append((p.name, p.read_bytes()))

    # Registry doc text is FROZEN at the legacy generator name: UNCHECKED_HASH
    # pycs still embed the 8-byte source hash, so changing one comment char
    # changes shipped bytes ⇒ rotates buildHash. Rename it with the next
    # deliberate rotation, not before.
    py_items.append(("_avlo_pruned.py", packlib.registry_source("by pack-stdlib.py", pruned)))

    pycs = pyc_compile.compile_bytes([(data, f"{dfile_prefix}{name}", optimize) for name, data in py_items])
    for (name, data), pyc in zip(py_items, pycs):
        if isinstance(pyc, str):
            print(f"!! compile failed, shipping source: {name}: {pyc}")
            entries[name] = data
            failed += 1
        else:
            entries[name[:-3] + ".pyc"] = pyc
    return entries, pruned, skipped, failed


def run(args) -> int:
    cfg = load()
    cfg.require_host_minor()
    zk = cfg.pack.stdlibZip

    entries, pruned, skipped, failed = build(cfg)
    data = packlib.zip_bytes(entries, codec=zk.codec, level=zk.level)
    if args.repro:
        entries2, *_ = build(cfg)
        data2 = packlib.zip_bytes(entries2, codec=zk.codec, level=zk.level)
        if data != data2:
            raise SystemExit("pack-stdlib: G0 FAIL — zip differs across identical runs")
        print("pack-stdlib repro OK (byte-identical)")

    OUT_ZIP.parent.mkdir(parents=True, exist_ok=True)
    OUT_ZIP.write_bytes(data)

    # D9: the generated import-gate allowlist inputs. `modules` = importable
    # top-level names actually in the zip; `tombstoned` = exact dotted pruned
    # keys (their top-levels stay click-time-allowed — the runtime tombstone
    # error is more precise than a pre-run refusal).
    tops = sorted({n.split("/")[0].removesuffix(".pyc") for n in entries if n.endswith(".pyc")})
    OUT_MODULES.write_text(json.dumps({"modules": tops, "tombstoned": sorted(pruned)}, indent=2) + "\n")

    digest = hashlib.sha256(data).hexdigest()
    print(
        f"packed {len(entries)} entries ({skipped} pruned, {failed} src-fallback) "
        f"{SRC_ZIP.stat().st_size:,} -> {OUT_ZIP.stat().st_size:,} bytes\n"
        f"tombstones ({len(pruned)}): {', '.join(sorted(pruned))}\n"
        f"top-level modules: {len(tops)} -> {OUT_MODULES.name}\n"
        f"sha256 {digest}"
    )
    return 0
