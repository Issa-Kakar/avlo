"""Stage the built artifacts for dev serving + regenerate the checked-in
import-gate module. One entry point for "make the app see what I built".

  avlo-build stage           # stage + write manifest + gen.ts
  avlo-build stage --check   # drift gate: fails if anything on disk differs
                             # from what a stage would write (catches the
                             # restage ⇒ recapture rule: staged zip must
                             # equal the built zip)

Staged tree (web/public/py-dev/fork/, gitignored):
  pyodide.asm.mjs / pyodide.asm.wasm / pyodide.mjs  (dist/raw; patch 0006
                                      dropped the pyodide.js/package.json/
                                      pyodide-lock.json boot crutch; 314
                                      renamed the asm glue to .mjs)
  python_stdlib.zip                  (pruned zip — dist/stage)
  bundles/<name>.tar                 (dist/stage/bundles)
  (no snapshot artifacts: snapshots are client-captured, OPFS-only)
  manifest.json                      (generated here; field-compatible with
                                      M3's R2 manifest)
Checked-in codegen:
  web/src/core/py/py-stdlib-modules.gen.ts
  web/src/core/py/pyodide-fork.gen.d.ts (dist/raw/pyodide.d.ts — app-side
                                        fork types; NOT part of buildHash)
  packages/py-loader/build-lock.json   (the committed app↔artifact coupling;
                                        restage ⇒ new buildHash ⇒ reseed R2
                                        (avlo-build publish) + commit the lock)
"""

import hashlib
import json
import re
import sys

from . import packlib
from .config import load
from .paths import BUILD_LOCK, BUNDLES_OUT, FORK_PUBLIC, PKG_ROOT, RAW_DIR, REPO_ROOT, STAGE_DIR

GEN_PATH = REPO_ROOT / "web/src/core/py/py-stdlib-modules.gen.ts"
DTS_GEN_PATH = REPO_ROOT / "web/src/core/py/pyodide-fork.gen.d.ts"

ARTIFACTS = {
    "pyodide.asm.mjs": "dist/raw/pyodide.asm.mjs",
    "pyodide.asm.wasm": "dist/raw/pyodide.asm.wasm",
    "pyodide.mjs": "dist/raw/pyodide.mjs",
    "python_stdlib.zip": "dist/stage/python_stdlib.zip",
}

_IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_SEG = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(v) -> str:
    """Recursively key-sorted canonical JSON (the buildHash byte-form)."""
    if isinstance(v, list):
        return f"[{','.join(_canonical(x) for x in v)}]"
    if isinstance(v, dict):
        return f"{{{','.join(f'{json.dumps(k, ensure_ascii=False)}:{_canonical(v[k])}' for k in sorted(v))}}}"
    return json.dumps(v, ensure_ascii=False)


def _json2(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode()


def _prune_keys(path) -> list[str]:
    keys = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not (line.endswith("/") or line.endswith(".py")):
            continue
        key = line.rstrip("/").removesuffix(".py").replace("/", ".")
        if all(_SEG.match(seg) for seg in key.split(".")):
            keys.append(key)
    return keys


def run(args) -> int:
    check = args.check
    cfg = load()
    bundles_cfg = cfg.bundles
    sets_cfg = cfg.sets

    # ---- collect artifact bytes ---------------------------------------------
    files: dict[str, bytes] = {}  # staged rel path -> bytes
    for name, rel in ARTIFACTS.items():
        p = PKG_ROOT / rel
        if not p.exists():
            sys.exit(f"missing {rel} — build/pack it first")
        files[name] = p.read_bytes()

    # Prestage liveness gate: the built glue must carry the emsdk dsoBaseHook
    # (P2 snapshot replay — a silently-unpatched dylink layer fails only at
    # runtime, hours downstream) and the dynload surface 0006's side-effect
    # import anchors (esbuild would tree-shake API.loadDynlib without it).
    glue = files["pyodide.asm.mjs"]
    for marker in (b"snapshot DSO table drift", b"loadDynlib"):
        if marker not in glue:
            sys.exit(f'built glue is missing "{marker.decode()}" — rebuild with the full patch queue (run-build.mjs)')
    # Wasm-gc trampoline liveness: the glue must DEFINE getWasmTrampolineModule
    # (call site + EM_JS definition ⇒ ≥2 occurrences). One occurrence = the
    # archive member never linked (the MAIN_MODULE=2 lazy-archive regression
    # the 0001 `-Wl,-u` exists for) and every METH_* call pays a JS round-trip.
    n = glue.count(b"getWasmTrampolineModule")
    if n < 2:
        sys.exit(
            f"built glue has {n} occurrence(s) of getWasmTrampolineModule (need call site + definition) — "
            "the wasm-gc trampoline is dead; check patch 0001's -Wl,-u,__em_js__getWasmTrampolineModule"
        )

    bundle_meta: dict[str, dict] = {}
    for b in bundles_cfg:
        p = BUNDLES_OUT / f"{b}.tar"
        if not p.exists():
            sys.exit(f"missing bundle {b}.tar — pack-bundles first")
        buf = p.read_bytes()
        files[f"bundles/{b}.tar"] = buf
        meta = packlib.parse_tar_meta(buf)
        bundle_meta[b] = {"sha256": _sha256(buf), "size": len(buf), "provides": meta["provides"], "requires": meta["requires"]}

    # ---- allowlist inputs -----------------------------------------------------
    stdlib_json = json.loads((STAGE_DIR / "stdlib-modules.json").read_text())
    builtins = json.loads((STAGE_DIR / "builtin-modules.json").read_text())
    # Tombstoned TOP-LEVEL stdlib names (ctypes, bz2, http, …) stay allowed —
    # the runtime tombstone error beats a click-time refusal. Dotted keys
    # (xml.sax) ride their shipped parent.
    tombstoned_tops = [k for k in stdlib_json["tombstoned"] if "." not in k]
    stdlib_modules = sorted(set(stdlib_json["modules"]) | set(builtins) | set(tombstoned_tops))

    tombstones = _prune_keys(PKG_ROOT / "config/stdlib-prune.txt")
    for f in sorted((PKG_ROOT / "config/pkg-prune").iterdir()):
        if f.name.endswith(".txt"):
            tombstones.extend(_prune_keys(f))
    tombstones.sort()

    # import root -> SMALLEST set key providing it (py-imports merges upward).
    package_to_set: dict[str, str] = {}
    for bundle, meta in bundle_meta.items():
        smallest = sorted(((k, m) for k, m in sets_cfg.items() if bundle in m), key=lambda kv: len(kv[1]))[0][0]
        for name in meta["provides"]:
            package_to_set[name] = smallest

    # ---- build-lock -----------------------------------------------------------
    # buildHash = 16-hex truncated sha256 over canonical (recursively
    # key-sorted) JSON of the slim sha tables — deterministic for identical
    # artifact bytes. The committed lock is the supervisor's ONLY artifact
    # source of truth (no boot-time manifest fetch); manifest.json stays the
    # R2 completion marker + provides/requires superset.
    artifact_table = {name: {"sha256": _sha256(files[name]), "size": len(files[name])} for name in ARTIFACTS}
    bundle_table = {b: {"sha256": m["sha256"], "size": m["size"]} for b, m in bundle_meta.items()}
    build_hash = _sha256(_canonical({"artifacts": artifact_table, "bundles": bundle_table, "sets": sets_cfg}).encode())[:16]
    build_lock_bytes = _json2({"schema": 1, "buildHash": build_hash, "artifacts": artifact_table, "bundles": bundle_table, "sets": sets_cfg})

    # ---- manifest + gen.ts ------------------------------------------------------
    files["manifest.json"] = _json2(
        {
            "schema": 1,
            "buildHash": build_hash,
            "artifacts": artifact_table,
            "bundles": bundle_meta,
            "sets": sets_cfg,
            "stdlibModules": stdlib_modules,
            "tombstones": tombstones,
        }
    )

    # Emit biome-shaped source (single quotes, unquoted identifier keys) so the
    # pre-commit formatter is a no-op and --check's byte-compare holds.
    def q(s: str) -> str:
        return f"'{s}'"

    def key(s: str) -> str:
        return s if _IDENT.match(s) else q(s)

    nl = "\n"
    gen_source = f"""// GENERATED by packages/py-build (avlo-build stage) — DO NOT EDIT.
// Inputs: dist/stage/stdlib-modules.json (avlo-build pack-stdlib),
// dist/stage/builtin-modules.json (dump-builtins.mjs), build.config.json,
// bundle tar metas. Drift gate: `avlo-build stage --check`.

/** Set keys the runtime can boot: 'stdlib' plus the configured bundle sets.
 * THE PySetKey — py-protocol re-exports this union, so the type can never
 * lag the set tables again. */
export type PySetKey = 'stdlib' | {' | '.join(q(k) for k in sets_cfg)};

/** Top-level importable names in the shipped runtime: pruned-stdlib zip
 * contents + the fork's true builtin_module_names. Tombstoned top-levels are
 * INCLUDED deliberately — the runtime's tombstone error is more precise than
 * a click-time refusal. */
export const STDLIB_MODULES: ReadonlySet<string> = new Set([
{nl.join(f'  {q(m)},' for m in stdlib_modules)}
]);

/** Import root -> the SMALLEST bundle-set key providing it (the click-time
 * gate merges upward across multiple roots). Frozen: consumed by the
 * supervisor worker and main thread alike — never reshapeable at runtime. */
export const PACKAGE_TO_SET: Readonly<Record<string, Exclude<PySetKey, 'stdlib'>>> = Object.freeze({{
{nl.join(f'  {key(k)}: {q(v)},' for k, v in sorted(package_to_set.items()))}
}});

/** Package import roots the current artifact set actually provides. */
export const AVAILABLE_PACKAGES: ReadonlySet<string> = new Set(Object.keys(PACKAGE_TO_SET));

/** Set key -> member bundles, deps-first (mount order). Mirrors the packer
 * config; the click-time gate merges multi-package needs by bundle union. */
export const SET_BUNDLES: Readonly<Record<Exclude<PySetKey, 'stdlib'>, readonly string[]>> = Object.freeze({{
{nl.join(f"  {key(k)}: Object.freeze([{', '.join(q(x) for x in v)}])," for k, v in sets_cfg.items())}
}});
"""

    # ---- fork public types (pyodide-fork.gen.d.ts) ------------------------------
    # dist/raw/pyodide.d.ts staged for app-side typing (py-loader's Pyodide);
    # checked in + drift-gated like the gen.ts, deliberately NEVER hashed into
    # buildHash — types carry no runtime bytes. One deterministic transform:
    # drop the emitted `node:stream/web` import (its two ReadableStream/
    # WritableStream refs sit on the unused Socket surface and lib.dom's
    # globals cover them — the web tsconfig has no node types).
    dts_raw_path = RAW_DIR / "pyodide.d.ts"
    if not dts_raw_path.exists():
        sys.exit("missing dist/raw/pyodide.d.ts — rebuild (run-build.mjs) first")
    node_stream_import = "import { ReadableStream, WritableStream } from 'node:stream/web';\n"
    dts_raw = dts_raw_path.read_text()
    if node_stream_import not in dts_raw:
        sys.exit("dist/raw/pyodide.d.ts: the node:stream/web import to strip is gone — dts emission changed, re-derive this transform")
    dts_source = (
        "// GENERATED by packages/py-build (avlo-build stage) from dist/raw/pyodide.d.ts — DO NOT EDIT.\n"
        "// The fork's emitted public types (patch 0009 declares _module/_api + the\n"
        "// Module runtime exports). Drift gate: `avlo-build stage --check`.\n"
        + dts_raw.replace(node_stream_import, "", 1)
    )

    # ---- write or check ---------------------------------------------------------
    drift = 0

    def compare(path, want: bytes) -> None:
        nonlocal drift
        if not (path.exists() and path.read_bytes() == want):
            print(f"DRIFT {path}", file=sys.stderr)
            drift += 1

    if check:
        for rel, buf in files.items():
            compare(FORK_PUBLIC / rel, buf)
        compare(GEN_PATH, gen_source.encode())
        compare(DTS_GEN_PATH, dts_source.encode())
        compare(BUILD_LOCK, build_lock_bytes)
        print(f"stage --check: {drift} file(s) drifted — rerun avlo-build stage" if drift else "stage --check: clean")
        return 1 if drift else 0

    (FORK_PUBLIC / "bundles").mkdir(parents=True, exist_ok=True)
    for rel, buf in files.items():
        (FORK_PUBLIC / rel).write_bytes(buf)
    # Prune strays — the fork dir is gitignored, so a dropped artifact (e.g.
    # the pre-0006 boot crutch) would otherwise linger unseen by --check
    # forever.
    for sub in ("", "bundles/"):
        for entry in (FORK_PUBLIC / sub if sub else FORK_PUBLIC).iterdir():
            if entry.is_file() and (sub + entry.name) not in files:
                entry.unlink()
                print(f"pruned stray {sub}{entry.name}")
    GEN_PATH.write_bytes(gen_source.encode())
    DTS_GEN_PATH.write_bytes(dts_source.encode())
    BUILD_LOCK.write_bytes(build_lock_bytes)
    print(f"staged {len(files)} files -> {FORK_PUBLIC}")
    print(f"wrote {GEN_PATH} ({len(stdlib_modules)} stdlib modules, {len(package_to_set)} package roots)")
    print(f"wrote {BUILD_LOCK} (buildHash {build_hash})")
    return 0
