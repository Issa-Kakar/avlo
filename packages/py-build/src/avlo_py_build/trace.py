"""Import tracer (M2 Step 3, gate G3) — analysis half.

  avlo-build trace check          # gate: trace ∩ prune = ∅ AND no
                                  #   PIL/fontTools attempt
  avlo-build trace propose numpy  # unreached-subtree candidates for human
                                  #   prune curation
  avlo-build trace record [...]   # → scripts/node/trace-record.mjs (fork
                                  #   boot over unpruned trees; Node by
                                  #   language policy)

check/propose are pure JSON/tree analysis over .cache/trace/*.json + the
prune lists; record boots the fork and stays a Node script.
"""

import json
import subprocess
import sys

from .paths import CACHE_DIR, PKG_ROOT

TRACE_DIR = CACHE_DIR / "trace"
UNPRUNED_ROOT = CACHE_DIR / "unpruned"


def _load_traces() -> dict[str, dict]:
    traces = {
        f.stem: json.loads(f.read_text()) for f in (sorted(TRACE_DIR.glob("*.json")) if TRACE_DIR.is_dir() else [])
    }
    if not traces:
        sys.exit("no traces recorded — run `avlo-build trace record` first")
    return traces


def _prune_keys() -> list[str]:
    keys: list[str] = []

    def add_list(file) -> None:
        for line in file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            keys.append(line.rstrip("/").removesuffix(".py").replace("/", "."))

    add_list(PKG_ROOT / "config/stdlib-prune.txt")
    pkg_prune = PKG_ROOT / "config/pkg-prune"
    for f in sorted(pkg_prune.glob("*.txt")) if pkg_prune.is_dir() else []:
        add_list(f)
    return keys


def run_check(args) -> int:
    traces = _load_traces()
    keys = _prune_keys()
    bad = 0
    for group, t in traces.items():
        for m in t["loaded"]:
            for k in keys:
                if m == k or m.startswith(f"{k}."):
                    print(f"VIOLATION {group}: loaded module {m} collides with prune rule {k}", file=sys.stderr)
                    bad += 1
        for m in t["attempted"]:
            root = m.split(".")[0]
            if root in ("PIL", "fontTools"):
                print(f"VIOLATION {group}: {m} attempted — pillow-ectomy/fontTools site survives", file=sys.stderr)
                bad += 1
    print(
        f"G3 FAIL: {bad} violation(s)"
        if bad
        else f"G3 OK: {len(traces)} trace(s), {len(keys)} prune rules, ∩ = ∅, no PIL/fontTools"
    )
    return 1 if bad else 0


def run_propose(args) -> int:
    pkg = args.pkg
    tree = UNPRUNED_ROOT / pkg
    if not tree.is_dir():
        sys.exit(f"propose: no unpruned tree for {pkg} ({tree}) — run `avlo-build pack-bundles --unpruned` first")
    loaded = {m for t in _load_traces().values() for m in t["loaded"]}

    def mod_of(rel: str) -> str | None:
        """Module name for a tree file; None for non-module files (data, dist-info)."""
        if ".dist-info/" in rel:
            return None
        if rel.endswith(".py"):
            return rel[:-3].removesuffix("/__init__").replace("/", ".")
        if rel.endswith(".so"):
            stem = rel[: -len(".so")]
            # strip a .cpython-<abi tag> when present ('x.cpython-314-wasm32-emscripten.so' → 'x')
            i = stem.rfind(".cpython-")
            if i != -1 and "/" not in stem[i:]:
                stem = stem[:i]
            return stem.replace("/", ".")
        return None

    files = [
        {"rel": p.relative_to(tree).as_posix(), "size": p.stat().st_size}
        for p in sorted(tree.rglob("*"))
        if p.is_file()
    ]
    unreached = [f for f in files if (m := mod_of(f["rel"])) is not None and m not in loaded]

    # roll up: dir candidates where EVERY module file below is unreached
    dir_totals: dict[str, int] = {}
    for f in unreached:
        parts = f["rel"].split("/")
        for d in range(1, len(parts)):
            key = "/".join(parts[:d]) + "/"
            dir_totals[key] = dir_totals.get(key, 0) + f["size"]

    def reached_under(d: str) -> bool:
        return any(f["rel"].startswith(d) and (m := mod_of(f["rel"])) is not None and m in loaded for f in files)

    candidates: list[dict] = []
    covered: set[str] = set()
    for d, size in sorted(dir_totals.items(), key=lambda kv: len(kv[0])):
        if any(d.startswith(c) for c in covered):
            continue
        if not reached_under(d):
            candidates.append({"rule": d, "size": size})
            covered.add(d)
    for f in unreached:
        if not any(f["rel"].startswith(c) for c in covered) and f["rel"].endswith(".py"):
            candidates.append({"rule": f["rel"], "size": f["size"]})
    candidates.sort(key=lambda c: -c["size"])
    print(f"# prune candidates for {pkg} (unreached by any trace; human-curate into config/pkg-prune/{pkg}.txt)")
    for c in candidates:
        print(f"{c['size'] / 1024:7.0f} KB  {c['rule']}")
    return 0


def run_record(args) -> int:
    cmd = ["node", str(PKG_ROOT / "scripts/node/trace-record.mjs")]
    if args.group:
        cmd += ["--group", args.group]
    return subprocess.run(cmd, cwd=PKG_ROOT).returncode
