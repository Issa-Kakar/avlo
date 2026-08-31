"""DSO census + grouping audit over the STAGED bundle tars (the shipped
truth) and the staged main-module wasm. Born as the evidence engine behind
dso-grouping-analysis.md (67->4 side-module grouping); kept as a standing
audit to re-run on any restage / wheel bump.

  avlo-build census           # full report + .cache/dso-report.json
  avlo-build census --check   # gate mode (dsos:check). Grouped world (tars
                              # ship .avlo/<b>.so): exact PyInit census
                              # equality vs config/dso-groups/groups.json,
                              # finder-derivable init names
                              # (PyInit_<last dotted component>), dylink.0
                              # present + NEEDED empty, closed world vs
                              # main ∪ self ∪ {exit}, loadOrder ≤1 under
                              # .avlo/, mixed-world hard fail. Always: PyInit
                              # shortname uniqueness per bundle + no
                              # PyInit-less DSO. (groups.json census updates
                              # come from the recipes-loop harvest manifests.)

Per DSO: imports (env/GOT.mem/GOT.func; invoke_* trampolines + dylink
plumbing excluded, matching the link-rsp scan), exports, dylink.0 (mem/table
sizes, NEEDED — shipped 314 DSOs carry MEM_INFO only), toolchain fingerprint
from embedded strings. Derived: import-provider table (self counts FIRST —
ODR/PIC modules export-and-reimport their own symbols; classifying self last
invents phantom cross-DSO deps) + the lazy-stub audit.
"""

import json
import sys
import tarfile

from .paths import BUNDLES_OUT, CACHE_DIR, FORK_PUBLIC, PKG_ROOT, RAW_DIR
from .wasmmeta import census_imports, parse_wasm

OUT_PATH = CACHE_DIR / "dso-report.json"
GROUPS_PATH = PKG_ROOT / "config/dso-groups/groups.json"


def _main_wasm_path():
    for p in (FORK_PUBLIC / "pyodide.asm.wasm", RAW_DIR / "pyodide.asm.wasm"):
        if p.exists():
            return p
    sys.exit("no pyodide.asm.wasm found (staged public or dist/raw)")


def _kb(n: float) -> str:
    return f"{n / 1024:.0f}K"


def run(args) -> int:
    check_mode = args.check
    if not BUNDLES_OUT.is_dir():
        sys.exit(f"no staged bundles at {BUNDLES_OUT} — run pack-bundles + stage first")
    main_wasm_path = _main_wasm_path()

    # ---------- collect --------------------------------------------------------
    dsos: list[dict] = []
    metas: dict[str, dict] = {}  # bundle -> parsed meta.json (loadOrder shape checks)
    for tar_path in sorted(BUNDLES_OUT.glob("*.tar")):
        bundle = tar_path.stem
        with tarfile.open(tar_path) as tf:
            for member in tf:
                if not member.isreg():
                    continue
                if member.name == "meta.json":
                    metas[bundle] = json.load(tf.extractfile(member))
                    continue
                if not member.name.endswith(".so"):
                    continue
                data = tf.extractfile(member).read()
                w = parse_wasm(data)
                dsos.append(
                    {
                        "bundle": bundle,
                        "path": member.name,
                        "soName": member.name.rsplit("/", 1)[-1],
                        "size": member.size,
                        "toolchain": (
                            "cython"
                            if (b"__pyx_capi__" in data or b"__Pyx_" in data)
                            else "pybind11/c++"
                            if b"pybind11" in data
                            else "c/c++"
                        ),
                        "hasDylink": w.dylink is not None,
                        "memSize": w.dylink.memSize if w.dylink else 0,
                        "tableSize": w.dylink.tableSize if w.dylink else 0,
                        "needed": w.dylink.needed if w.dylink else [],
                        "exports": w.exports,
                        "exportSet": set(w.exports),
                        "imports": census_imports(w),
                    }
                )
    main_exports = set(parse_wasm(main_wasm_path.read_bytes(), want_dylink=False).exports)

    # ---------- derived ---------------------------------------------------------
    defs: dict[str, list[int]] = {}  # export name -> dso indices
    for i, d in enumerate(dsos):
        for n in d["exportSet"]:
            defs.setdefault(n, []).append(i)
    for d in dsos:
        d["pyinit"] = [x for x in d["exports"] if x.startswith("PyInit")]

    # import-provider classification, SELF FIRST. The self class splits by
    # import kind: a self ENV-FUNC import is the permanent-lazy-stub class
    # under RTLD_LOCAL (libdylink.js — RTLD_LOCAL exports never merge into
    # wasmImports, so instantiate binds a closure that resolves at first call
    # and stays a wasm→JS→wasm hop forever), while self GOT imports resolve
    # via updateGOT(own exports) before reportUndefinedSymbols and cost
    # nothing at call time. The stub audit measures the former per DSO:
    # env-func imports ∉ mainExports, split self-provided (real stubs) vs
    # glue-bound (satisfied by the JS library in wasmImports at instantiate —
    # e.g. `exit`).
    providers = {"self": 0, "main": 0, "other-bundle": 0, "js-glue": 0}
    self_by_kind = {"env": 0, "GOT.mem": 0, "GOT.func": 0}
    js_glue: dict[str, None] = {}  # insertion-ordered set
    for i, d in enumerate(dsos):
        d["stubSelf"] = 0  # env-func, self-exported: permanent JS stub trampoline today
        d["stubGlue"] = 0  # env-func, glue-provided: binds directly at instantiate
        for mod, field, kind in d["imports"]:
            if mod == "env" and kind == "func" and field not in main_exports:
                if field in d["exportSet"]:
                    d["stubSelf"] += 1
                else:
                    d["stubGlue"] += 1
            if field in d["exportSet"]:
                providers["self"] += 1
                self_by_kind[mod] += 1
            elif field in main_exports:
                providers["main"] += 1
            elif any(j != i for j in defs.get(field, [])):
                providers["other-bundle"] += 1
            else:
                providers["js-glue"] += 1
                js_glue[field] = None

    # per-bundle rollup + audits
    bundles = list(dict.fromkeys(d["bundle"] for d in dsos))
    groups: dict[str, dict] = {}
    failures: list[str] = []
    for b in bundles:
        members = [d for d in dsos if d["bundle"] == b]
        env_names: set[str] = set()
        got_names: set[str] = set()
        shortnames: dict[str, int] = {}
        size = mem_size = table_size = export_entries = got_entries = env_entries = 0
        for d in members:
            size += d["size"]
            mem_size += d["memSize"]
            table_size += d["tableSize"]
            export_entries += len(d["exports"])
            for mod, field, _kind in d["imports"]:
                if mod == "env":
                    env_names.add(field)
                    env_entries += 1
                else:
                    got_names.add(field)
                    got_entries += 1
            for p in d["pyinit"]:
                short = p.removeprefix("PyInitU_") if p.startswith("PyInitU_") else p.removeprefix("PyInit_")
                shortnames[short] = shortnames.get(short, 0) + 1
            if not d["pyinit"]:
                failures.append(f"DSO with no PyInit_* export: {b}/{d['soName']}")
        collisions = [[short, c] for short, c in shortnames.items() if c > 1]
        for short, c in collisions:
            failures.append(f"PyInit shortname collision in {b}: {short} ×{c}")
        groups[b] = {
            "members": len(members),
            "size": size,
            "memSize": mem_size,
            "tableSize": table_size,
            "exportEntries": export_entries,
            "envImports": len(env_names),
            "gotImports": len(got_names),
            "envEntries": env_entries,
            "gotEntries": got_entries,
            "pyinits": sum(len(d["pyinit"]) for d in members),
            "shortnameCollisions": collisions,
        }

    # ---------- grouped-world gate (dsos:check v2, post-P1.5) -------------------
    # Once the tars ship grouped side modules (.avlo/<bundle>.so) the gate
    # hardens: exact PyInit equality vs the committed groups.json census,
    # finder-derivable init names (PyInit_<last dotted component>), loadOrder
    # shape, closed-world at N=4 vs the staged main module, dylink sanity.
    # Pre-grouping tars keep the legacy checks only; a mix is a broken restage.
    grouped_dsos = [d for d in dsos if d["path"].startswith(".avlo/")]
    if grouped_dsos and len(grouped_dsos) != len(dsos):
        failures.append(
            f"mixed grouped ({len(grouped_dsos)}) + per-extension ({len(dsos) - len(grouped_dsos)}) DSOs across the staged tars"
        )
    grouped_world = len(dsos) > 0 and len(grouped_dsos) == len(dsos)
    if grouped_world:
        groups_json = json.loads(GROUPS_PATH.read_text())
        js_glue_allow = {"exit"}
        by_bundle = {d["bundle"]: d for d in dsos}
        census_bundles = sorted(groups_json["bundles"])
        tar_bundles = sorted(by_bundle)
        if census_bundles != tar_bundles:
            failures.append(f"DSO-bearing bundle set mismatch: census {census_bundles} vs tars {tar_bundles}")
        for b in census_bundles:
            d = by_bundle.get(b)
            if d is None:
                continue
            if d["path"] != f".avlo/{b}.so":
                failures.append(f"{b}: group DSO at {d['path']}, want .avlo/{b}.so")
            want = {e["pyinit"] for e in groups_json["bundles"][b]["extensions"]}
            got = set(d["pyinit"])
            for p in sorted(want - got):
                failures.append(f"{b}: census PyInit missing from group exports: {p}")
            for p in sorted(got - want):
                failures.append(f"{b}: stray PyInit export not in census: {p}")
            for e in groups_json["bundles"][b]["extensions"]:
                short = e["dottedName"].rsplit(".", 1)[-1]
                if e["pyinit"] != f"PyInit_{short}":
                    failures.append(
                        f"{b}: {e['dottedName']} pyinit {e['pyinit']} != PyInit_{short} "
                        "(create_dynamic derives from the LAST dotted component)"
                    )
            if not d["hasDylink"]:
                failures.append(f"{b}: group DSO has no dylink.0 section")
            if d["needed"]:
                failures.append(f"{b}: group NEEDED not empty: {', '.join(d['needed'])}")
            unresolved = list(
                dict.fromkeys(
                    field
                    for _mod, field, _kind in d["imports"]
                    if field not in main_exports and field not in d["exportSet"] and field not in js_glue_allow
                )
            )
            if unresolved:
                failures.append(
                    f"{b}: {len(unresolved)} imports outside main ∪ self ∪ glue: "
                    f"{', '.join(unresolved[:6])}{' …' if len(unresolved) > 6 else ''}"
                )
        for bundle, meta in metas.items():
            lo = meta.get("loadOrder", [])
            if len(lo) > 1:
                failures.append(f"{bundle}: loadOrder has {len(lo)} entries (grouped world allows ≤1)")
            for p in lo:
                if not p.startswith(".avlo/"):
                    failures.append(f"{bundle}: loadOrder entry {p} not under .avlo/")

    # ---------- report ----------------------------------------------------------
    main_loc = "dist/raw" if "dist/raw" in str(main_wasm_path) else "staged public"
    print(f"\n=== DSO census: {len(dsos)} DSOs, {_kb(sum(d['size'] for d in dsos))} total (main: {main_loc}) ===\n")
    print("bundle       n   size     memSz  tblSz  expEntries  envImp  GOT   pyinit  toolchains")
    for b in bundles:
        g = groups[b]
        tc: dict[str, int] = {}
        for d in dsos:
            if d["bundle"] == b:
                tc[d["toolchain"]] = tc.get(d["toolchain"], 0) + 1
        tcs = " ".join(f"{k}:{v}" for k, v in tc.items())
        print(
            f"{b:<12} {g['members']:>2}  {_kb(g['size']):>7} {_kb(g['memSize']):>6} {g['tableSize']:>6}  "
            f"{g['exportEntries']:>9} {g['envImports']:>7} {g['gotImports']:>5} {g['pyinits']:>6}   {tcs}"
        )
    print("\n=== import providers (all env/GOT entries, self-inclusive) ===")
    print(providers, "· js-glue names:", ", ".join(js_glue) or "(none)")
    print("self split by import kind:", self_by_kind)

    stub_totals = {"stubSelf": sum(d["stubSelf"] for d in dsos), "stubGlue": sum(d["stubGlue"] for d in dsos)}
    print("\n=== lazy-stub audit (env-func ∉ mainExports; self-provided = permanent JS stub closures under RTLD_LOCAL) ===")
    print("bundle       stubSelf  glueBound")
    for b in bundles:
        members = [d for d in dsos if d["bundle"] == b]
        print(f"{b:<12} {sum(d['stubSelf'] for d in members):>8}  {sum(d['stubGlue'] for d in members):>9}")
    print(f"total: {stub_totals['stubSelf']} self-stub / {stub_totals['stubGlue']} glue-bound")
    top_stubs = [d for d in sorted(dsos, key=lambda d: -d["stubSelf"])[:5] if d["stubSelf"] > 0]
    if top_stubs:
        print("top DSOs:", "  ".join(f"{d['bundle']}/{d['soName']}:{d['stubSelf']}" for d in top_stubs))
    needed = [d for d in dsos if d["needed"]]
    if needed:
        print("\n=== NEEDED ===")
        for d in needed:
            print(f"{d['bundle']}/{d['soName']}: {', '.join(d['needed'])}")

    totals = {
        "dsoCount": len(dsos),
        "totalBytes": sum(d["size"] for d in dsos),
        "totalExportEntries": sum(len(d["exports"]) for d in dsos),
        "totalImportEntries": sum(len(d["imports"]) for d in dsos),
        "totalGotEntries": sum(groups[b]["gotEntries"] for b in bundles),
        "totalMemSize": sum(d["memSize"] for d in dsos),
        "totalTableSize": sum(d["tableSize"] for d in dsos),
        "mainExports": len(main_exports),
        "groupCount": len(bundles),
    }
    print("\n=== totals ===")
    print(totals)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    slim_dsos = [
        {k: v for k, v in d.items() if k not in ("exportSet", "exports", "imports")}
        | {"nExports": len(d["exports"]), "nImports": len(d["imports"])}
        for d in dsos
    ]
    report = {
        "totals": totals,
        "providers": providers,
        "selfByKind": self_by_kind,
        "stubTotals": stub_totals,
        "jsGlue": list(js_glue),
        "groups": groups,
        "dsos": slim_dsos,
    }
    OUT_PATH.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
    print(f"\nfull report -> {OUT_PATH}")

    if failures:
        print(f"\nAUDIT FAILURES ({len(failures)}):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        if check_mode:
            return 1
    elif check_mode:
        print(
            "\ncheck OK: grouped-world gates green (census equality, finder-derivable inits, closed world, loadOrder shape)"
            if grouped_world
            else "\ncheck OK: PyInit shortnames unique per bundle, no PyInit-less DSO"
        )
    return 0
