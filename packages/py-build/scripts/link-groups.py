#!/usr/bin/env python3
"""Group-link each DSO-bearing bundle's harvested inputs into one side module.

Runs IN the recipes container (emcc from the xbuildenv's emsdk must be on
PATH — recipes-build.sh sources emsdk_env.sh first). Consumes the manifests
harvest-links.py just wrote plus the content-addressed stash:

  <driver> @objects.rsp <archives...> <flagsTail...>
           -sEXPORTED_FUNCTIONS=@exports.json -o <bundle>.so

The exports file is the manifest's ordered `_PyInit_*` union (the same
JSON-response-file mechanism pywasmcross' get_export_flags uses). wasm-ld
auto-exports GOT-referenced defined symbols on top (e.g. ft2font's static
freetype tables) — expected, kept. Archives follow all objects (lazy member
semantics: only referenced members pull, so duplicated static helper libs
never materialize twice).

--repro links twice and byte-compares (wasm-ld emits no timestamps).
--allow-partial (spike mode) accepts manifests with a "partial" list and
names their output spike-<bundle>.so so packaging can never consume one.

A tail flag referencing freetype-legacysjlj triggers
`embuilder build freetype-legacysjlj --pic` first — a fresh emsdk has an
empty PIC cache; idempotent.
"""

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def fail(msg: str) -> None:
    sys.exit(f"link-groups: FAIL — {msg}")


class LinkError(RuntimeError):
    """Raised inside pool workers (sys.exit in a thread only kills the thread)."""


def sh(cmd: list[str], **kw) -> None:
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise LinkError(f"command failed ({r.returncode}): {' '.join(cmd[:8])} ...")


def link_one(manifest: dict, stash: Path, out_so: Path, tmp: Path) -> None:
    tmp.mkdir(parents=True, exist_ok=True)
    objects = [stash / f"{o['h']}.o" for e in manifest["extensions"] for o in e["objects"]]
    archives = [stash / f"{a['h']}.a" for a in manifest["archives"]]
    for p in [*objects, *archives]:
        if not p.is_file():
            raise LinkError(f"stash miss: {p}")
    rsp = tmp / "objects.rsp"
    rsp.write_text("\n".join(str(p) for p in objects) + "\n")
    exports = tmp / "exports.json"
    exports.write_text(json.dumps(manifest["exports"]))
    # Archives ride inside one start/end-group: the recorded links used
    # positional -Wl,--start-group spans (meson), which the harvest strips —
    # grouping ALL archives makes member resolution order-independent, a
    # faithful superset of every recorded layout.
    group_archives = ["-Wl,--start-group", *(str(a) for a in archives), "-Wl,--end-group"] if archives else []
    cmd = [
        manifest["driver"],
        f"@{rsp}",
        *group_archives,
        *manifest["flagsTail"],
        f"-sEXPORTED_FUNCTIONS=@{exports}",
        "-o",
        str(out_so),
    ]
    sh(cmd)


def process_manifest(manifest: dict, args) -> str:
    bundle = manifest["bundle"]
    partial = manifest.get("partial")
    name = f"spike-{bundle}.so" if partial else f"{bundle}.so"
    out_so = args.out / name
    tmp = args.out / f".link-{bundle}"
    link_one(manifest, args.stash, out_so, tmp)
    if args.repro:
        out2 = tmp / "repro.so"
        link_one(manifest, args.stash, out2, tmp)
        if out_so.read_bytes() != out2.read_bytes():
            raise LinkError(f"{bundle}: --repro FAIL — group link differs across identical invocations")
        out2.unlink()
    n_ext = len(manifest["extensions"])
    return f"{name}: {out_so.stat().st_size:,} bytes ({n_ext} extensions{' PARTIAL' if partial else ''}, repro {'OK' if args.repro else 'skipped'})"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifests", required=True, type=Path)
    ap.add_argument("--stash", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--repro", action="store_true")
    ap.add_argument("--allow-partial", action="store_true")
    ap.add_argument("--jobs", type=int, default=2, help="concurrent bundle links (RAM-bound; wasm-opt peaks ~1 GB each)")
    args = ap.parse_args()

    manifest_paths = sorted(args.manifests.glob("*.json"))
    if not manifest_paths:
        fail(f"no manifests in {args.manifests} — run harvest-links.py first")
    args.out.mkdir(parents=True, exist_ok=True)

    manifests = [json.loads(mp.read_text()) for mp in manifest_paths]
    for manifest in manifests:
        partial = manifest.get("partial")
        if partial and not args.allow_partial:
            fail(f"{manifest['bundle']}: manifest is partial (missing {len(partial)}) — spike leftovers? re-harvest fully")

    # PIC cache warm-up must precede the pool (embuilder is not concurrency-safe
    # against its own empty cache); once warm it is a no-op for every link.
    if any(any("freetype-legacysjlj" in f for f in m["flagsTail"]) for m in manifests):
        print("=== embuilder build freetype-legacysjlj --pic (PIC cache warm-up)")
        try:
            sh(["embuilder", "build", "freetype-legacysjlj", "--pic"])
        except LinkError as e:
            fail(str(e))

    # Bundles link concurrently — zero shared state (per-bundle tmp dirs,
    # content-addressed read-only stash). Output order stays manifest order.
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = [pool.submit(process_manifest, m, args) for m in manifests]
        errors = []
        for m, fut in zip(manifests, futures):
            try:
                print(fut.result())
            except LinkError as e:
                errors.append(f"{m['bundle']}: {e}")
    if errors:
        fail("; ".join(errors))


if __name__ == "__main__":
    main()
