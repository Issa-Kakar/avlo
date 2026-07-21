#!/usr/bin/env python3
"""Harvest recorded extension links into per-bundle group-link manifests.

Runs IN the recipes container right after the package builds (recorded paths
are live there). Inputs:
  --groups   committed census (config/dso-groups/groups.json) — the source of
             truth for which extensions exist per DSO-bearing bundle
  --records  AVLO_LINK_RECORD_DIR — one JSON per successful .so link, written
             by the pywasmcross record hook (patches/pyodide-build/0001)
  --stash    content-addressed .o/.a store (written here, consumed by
             link-groups.py; rsynced to .cache/link-inputs/ by run-recipes)
  --out      manifest output dir (dist mount; run-recipes copies non-partial
             manifests to the committed config/dso-groups/<bundle>.json)
  --pkgs     optional csv filter (spike mode) — bundles missing extensions
             get "partial": [missing dotted names] and are never committed

Matching is by (pkg, PyInit shortname) — record outputs still carry the HOST
triplet in their filenames (replace_so_abi_tags renames only inside the
wheel, after linking), so filenames cannot match the census. The record's
exports file content (captured at link time; the tmpfile dies with the
build) yields the extension's `_PyInit_<short>`.

Per bundle the manifest carries: toolchain pins, reconciled driver +
flags-tail (hard-fail with a diff if the bundle's links disagree), ordered
extensions with content-hash object lists (census lexicographic order;
recorded object order within), content-deduped archives appended after all
objects in first-appearance order, and the ordered `_PyInit_*` export union.

Hard failures (never warnings): unmatched census extension, missing input
file, rsp parse failure, ambiguous (pkg,pyinit) records, .so inputs on a
link line, position-sensitive input flags (--whole-archive), tail mismatch,
duplicate strong definitions across a bundle's link inputs (collision gate).
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Cython embeds the path where it resolved each cimported .pxd into the
# generated C's file table (tracebacks) — for pandas that is numpy's pxd
# inside pip's ISOLATED BUILD ENV, whose tempdir name is random per build
# (/tmp/build-env-<8 chars>/...). Without normalization every rebuild churns
# the ~31 numpy-cimporting pandas objects (measured: two pinned rebuilds
# differed in exactly this one string per object; numpy/matplotlib/mpl-deps
# were byte-identical). Length-preserving rewrite => no offsets shift, wasm
# section sizes unchanged; the string is debug-cosmetic (upstream's own
# wheels ship the same ephemeral paths). Objects only — the numpy archives
# proved rebuild-stable as-is.
_BUILD_ENV_RE = re.compile(rb"build-env-[a-z0-9_]{8}")

CONFIG = json.loads((Path(__file__).resolve().parent.parent / "build.config.json").read_text())

# --- flag-tail normalization (each rule individually reviewed) --------------
# Recorded link argvs differ across extensions/build-systems in ways that
# cannot change the OUTPUT of a source-less link (only .o/.a inputs). The
# reconciliation gate compares tails after this normalization; anything it
# still can't reconcile is a hard failure, so these rules are the reviewed
# rungs of the flag-tail ladder, not a loosening:
#
# * '-s X' two-token spellings canonicalize to '-sX' (same emcc semantics;
#   makes dedup safe).
# * Compile-phase-only tokens drop: -D<macro> and plain warning flags
#   (-Wall/-Wsign-compare/... — NOT -Wl,* linker args, NOT -Werror=* which
#   pywasmcross adds AT LINK for wasm-ld's function-signature warnings).
#   With no source files on the line they are inert by construction.
# * -O*/-g* keep only the LAST of each (emcc last-wins; setuptools leaks the
#   compile-time '-g -O3' prefix that later '-O2 -g0 ... -Oz' supersede).
# * Exact duplicate tokens dedupe to first occurrence (idempotent flags —
#   setuptools repeats -fPIC/-fwasm-exceptions via CFLAGS-in-LDSHARED).
# * Position-sensitive tokens (-L/-l/-Wl,) must match ORDERED; everything
#   else as a multiset (settings/codegen flags are position-insensitive).
#
# TAIL_UNION_OK: flags allowed to differ per extension because they are
# ADDITIVE-SAFE at the group link — unioned into the final tail and recorded
# as `unionedFlags`:
# * -sUSE_FREETYPE (matplotlib: freetype-consuming extensions only) adds the
#   freetype port archive; lazy archives make it a no-op for non-consumers,
#   and -lfreetype-legacysjlj (in every tail) still resolves first — the
#   both-flags environment upstream's own freetype links ran with.
# * -lm — emscripten's libm rides libc; the flag maps to the always-linked
#   builtin (numpy/pandas: only some extensions carry it).
# * -shared / -Wl,-O1 / -sERROR_ON_UNDEFINED_SYMBOLS=0 — meson linkisms
#   absent from setuptools links; under -sSIDE_MODULE=2 they are implied or
#   inert (side modules are shared objects with relaxed undefineds).
TAIL_UNION_OK = {"-sUSE_FREETYPE", "-lm", "-shared", "-Wl,-O1", "-sERROR_ON_UNDEFINED_SYMBOLS=0"}
POSITIONAL = ("-L", "-l", "-Wl,")


def normalize_tail(tail: list[str]) -> list[str]:
    toks: list[str] = []
    i = 0
    while i < len(tail):
        if tail[i] == "-s" and i + 1 < len(tail):
            toks.append(f"-s{tail[i + 1]}")
            i += 2
            continue
        toks.append(tail[i])
        i += 1
    toks = [
        t
        for t in toks
        if not t.startswith("-D") and not (t.startswith("-W") and not t.startswith("-Wl,") and not t.startswith("-Werror"))
    ]
    last_o = max((i for i, t in enumerate(toks) if t.startswith("-O")), default=None)
    last_g = max((i for i, t in enumerate(toks) if t.startswith("-g")), default=None)
    out: list[str] = []
    seen: set[str] = set()
    for i, t in enumerate(toks):
        if t.startswith("-O") and i != last_o:
            continue
        if t.startswith("-g") and i != last_g:
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def fail(msg: str) -> None:
    sys.exit(f"harvest-links: FAIL — {msg}")


def load_records(records_dir: Path) -> dict[tuple[str, str], dict]:
    """(pkg, 'PyInit_<short>') -> record. Ambiguity is a hard failure."""
    index: dict[tuple[str, str], dict] = {}
    for p in sorted(records_dir.glob("*.json")):
        rec = json.loads(p.read_text())
        content = rec.get("exportsFileContent")
        if not content:
            fail(f"{p.name}: record has no exports content (non-pyinit link?) — investigate")
        pyinits = [e.removeprefix("_") for e in json.loads(content) if e.startswith("_PyInit")]
        if len(pyinits) != 1:
            fail(f"{p.name}: expected exactly 1 PyInit export, got {pyinits}")
        key = (rec["pkg"], pyinits[0])
        prev = index.get(key)
        if prev is not None and prev["output"] != rec["output"]:
            fail(f"ambiguous records for {key}: {prev['output']} vs {rec['output']}")
        rec["pyinit"] = pyinits[0]
        index[key] = rec
    return index


def resolve_input(tok: str, cwd: Path) -> Path:
    p = Path(tok)
    if not p.is_absolute():
        p = cwd / p
    if not p.is_file():
        fail(f"link input missing on disk: {tok} (cwd {cwd})")
    return p


def expand_record(rec: dict) -> tuple[list[Path], list[Path], list[str]]:
    """argv -> (ordered .o inputs, ordered .a inputs, flags tail).

    @rsp args are expanded in place: their .o/.a tokens become inputs, any
    other tokens join the tail at the rsp's position. The -o pair and the
    -sEXPORTED_FUNCTIONS tmpfile arg are stripped (per-link-unique). A
    leftover .so token or a --whole-archive is a hard failure.
    """
    cwd = Path(rec["cwd"])
    objs: list[Path] = []
    ars: list[Path] = []
    tail: list[str] = []
    argv = rec["argv"][1:]
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok == "-o":
            i += 2
            continue
        if tok.startswith("-sEXPORTED_FUNCTIONS="):
            i += 1
            continue
        toks = [tok]
        if tok.startswith("@"):
            rsp = Path(tok[1:])
            if not rsp.is_absolute():
                rsp = cwd / rsp
            if not rsp.is_file():
                fail(f"rsp file missing: {tok} (cwd {cwd})")
            try:
                toks = shlex.split(rsp.read_text())
            except ValueError as e:
                fail(f"rsp parse failure {rsp}: {e}")
        for t in toks:
            if t.startswith("-"):
                if "whole-archive" in t:
                    fail(f"position-sensitive input flag {t!r} in {rec['output']} — needs manual handling")
                if t in ("-Wl,--start-group", "-Wl,--end-group"):
                    # Positional archive-group markers lose their meaning once
                    # inputs are re-ordered into the manifest layout —
                    # link-groups.py wraps ALL archives in one start/end-group
                    # instead (order-independent resolution, a faithful
                    # superset of the recorded semantics).
                    continue
                tail.append(t)
            elif t.endswith(".o"):
                objs.append(resolve_input(t, cwd))
            elif t.endswith(".a"):
                ars.append(resolve_input(t, cwd))
            elif t.endswith(".so") or ".so." in t:
                fail(f"unexpected .so input {t!r} in {rec['output']} (vendored sharedlib? census says needed==[])")
            else:
                tail.append(t)
        i += 1
    return objs, ars, tail


def stash_file(path: Path, stash: Path, seen: dict[Path, str], cwd: Path | None = None) -> str:
    """Copy into the content-addressed stash; returns '<sha256>'.

    meson emits THIN archives (`!<thin>\\n` — members referenced by path,
    not embedded); content-addressing one would orphan its members, so thin
    archives repack into regular deterministic archives (emar rcsD, zeroed
    timestamps) from the resolved member paths — lazy member semantics
    preserved exactly. Regular archives and objects pass through verbatim.
    """
    got = seen.get(path)
    if got is not None:
        return got
    data = path.read_bytes()
    if path.suffix == ".o":
        normalized = _BUILD_ENV_RE.sub(b"build-env-00000000", data)
        if normalized != data:
            assert len(normalized) == len(data)
            data = normalized
    if data[:8] == b"!<thin>\n":
        members = subprocess.run(["emar", "t", str(path)], capture_output=True, text=True, check=True).stdout.split("\n")
        resolved: list[Path] = []
        for m in filter(None, members):
            for base in (path.parent, cwd or path.parent):
                p = base / m
                if p.is_file():
                    resolved.append(p)
                    break
            else:
                fail(f"thin-archive member missing on disk: {m} (archive {path})")
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "repacked.a"
            subprocess.run(["emar", "rcsD", str(tmp), *map(str, resolved)], check=True, capture_output=True)
            data = tmp.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    dest = stash / f"{sha}{path.suffix}"
    if not dest.exists():
        dest.write_bytes(data)
    seen[path] = sha
    return sha


_STRONG_DEFS_CACHE: dict[str, frozenset[str]] = {}


def resolve_nm() -> str:
    emsdk = os.environ.get("EMSDK")
    if emsdk and (p := Path(emsdk) / "upstream/bin/llvm-nm").is_file():
        return str(p)
    for tool in ("llvm-nm", "emnm"):
        if found := shutil.which(tool):
            return found
    fail("no llvm-nm/emnm available (source emsdk_env.sh first) — the duplicate-def gate needs it")


def strong_defs(nm: str, path: Path, sha: str) -> frozenset[str]:
    got = _STRONG_DEFS_CACHE.get(sha)
    if got is not None:
        return got
    r = subprocess.run([nm, str(path)], capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"llvm-nm failed on {path}: {r.stderr.strip()[:200]}")
    defs = frozenset(p[2] for l in r.stdout.splitlines() if len(p := l.split()) == 3 and p[1] in ("T", "D"))
    _STRONG_DEFS_CACHE[sha] = defs
    return defs


def collision_gate(bundle: str, inputs: list[tuple[str, str, str]], stash: Path, nm: str) -> None:
    """Hard-fail when any symbol has STRONG (T/D) defs in >1 link input.

    Inputs are content-unique post-dedup, so >1 defining input == a
    distinct-content duplicate — the class that mis-binds at a group link:
    an immediate object def shadows a lazy archive member, and wasm-ld only
    errors when the SIGNATURES differ, so same-signature shadowing would be
    silent wrong-code. numpy's mtrand legacy family (66 long-typed copies of
    the int64 distributions.c symbols) needed a compile-time rename to pass
    (recipes patch 0004); a future recipe bump growing that family — in any
    bundle — fails here first, loudly. `__wasm*` (per-object ctor stubs
    wasm-ld merges) excluded; weak (W) COMDATs excluded — first-def-wins
    dedup is their defined semantics.
    """
    definers: dict[str, list[str]] = {}
    for sha, suffix, label in inputs:
        for s in strong_defs(nm, stash / f"{sha}{suffix}", sha):
            if s.startswith("__wasm"):
                continue
            definers.setdefault(s, []).append(label)
    dups = {s: v for s, v in definers.items() if len(v) > 1}
    if dups:
        shown = [f"  {s}: {' | '.join(v)}" for s, v in sorted(dups.items())[:15]]
        more = f"\n  ... and {len(dups) - 15} more" if len(dups) > 15 else ""
        sys.stderr.write(f"{bundle}: {len(dups)} symbols with strong defs in >1 link input:\n" + "\n".join(shown) + more + "\n")
        fail(f"{bundle}: duplicate strong definitions — group link would mis-bind (numpy precedent: patches/recipes/0004)")
    print(f"{bundle}: duplicate-def gate clean ({len(definers)} strong defs across {len(inputs)} inputs)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", required=True, type=Path)
    ap.add_argument("--records", required=True, type=Path)
    ap.add_argument("--stash", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--pkgs", default=None, help="csv filter (spike mode)")
    args = ap.parse_args()

    groups = json.loads(args.groups.read_text())
    only_pkgs = set(args.pkgs.split(",")) if args.pkgs else None
    records = load_records(args.records)
    args.stash.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    seen: dict[Path, str] = {}
    nm = resolve_nm()

    toolchain = {
        "recipesCommit": CONFIG["recipes"]["commit"],
        "pyodideBuildCommit": CONFIG["recipes"]["pyodideBuildCommit"],
        "xbuildenv": CONFIG["xbuildenv"]["version"],
        "emscripten": CONFIG["toolchain"]["emscripten"],
        "abi": CONFIG["toolchain"]["abi"],
    }

    for bundle, g in groups["bundles"].items():
        exts = [e for e in g["extensions"] if only_pkgs is None or e["pkg"] in only_pkgs]
        missing = [e["dottedName"] for e in g["extensions"] if e not in exts]
        if not exts:
            print(f"{bundle}: no extensions selected, skipping")
            continue

        drivers: set[str] = set()
        tails: list[tuple[str, list[str]]] = []
        m_exts = []
        archives: list[tuple[str, str]] = []  # (sha, basename) first-appearance
        obj_seen: set[str] = set()
        gate_inputs: list[tuple[str, str, str]] = []  # (sha, suffix, label)
        dedup_dropped = 0
        for e in exts:
            rec = records.get((e["pkg"], e["pyinit"]))
            if rec is None:
                fail(f"harvest gap: no link record for {bundle}/{e['dottedName']} ({e['pkg']}, {e['pyinit']})")
            objs, ars, tail = expand_record(rec)
            if not objs:
                fail(f"{bundle}/{e['dottedName']}: link record has no .o inputs")
            drivers.add(rec["driver"])
            tails.append((e["dottedName"], tail))
            m_objs = []
            for o in objs:
                sha = stash_file(o, args.stash, seen)
                if sha in obj_seen:
                    dedup_dropped += 1  # identical bytes already in the group — one copy serves all
                    continue
                obj_seen.add(sha)
                m_objs.append({"h": sha, "n": o.name})
                gate_inputs.append((sha, ".o", f"{e['dottedName']}:{o.name}"))
            for a in ars:
                sha = stash_file(a, args.stash, seen, cwd=Path(rec["cwd"]))
                if all(sha != s for s, _ in archives):
                    archives.append((sha, a.name))
                    gate_inputs.append((sha, ".a", a.name))
            m_exts.append({"pkg": e["pkg"], "dottedName": e["dottedName"], "pyinit": e["pyinit"], "objects": m_objs})

        # Tail reconciliation: normalized tails must agree across the bundle —
        # positional (-L/-l/-Wl,) tokens ordered-equal, the rest as a
        # multiset — after setting aside the reviewed TAIL_UNION_OK flags.
        unioned: list[str] = []
        cores: list[tuple[str, list[str]]] = []
        for name, tail in tails:
            norm = normalize_tail(tail)
            core = [t for t in norm if t not in TAIL_UNION_OK]
            for t in norm:
                if t in TAIL_UNION_OK and t not in unioned:
                    unioned.append(t)
            cores.append((name, core))
        ref_name, ref_core = cores[0]
        for name, core in cores[1:]:
            pos_ref = [t for t in ref_core if t.startswith(POSITIONAL)]
            pos = [t for t in core if t.startswith(POSITIONAL)]
            if pos != pos_ref or sorted(core) != sorted(ref_core):
                sys.stderr.write(f"flag-tail mismatch in {bundle} (normalized):\n  {ref_name}: {ref_core}\n  {name}: {core}\n")
                fail(f"{bundle}: non-uniform link flags — extend the normalizer or record a reviewed override")
        final_tail = ref_core + unioned
        driver = "em++" if "em++" in drivers else drivers.pop()
        collision_gate(bundle, gate_inputs, args.stash, nm)

        manifest = {
            "$comment": f"GENERATED by harvest-links.py — group-link inputs for bundle {bundle!r}. "
            "Objects are content-addressed into the link-input stash; link-groups.py consumes this verbatim.",
            "schema": 1,
            "bundle": bundle,
            **({"partial": missing} if missing else {}),
            "toolchain": toolchain,
            "driver": driver,
            "flagsTail": final_tail,
            **({"unionedFlags": unioned} if unioned else {}),
            "extensions": m_exts,
            "archives": [{"h": s, "n": n} for s, n in archives],
            "exports": [f"_{e['pyinit']}" for e in m_exts],
        }
        (args.out / f"{bundle}.json").write_text(json.dumps(manifest, indent=1) + "\n")
        note = f" PARTIAL (missing {len(missing)})" if missing else ""
        dd = f", {dedup_dropped} identical objects deduped" if dedup_dropped else ""
        print(
            f"{bundle}: {len(m_exts)} extensions, {sum(len(e['objects']) for e in m_exts)} objects, "
            f"{len(archives)} archives, tail {len(final_tail)} flags ({driver}){dd}{note}"
        )


if __name__ == "__main__":
    main()
