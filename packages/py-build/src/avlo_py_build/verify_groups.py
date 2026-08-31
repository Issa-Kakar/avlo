"""Host-side gate over the freshly linked grouped side modules
(dist/groups/<bundle>.so), runnable BEFORE any packaging touches them:

  avlo-build verify-groups                          # every census bundle
  avlo-build verify-groups --spike mpl-deps --pkgs kiwisolver
                                                    # verify dist/groups/
                                                    # spike-<b>.so against only
                                                    # the built pkgs' extensions
                                                    # + structural compare vs
                                                    # the upstream wheel .so(s)

Per group .so: dylink.0 present + needed == [] (nothing vendored), PyInit
export set == the census union for the bundle (exact equality — a missing
PyInit means a dropped extension, an extra one means a stray input), and
closed-world vs the CURRENT main module: every census-relevant import
(env/GOT.mem/GOT.func, invoke_*/plumbing excluded) resolves from
mainExports ∪ own exports ∪ the js-glue allowlist ({exit} today). The
grouped imports ⊆ old per-extension union, so this holds against the
EXISTING main before link.rsp regenerates — the de-risking property the
packaging swap leans on.
"""

import json
import sys
import zipfile

from .config import load
from .paths import FORK_PUBLIC, GROUPS_DIR, PKG_ROOT, RAW_DIR, WHEEL_CACHE
from .wasmmeta import ParsedWasm, census_imports, parse_wasm

JS_GLUE_ALLOW = frozenset(["exit"])


def run(args) -> int:
    groups = json.loads((PKG_ROOT / "config/dso-groups/groups.json").read_text())
    cfg = load()
    main_wasm_path = next(
        (p for p in (FORK_PUBLIC / "pyodide.asm.wasm", RAW_DIR / "pyodide.asm.wasm") if p.exists()), None
    )
    if main_wasm_path is None:
        sys.exit("no pyodide.asm.wasm found (staged public or dist/raw)")
    main_exports = set(parse_wasm(main_wasm_path.read_bytes(), want_dylink=False).exports)

    failures: list[str] = []

    def verify_one(bundle: str, exts: list[dict], so_path) -> ParsedWasm | None:
        if not so_path.exists():
            failures.append(f"{bundle}: {so_path} missing — run the recipes loop")
            return None
        data = so_path.read_bytes()
        w = parse_wasm(data)
        name = so_path.name
        if w.dylink is None:
            failures.append(f"{name}: no dylink.0 section")
        elif w.dylink.needed:
            failures.append(f"{name}: NEEDED not empty: {', '.join(w.dylink.needed)}")
        want_pyinits = {e["pyinit"] for e in exts}
        got_pyinits = {x for x in w.exports if x.startswith("PyInit")}
        for p in sorted(want_pyinits - got_pyinits):
            failures.append(f"{name}: census PyInit missing from exports: {p}")
        for p in sorted(got_pyinits - want_pyinits):
            failures.append(f"{name}: stray PyInit export not in census: {p}")
        export_set = set(w.exports)
        imp = census_imports(w)
        unresolved = list(
            dict.fromkeys(
                field
                for _m, field, _k in imp
                if field not in main_exports and field not in export_set and field not in JS_GLUE_ALLOW
            )
        )
        if unresolved:
            failures.append(
                f"{name}: {len(unresolved)} imports outside main ∪ self ∪ glue: "
                f"{', '.join(unresolved[:8])}{' …' if len(unresolved) > 8 else ''}"
            )
        dl = w.dylink
        print(
            f"{name}: {len(data):,} B · {len(w.exports)} exports ({len(got_pyinits)} PyInit) · "
            f"{len(imp)} census imports · dylink mem {dl.memSize if dl else '??'} tbl {dl.tableSize if dl else '??'} · "
            f"needed [{', '.join(dl.needed) if dl else '?'}]"
        )
        return w

    if args.spike:
        g = groups["bundles"].get(args.spike)
        if g is None:
            sys.exit(f"unknown bundle {args.spike}")
        spike_pkgs = set(args.pkgs.split(",")) if args.pkgs else None
        exts = [e for e in g["extensions"] if spike_pkgs is None or e["pkg"] in spike_pkgs]
        w = verify_one(args.spike, exts, GROUPS_DIR / f"spike-{args.spike}.so")
        if w is not None:
            # Structural compare vs the upstream wheel .so(s) — census-level,
            # NOT byte-equality (container paths leak into debug strings by
            # design).
            for e in exts:
                pin = cfg.recipes.wheels[e["pkg"]]
                wheel = WHEEL_CACHE / pin.file
                if not wheel.exists():
                    print(f"(no {pin.file} in .cache/wheels — skipping upstream compare for {e['dottedName']})")
                    continue
                with zipfile.ZipFile(wheel) as z:
                    try:
                        up = parse_wasm(z.read(e["wheelSoPath"]))
                    except KeyError:
                        sys.exit(f"{e['wheelSoPath']} not in {pin.file}")
                up_imports = {f for _m, f, _k in census_imports(up)}
                group_exports = set(w.exports)
                escaped = [
                    f
                    for f in dict.fromkeys(f for _m, f, _k in census_imports(w))
                    if f not in up_imports and f not in group_exports
                ]
                udl = up.dylink
                print(
                    f"vs upstream {e['dottedName']}: upstream {len(up.exports)} exports / "
                    f"{len(census_imports(up))} census imports · dylink mem {udl.memSize if udl else None} "
                    f"tbl {udl.tableSize if udl else None} · "
                    f"group-not-in-upstream imports: {', '.join(escaped) if escaped else '(none)'}"
                )
                if escaped:
                    failures.append(f"spike {e['dottedName']}: group imports {len(escaped)} symbols upstream never imported")
    else:
        for bundle, g in groups["bundles"].items():
            verify_one(bundle, g["extensions"], GROUPS_DIR / f"{bundle}.so")

    if failures:
        print(f"\nverify-groups FAILURES ({len(failures)}):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print("\nverify-groups OK")
    return 0
