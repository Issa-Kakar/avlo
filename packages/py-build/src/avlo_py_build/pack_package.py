"""Build deterministic package-bundle tars for the AVLO Python runtime (M2).

  avlo-build pack-bundles <bundle>|--all [--repro] [--stage-only|--tar-only]
  avlo-build pack-bundles --unpruned [wheel ...]

Pipeline per bundle (D2-D6): for each member wheel — unzip (sha-verified vs
build.config.json) -> wheel patches (patches/wheels/<pkg>/NNNN-*.patch, sorted,
`patch -p1 --fuzz=0 -N`) -> global excludes (*.pyi, __pycache__,
*.dist-info/RECORD; METADATA stays for importlib.metadata) -> prune per
config/pkg-prune/<pkg>.txt -> pyc compile (config pack.bundlePycOptimize=1 —
pandas/mpl compose __doc__ at runtime, -OO breaks them; sibling sourceless
pyc, UNCHECKED_HASH, dfile = site-packages path) -> per-bundle tombstone
registry (_avlo_pruned_<bundle>) -> loadOrder = sorted **/*.so -> meta.json
(FIRST tar entry, canonical JSON — JS mounts read it with a single 512-byte
ustar header parse, no tar lib) -> deterministic ustar (packlib).

--stage-only / --tar-only split the pipeline at the staged tree
(.cache/stage/<bundle>/) — the seam where scripts/node/prebake-fontcache.mjs
injects matplotlib's baked fontlist.json between the two phases.

--unpruned materializes patched-but-unpruned TREES (.cache/unpruned/<wheel>/)
for the import tracer — includes traceOnly wheels (pillow, fonttools), which
never ship.

Bundle identity = sha256 of the tar, carried in the staging manifest — never
inside the tar. The CLI already re-exec'd under PYTHONHASHSEED=0 (marshalled
sets iterate in hash order).
"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import packlib, pyc_compile
from .config import Config, WheelPin, load
from .paths import BUNDLES_OUT, GROUPS_DIR, PKG_ROOT, RAW_DIR, WHEEL_CACHE

STAGE_ROOT = PKG_ROOT / ".cache/stage"
UNPRUNED_ROOT = PKG_ROOT / ".cache/unpruned"
PATCHES = PKG_ROOT / "patches/wheels"
PRUNES = PKG_ROOT / "config/pkg-prune"

SCHEMA = 1
DEFAULT_REASON = "stripped from the canvas Python bundle"

# Set by _init(cfg) at run() time; the wasm-facing paths follow the toolchain
# pin — never hardcode the minor.
CFG: Config
PREFIX: str
OPTIMIZE: int
WHEELS: dict[str, WheelPin]
BUNDLES: dict[str, list[str]]
BUNDLE_OF: dict[str, str]
# P1.5 DSO grouping: DSO-bearing bundles ship ONE grouped side module
# (.avlo/<bundle>.so, linked by the recipes loop) instead of their wheels'
# per-extension .so files, plus a generated _avlo_groups_<bundle> registry
# the sitecustomize finder reads. Pure-Python bundles take the unchanged path.
GROUPS: dict[str, dict]

def _init(cfg: Config) -> None:
    global CFG, PREFIX, OPTIMIZE, WHEELS, BUNDLES, BUNDLE_OF, GROUPS
    CFG = cfg
    PREFIX = f"/lib/python{cfg.py_mm}/site-packages"
    OPTIMIZE = cfg.pack.bundlePycOptimize
    WHEELS = dict(cfg.recipes.wheels)
    BUNDLES = dict(cfg.bundles)
    BUNDLE_OF = {w: b for b, members in BUNDLES.items() for w in members}
    GROUPS = json.loads((PKG_ROOT / "config/dso-groups/groups.json").read_text())["bundles"]


def subset_mpl_fonts(stage: Path) -> None:
    """Keep the configured faces: text faces subset to the pinned unicode
    ranges, mathtext fallback faces shipped whole (config `keepUnsubset`).

    fontTools runs at the EXACT `hostTools.fonttools` pin as a project
    dependency (uv.lock carries it; require_fonttools_pin() hard-asserts the
    installed version — the determinism boundary moved from an isolated uvx
    env into the workspace lock, same pinned bytes, no network at pack time).
    The --no-recalc flags keep bytes stable."""
    CFG.require_fonttools_pin()
    fonts = CFG.fonts
    ttf_dir = stage / "matplotlib/mpl-data/fonts/ttf"
    keep = set(fonts.faces)
    whole = set(fonts.keepUnsubset)

    def subset_face(f: Path) -> None:
        tmp = f.with_suffix(".subset.ttf")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "fontTools",
                "subset",
                str(f),
                f"--unicodes={fonts.unicodes}",
                f"--output-file={tmp}",
                "--no-recalc-timestamp",
                "--no-recalc-bounds",
            ],
            check=True,
            capture_output=True,
        )
        tmp.replace(f)

    faces: list[Path] = []
    for f in sorted(ttf_dir.iterdir()):
        if f.name.startswith("LICENSE"):
            continue  # STIX faces ship too — both license files stay
        if f.name in whole:
            continue
        if f.name not in keep:
            f.unlink()
            continue
        faces.append(f)
    # Faces subset concurrently — each invocation owns its file pair; the
    # fontTools PIN (not invocation order) is what fixes the bytes.
    with ThreadPoolExecutor(max_workers=len(faces) or 1) as pool:
        for _ in pool.map(subset_face, faces):
            pass


def wheel_path(name: str) -> Path:
    pin = WHEELS[name]
    p = WHEEL_CACHE / pin.file
    if not p.exists():
        sys.exit(f"{name}: wheel missing — run avlo-build fetch-wheels first ({p})")
    got = hashlib.sha256(p.read_bytes()).hexdigest()
    if got != pin.sha256:
        sys.exit(f"{name}: wheel sha256 mismatch\n  want {pin.sha256}\n  got  {got}")
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


def stage_group(bundle: str, stage: Path, dropped: set[str]) -> None:
    """Grouped-bundle staging tail: gate the census, inject .avlo/<bundle>.so
    + the _avlo_groups_<bundle> registry the sitecustomize finder reads."""
    group = GROUPS[bundle]
    stale = [p for p, sha in group["packages"].items() if WHEELS[p].sha256 != sha]
    if stale:
        sys.exit(
            f"{bundle}: groups.json wheel pins stale for {', '.join(stale)} — "
            "regroup needed (recipes loop; refresh groups.json from the harvested "
            "config/dso-groups/<bundle>.json manifests + build.config wheel pins)"
        )
    want = {e["wheelSoPath"] for e in group["extensions"]}
    if dropped != want:
        sys.exit(
            f"{bundle}: staged .so set diverges from groups.json census — regroup needed\n"
            f"  dropped-not-census: {sorted(dropped - want)}\n"
            f"  census-not-dropped: {sorted(want - dropped)}"
        )
    group_so = GROUPS_DIR / f"{bundle}.so"
    if not group_so.is_file():
        sys.exit(f"{bundle}: {group_so} missing — run the recipes loop (pnpm --filter @avlo/py-build recipes:build)")
    avlo = stage / ".avlo"
    avlo.mkdir()
    (avlo / f"{bundle}.so").write_bytes(group_so.read_bytes())
    registry = f"_avlo_groups_{bundle.replace('-', '_')}"
    rel_so = f".avlo/{bundle}.so"
    # Text frozen at the legacy generator name — UNCHECKED_HASH pycs embed the
    # source hash, so a comment edit here rotates buildHash. Rename at the
    # next deliberate rotation.
    lines = [f"# GENERATED by pack-package.py ({bundle}) — do not edit", "GROUPS = {"]
    for e in group["extensions"]:  # census order (lexicographic wheelSoPath)
        lines.append(f"    {e['dottedName']!r}: {rel_so!r},")
    lines.append("}")
    (stage / f"{registry}.pyc").write_bytes(
        pyc_compile.compile_one("\n".join(lines).encode(), f"{PREFIX}/{registry}.py", optimize=OPTIMIZE)
    )


def stage_bundle(bundle: str) -> tuple[Path, dict[str, str]]:
    """Stage all member wheels -> pruned pyc tree. Returns (dir, tombstones)."""
    members = BUNDLES[bundle]
    group = GROUPS.get(bundle)
    stage = STAGE_ROOT / bundle
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)

    pruned: dict[str, str] = {}
    dropped: set[str] = set()  # per-extension .so rels replaced by the group
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
            py_jobs: list[tuple[str, str, str, int]] = []
            for f in sorted(p for p in tree.rglob("*") if p.is_file()):
                rel = f.relative_to(tree).as_posix()
                if globally_excluded(rel) or packlib.is_pruned(rel, rules):
                    continue
                if group is not None and rel.endswith(".so"):
                    # Prune ran first, so dropped == the census extension set
                    # exactly — a stray .so from a future wheel re-pin fails
                    # the stage_group equality gate loudly.
                    dropped.add(rel)
                    continue
                if rel.endswith(".py"):
                    out = stage / (rel[:-3] + ".pyc")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    py_jobs.append((str(f), str(out), f"{PREFIX}/{rel}", OPTIMIZE))
                else:
                    out = stage / rel
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(f.read_bytes())
            # Hermetic worker subprocesses (see _pyc_worker.py); must run
            # inside the tempdir context — jobs reference paths in `tree`.
            pyc_compile.compile_files(py_jobs)

    if bundle == "matplotlib":
        subset_mpl_fonts(stage)
    if group is not None:
        stage_group(bundle, stage, dropped)

    registry = f"_avlo_pruned_{bundle.replace('-', '_')}"
    (stage / f"{registry}.pyc").write_bytes(
        pyc_compile.compile_one(
            packlib.registry_source(f"by pack-package.py ({bundle})", pruned),  # frozen text, see stage_group note
            f"{PREFIX}/{registry}.py",
            optimize=OPTIMIZE,
        )
    )
    return stage, pruned


def prebake_fontcache() -> None:
    """D8: bake matplotlib/fontlist.json into the staged tree (a Node fork
    boot over the staged set — the sanctioned Python→Node boundary; see
    scripts/node/prebake-fontcache.mjs)."""
    subprocess.run(
        ["node", str(PKG_ROOT / "scripts/node/prebake-fontcache.mjs")],
        check=True,
        cwd=PKG_ROOT,
    )


def wheel_depends(name: str, lock: dict) -> list[str]:
    """Direct deps for a wheel: url pins carry a hand-pinned `depends` field
    (they are absent from the stock lock); lock wheels stay loud on a miss."""
    pin = WHEELS[name]
    if pin.depends is not None:
        return pin.depends
    entry = lock["packages"].get(name) or lock["packages"][name.replace("-", "_")]
    return entry["depends"]


def bundle_requires(bundle: str) -> list[str]:
    """Bundle names that must mount before this one (pinned deps -> bundles)."""
    lock = json.loads((RAW_DIR / "pyodide-lock.json").read_text())
    reqs: set[str] = set()
    for name in BUNDLES[bundle]:
        for dep in wheel_depends(name, lock):
            dep_pin = WHEELS.get(dep)
            if dep_pin is not None and dep_pin.traceOnly:
                continue  # pillow/fonttools: patched out, never shipped
            owner = BUNDLE_OF.get(dep)
            if owner and owner != bundle:
                reqs.add(owner)
    return sorted(reqs)


def build_tar(bundle: str, stage: Path, pruned: dict[str, str]) -> bytes:
    files = sorted(p for p in stage.rglob("*") if p.is_file())
    rels = [p.relative_to(stage).as_posix() for p in files]
    load_order = sorted(r for r in rels if r.endswith(".so"))
    if bundle in GROUPS and load_order != [f".avlo/{bundle}.so"]:
        sys.exit(f"{bundle}: grouped bundle loadOrder must be ['.avlo/{bundle}.so'], got {load_order}")
    # _avlo_* registries (pruned + groups) and the .avlo dot-dir are pack
    # machinery — never importable packages, never in PACKAGE_TO_SET.
    provides = sorted(
        {
            c.name.removesuffix(".pyc")
            for c in stage.iterdir()
            if (c.is_dir() and not c.name.endswith(".dist-info") and not c.name.startswith("."))
            or (c.is_file() and c.name.endswith(".pyc") and not c.name.startswith("_avlo_"))
        }
    )
    meta = {
        "schema": SCHEMA,
        "bundle": bundle,
        "abi": CFG.toolchain.abi,
        "python": CFG.toolchain.python,
        "prefix": PREFIX,
        "packages": [
            {
                "name": n,
                "version": WHEELS[n].version,
                "wheel": WHEELS[n].file,
                "wheelSha256": WHEELS[n].sha256,
            }
            for n in BUNDLES[bundle]
        ],
        "provides": provides,
        "requires": bundle_requires(bundle),
        "loadOrder": load_order,
        "optimize": OPTIMIZE,
        "counts": {"files": len(rels), "so": len(load_order)},
    }
    entries = [("meta.json", packlib.canonical_json(meta))]
    entries += [(r, p.read_bytes()) for r, p in zip(rels, files)]  # rels sorted
    return packlib.write_tar(BUNDLES_OUT / f"{bundle}.tar", entries)


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
    print(f"{bundle}.tar {len(data):,} bytes, {len(pruned)} tombstones, sha256 {hashlib.sha256(data).hexdigest()}")


def unpruned(names: list[str]) -> None:
    for name in names:
        dest = UNPRUNED_ROOT / name
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        extract_and_patch(name, dest)
        print(f"{name}: unpruned tree {dest}")


def run(args) -> int:
    cfg = load()
    cfg.require_host_minor()
    _init(cfg)
    if args.unpruned:
        unpruned(args.bundles or list(WHEELS))
        return 0
    targets = list(BUNDLES) if args.all else args.bundles
    if not targets:
        sys.exit("pack-bundles: name at least one bundle, or pass --all")
    for bundle in targets:
        if bundle not in BUNDLES:
            sys.exit(f"unknown bundle {bundle!r} (have: {', '.join(BUNDLES)})")
        pack(bundle, args.stage_only, args.tar_only, args.repro)
    return 0
