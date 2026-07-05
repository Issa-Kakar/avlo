#!/usr/bin/env python3.13
"""Build deterministic package-bundle tars for the AVLO Python runtime (M2).

  python3.13 scripts/pack-package.py <bundle>|--all [--repro] [--stage-only|--tar-only]
  python3.13 scripts/pack-package.py --unpruned [wheel ...]

Pipeline per bundle (D2-D6): for each member wheel — unzip (sha-verified vs
build.config.json) -> wheel patches (patches/wheels/<pkg>/NNNN-*.patch, sorted,
`patch -p1 --fuzz=0 -N`) -> global excludes (*.pyi, __pycache__,
*.dist-info/RECORD; METADATA stays for importlib.metadata) -> prune per
config/pkg-prune/<pkg>.txt -> pyc compile (optimize=1 — pandas/mpl compose
__doc__ at runtime, -OO breaks them; sibling sourceless pyc, UNCHECKED_HASH,
dfile = site-packages path) -> per-bundle tombstone registry
(_avlo_pruned_<bundle>) -> loadOrder = sorted **/*.so -> meta.json (FIRST tar
entry, canonical JSON — JS mounts read it with a single 512-byte ustar header
parse, no tar lib) -> deterministic ustar (packlib.write_tar).

--stage-only / --tar-only split the pipeline at the staged tree
(.cache/stage/<bundle>/) — the seam where prebake-fontcache.mjs injects
matplotlib's baked fontlist.json between the two phases.

--unpruned materializes patched-but-unpruned TREES (.cache/unpruned/<wheel>/)
for the import tracer — includes traceOnly wheels (pillow, fonttools), which
never ship.

Bundle identity = sha256 of the tar, carried in the staging manifest — never
inside the tar. Re-execs under PYTHONHASHSEED=0 (marshalled sets iterate in
hash order).
"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import packlib

packlib.ensure_hashseed()

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "build.config.json").read_text())
WHEEL_CACHE = ROOT / ".cache/wheels"
STAGE_ROOT = ROOT / ".cache/stage"
UNPRUNED_ROOT = ROOT / ".cache/unpruned"
PATCHES = ROOT / "patches/wheels"
PRUNES = ROOT / "config/pkg-prune"
OUT_DIR = ROOT / "dist/stage/bundles"

PREFIX = "/lib/python3.13/site-packages"
SCHEMA = 1
DEFAULT_REASON = "stripped from the canvas Python bundle"

WHEELS = {k: v for k, v in CONFIG["recipes"]["wheels"].items() if not k.startswith("$")}
BUNDLES = {k: v for k, v in CONFIG["bundles"].items() if not k.startswith("$")}
BUNDLE_OF = {w: b for b, members in BUNDLES.items() for w in members}


def hosttools_python() -> str:
    """Venv python with the PINNED fontTools (config hostTools) — created on
    first use under .cache/hosttools/."""
    pin = CONFIG["hostTools"]["fonttools"]
    venv = ROOT / ".cache/hosttools"
    vpy = venv / "bin/python"
    stamp = venv / f".fonttools-{pin}"
    if not stamp.exists():
        shutil.rmtree(venv, ignore_errors=True)
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run([str(vpy), "-m", "pip", "install", "--quiet", f"fonttools=={pin}"], check=True)
        stamp.touch()
    return str(vpy)


def subset_mpl_fonts(stage: Path) -> None:
    """Keep the configured faces: text faces subset to the pinned unicode
    ranges (host fontTools; --no-recalc flags keep bytes stable), mathtext
    fallback faces shipped whole (config `keepUnsubset`)."""
    fonts = CONFIG["fonts"]
    ttf_dir = stage / "matplotlib/mpl-data/fonts/ttf"
    keep = set(fonts["faces"])
    whole = set(fonts["keepUnsubset"])
    vpy = hosttools_python()
    for f in sorted(ttf_dir.iterdir()):
        if f.name.startswith("LICENSE"):
            continue  # STIX faces ship too — both license files stay
        if f.name in whole:
            continue
        if f.name not in keep:
            f.unlink()
            continue
        tmp = f.with_suffix(".subset.ttf")
        subprocess.run(
            [
                vpy,
                "-m",
                "fontTools.subset",
                str(f),
                f"--unicodes={fonts['unicodes']}",
                f"--output-file={tmp}",
                "--no-recalc-timestamp",
                "--no-recalc-bounds",
            ],
            check=True,
            capture_output=True,
        )
        tmp.replace(f)


def wheel_path(name: str) -> Path:
    pin = WHEELS[name]
    p = WHEEL_CACHE / pin["file"]
    if not p.exists():
        sys.exit(f"{name}: wheel missing — run fetch-wheels.mjs first ({p})")
    got = hashlib.sha256(p.read_bytes()).hexdigest()
    if got != pin["sha256"]:
        sys.exit(f"{name}: wheel sha256 mismatch\n  want {pin['sha256']}\n  got  {got}")
    return p


def extract_and_patch(name: str, dest: Path) -> None:
    """Unzip the wheel into dest and apply its patch queue."""
    with zipfile.ZipFile(wheel_path(name)) as z:
        z.extractall(dest)
    patch_dir = PATCHES / name
    for patch in sorted(patch_dir.glob("*.patch")) if patch_dir.is_dir() else []:
        print(f"  patch {name}/{patch.name}")
        subprocess.run(
            ["patch", "-p1", "--fuzz=0", "-N", "-i", str(patch.resolve())],
            cwd=dest,
            check=True,
            capture_output=True,
        )


def globally_excluded(rel: str) -> bool:
    parts = rel.split("/")
    if "__pycache__" in parts:
        return True
    if rel.endswith(".pyi"):
        return True
    if len(parts) >= 2 and parts[0].endswith(".dist-info") and parts[-1] == "RECORD":
        return True
    return False


def stage_bundle(bundle: str) -> tuple[Path, dict[str, str]]:
    """Stage all member wheels -> pruned pyc tree. Returns (dir, tombstones)."""
    members = BUNDLES[bundle]
    stage = STAGE_ROOT / bundle
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)

    pruned: dict[str, str] = {}
    for name in members:
        prune_txt = PRUNES / f"{name}.txt"
        rules = packlib.load_prune_rules(prune_txt) if prune_txt.exists() else []
        reasons = packlib.parse_reasons(prune_txt, DEFAULT_REASON) if rules else {}
        for rule in rules:
            if not packlib.is_module_rule(rule):
                continue  # data-file prune — nothing importable to tombstone
            key = packlib.dotted_key(rule)
            pruned[key] = reasons.get(key, DEFAULT_REASON)

        with tempfile.TemporaryDirectory() as td:
            tree = Path(td)
            extract_and_patch(name, tree)
            for f in sorted(p for p in tree.rglob("*") if p.is_file()):
                rel = f.relative_to(tree).as_posix()
                if globally_excluded(rel) or packlib.is_pruned(rel, rules):
                    continue
                if rel.endswith(".py"):
                    out = stage / (rel[:-3] + ".pyc")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(
                        packlib.compile_pyc(f.read_bytes(), f"{PREFIX}/{rel}", optimize=1)
                    )
                else:
                    out = stage / rel
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(f.read_bytes())

    if bundle == "matplotlib":
        subset_mpl_fonts(stage)

    registry = f"_avlo_pruned_{bundle.replace('-', '_')}"
    (stage / f"{registry}.pyc").write_bytes(
        packlib.compile_pyc(
            packlib.registry_source(f"by pack-package.py ({bundle})", pruned),
            f"{PREFIX}/{registry}.py",
            optimize=1,
        )
    )
    return stage, pruned


def prebake_fontcache() -> None:
    """D8: bake matplotlib/fontlist.json into the staged tree (a Node fork
    boot over the staged set — see prebake-fontcache.mjs)."""
    subprocess.run(
        ["node", str(ROOT / "scripts/prebake-fontcache.mjs")],
        check=True,
        cwd=ROOT,
    )


def bundle_requires(bundle: str) -> list[str]:
    """Bundle names that must mount before this one (lock deps -> bundles)."""
    lock = json.loads((ROOT / "dist/raw/pyodide-lock.json").read_text())
    reqs: set[str] = set()
    for name in BUNDLES[bundle]:
        entry = lock["packages"].get(name) or lock["packages"][name.replace("-", "_")]
        for dep in entry["depends"]:
            if WHEELS.get(dep, {}).get("traceOnly"):
                continue  # pillow/fonttools: patched out, never shipped
            owner = BUNDLE_OF.get(dep)
            if owner and owner != bundle:
                reqs.add(owner)
    return sorted(reqs)


def build_tar(bundle: str, stage: Path, pruned: dict[str, str]) -> bytes:
    files = sorted(p for p in stage.rglob("*") if p.is_file())
    rels = [p.relative_to(stage).as_posix() for p in files]
    load_order = sorted(r for r in rels if r.endswith(".so"))
    provides = sorted(
        {
            c.name.removesuffix(".pyc")
            for c in stage.iterdir()
            if (c.is_dir() and not c.name.endswith(".dist-info"))
            or (c.is_file() and c.name.endswith(".pyc") and not c.name.startswith("_avlo_pruned_"))
        }
    )
    meta = {
        "schema": SCHEMA,
        "bundle": bundle,
        "abi": CONFIG["toolchain"]["abi"],
        "python": CONFIG["toolchain"]["python"],
        "prefix": PREFIX,
        "packages": [
            {
                "name": n,
                "version": WHEELS[n]["version"],
                "wheel": WHEELS[n]["file"],
                "wheelSha256": WHEELS[n]["sha256"],
            }
            for n in BUNDLES[bundle]
        ],
        "provides": provides,
        "requires": bundle_requires(bundle),
        "loadOrder": load_order,
        "optimize": 1,
        "counts": {"files": len(rels), "so": len(load_order)},
    }
    entries = [("meta.json", packlib.canonical_json(meta))]
    entries += [(r, p.read_bytes()) for r, p in zip(rels, files)]  # rels sorted
    return packlib.write_tar(OUT_DIR / f"{bundle}.tar", entries)


def pack(bundle: str, stage_only: bool, tar_only: bool, repro: bool) -> None:
    if tar_only:
        stage = STAGE_ROOT / bundle
        if not stage.is_dir():
            sys.exit(f"{bundle}: no staged tree ({stage}) — run --stage-only first")
        # Tombstones already compiled into the staged registry pyc.
        data = build_tar(bundle, stage, {})
        print(f"{bundle}.tar {len(data):,} bytes sha256 {hashlib.sha256(data).hexdigest()}")
        return
    stage, pruned = stage_bundle(bundle)
    if stage_only:
        print(f"{bundle}: staged {stage} ({len(pruned)} tombstones)")
        return
    if bundle == "matplotlib":
        prebake_fontcache()
    data = build_tar(bundle, stage, pruned)
    if repro:
        stage2, pruned2 = stage_bundle(bundle)
        if bundle == "matplotlib":
            prebake_fontcache()
        data2 = build_tar(bundle, stage2, pruned2)
        if hashlib.sha256(data).digest() != hashlib.sha256(data2).digest():
            sys.exit(f"{bundle}: G-M2.R FAIL — tar differs across identical builds")
        print(f"{bundle}: repro OK (byte-identical)")
    print(
        f"{bundle}.tar {len(data):,} bytes, {len(pruned)} tombstones, "
        f"sha256 {hashlib.sha256(data).hexdigest()}"
    )


def unpruned(names: list[str]) -> None:
    for name in names:
        dest = UNPRUNED_ROOT / name
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        extract_and_patch(name, dest)
        print(f"{name}: unpruned tree {dest}")


def main() -> None:
    if sys.version_info[:2] != (3, 13):
        sys.exit(f"need CPython 3.13 (pyc magic), got {sys.version}")
    args = [a for a in sys.argv[1:]]
    flags = {a for a in args if a.startswith("--")}
    rest = [a for a in args if not a.startswith("--")]
    if "--unpruned" in flags:
        unpruned(rest or list(WHEELS))
        return
    targets = list(BUNDLES) if "--all" in flags else rest
    if not targets:
        sys.exit(__doc__)
    for bundle in targets:
        if bundle not in BUNDLES:
            sys.exit(f"unknown bundle {bundle!r} (have: {', '.join(BUNDLES)})")
        pack(bundle, "--stage-only" in flags, "--tar-only" in flags, "--repro" in flags)


if __name__ == "__main__":
    main()
