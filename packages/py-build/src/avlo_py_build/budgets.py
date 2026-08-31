"""Size-budget gate (G1). Plain mode hard-fails any artifact/composite over
its committed ceiling; refuses to "pass" while the artifacts table is empty.
--update measures every artifact, stamps ceiling = measured × the config
`pack.budgetHeadroom` into build.config.json (composite ceilings stay
hand-set), and a human commits the diff.

  avlo-build budgets [--update]
"""

import math

from .config import load, load_raw, save_raw
from .paths import PKG_ROOT


def run(args) -> int:
    cfg = load()

    # artifact name (as budget key) -> repo path
    paths = {
        "pyodide.asm.mjs": "dist/raw/pyodide.asm.mjs",
        "pyodide.asm.wasm": "dist/raw/pyodide.asm.wasm",
        "pyodide.mjs": "dist/raw/pyodide.mjs",
        "python_stdlib.zip": "dist/stage/python_stdlib.zip",
    }
    for b in cfg.bundles:
        paths[f"bundles/{b}.tar"] = f"dist/stage/bundles/{b}.tar"

    sizes: dict[str, dict[str, int]] = {}
    missing = 0
    for name, rel in paths.items():
        p = PKG_ROOT / rel
        br = p.with_name(p.name + ".br")
        if not p.exists() or not br.exists():
            print(f"missing {name} (or its .br) — run the pack + compress steps first")
            missing += 1
            continue
        sizes[name] = {"raw": p.stat().st_size, "br": br.stat().st_size}
    if missing:
        return 1

    if args.update:
        headroom = cfg.pack.budgetHeadroom
        raw_cfg = load_raw()
        raw_cfg["budgets"]["artifacts"] = {
            name: {"raw": math.ceil(s["raw"] * headroom), "br": math.ceil(s["br"] * headroom)} for name, s in sizes.items()
        }
        save_raw(raw_cfg)
        print(f"stamped {len(sizes)} artifact ceilings (×{headroom}) into build.config.json")
        load.cache_clear()
        cfg = load()

    artifacts = cfg.budgets.artifacts
    if not artifacts:
        print("budgets.artifacts is empty — run with --update once and commit the numbers")
        return 1

    bad = 0

    def mb(n: float) -> str:
        return f"{n / 1e6:.2f} MB"
    for name, s in sizes.items():
        cap = artifacts.get(name)
        if cap is None:
            print(f"OVER {name}: no committed ceiling — rerun --update deliberately")
            bad += 1
            continue
        if s["raw"] > cap.raw or s["br"] > cap.br:
            print(f"OVER {name}: raw {mb(s['raw'])}/{mb(cap.raw)} br {mb(s['br'])}/{mb(cap.br)}")
            bad += 1
        else:
            print(f"ok   {name}: raw {mb(s['raw'])} br {mb(s['br'])}")

    for name, comp in cfg.budgets.composites.items():
        total = 0
        for f in comp.files:
            if f not in sizes:
                raise KeyError(f"composite {name}: unknown artifact {f}")
            total += sizes[f]["br"]
        if total > comp.br:
            print(f"OVER composite {name}: {mb(total)} br > ceiling {mb(comp.br)}")
            bad += 1
        else:
            print(f"ok   composite {name}: {mb(total)} br (ceiling {mb(comp.br)})")

    print(f"G1 FAIL: {bad} over budget" if bad else "G1 OK: all budgets green")
    return 1 if bad else 0
