"""Loop-B link closure: emit .cache/link-sos/link.rsp — one
-Wl,--export-if-defined=<sym> per symbol in the UNION of every shipped DSO's
func/global/tag imports. Host-side because /pb mounts read-only in the build
container. (Decoupled from fetch-wheels, which historically carried this as
a second job.)

P1.5: the shipped DSOs are the GROUPED side modules (dist/groups/<bundle>.so,
one per DSO-bearing bundle from config/dso-groups/groups.json — linked by the
recipes loop from the packages' original link inputs). Hard-error when any is
missing: no silent fallback to the per-extension wheel scan — the groups are
the DSO source of truth now, and grouped imports ⊆ the old per-extension
union (intra-group references internalize), so link.rsp only ever shrinks.

Why export-if-defined of the import union, and NOT the .so files on the link
line: putting a dylib on the wasm-ld command line makes its STRONG exports
preempt the main module's own WEAK (C++ COMDAT vague-linkage) definitions —
the classic ELF shared-def-beats-weak-def rule. That turned main's
self-contained basic_stringbuf/stringstream instantiations into required
runtime imports of kiwisolver's _cext.so, which can never resolve at boot
(bundles mount lazily per set — nothing auto-loads). The import union
reproduces the ONLY effect we want from emcc's process_dynamic_libs: every
symbol the main module defines that some DSO needs survives metadce as an
export; cross-DSO symbols stay lazy exactly as under MAIN_MODULE=1. A -u
sweep is wrong here: it promotes weak refs to strong, recreating the
boot-time failure it tries to fix. invoke_* trampolines are
runtime-synthesized — excluded like link.py does.

Write-if-changed: link.rsp is a declared input of the `py:fork` turbo task
and a COPY into the fork build's `build` stage (both content-keyed), so an
identical regeneration must leave bytes AND mtime alone — the fork stays a
cache hit and nothing downstream re-derives.
"""

import json
import shutil
import sys

from .paths import CACHE_DIR, GROUPS_DIR, PKG_ROOT
from .wasmmeta import parse_wasm

SOS_DIR = CACHE_DIR / "link-sos"
RSP = SOS_DIR / "link.rsp"


def run(args) -> int:
    groups = json.loads((PKG_ROOT / "config/dso-groups/groups.json").read_text())
    need: set[str] = set()
    so_count = 0
    for bundle in sorted(groups["bundles"]):
        so_path = GROUPS_DIR / f"{bundle}.so"
        if not so_path.exists():
            sys.exit(
                f"link-rsp: dist/groups/{bundle}.so missing — run the recipes loop "
                "(pnpm --filter @avlo/py-build recipes:build) first"
            )
        so_count += 1
        parsed = parse_wasm(so_path.read_bytes())
        for _mod, field, _kind in parsed.imports:  # func/global/tag kinds only, by construction
            if not field.startswith("invoke_"):
                need.add(field)
    content = "".join(f"-Wl,--export-if-defined={s}\n" for s in sorted(need)).encode()

    if RSP.exists() and RSP.read_bytes() == content and [p.name for p in SOS_DIR.iterdir()] == ["link.rsp"]:
        print(f"link-rsp: unchanged ({so_count} grouped DSOs, {len(need)} imported symbols) — mtime preserved")
        return 0
    shutil.rmtree(SOS_DIR, ignore_errors=True)
    SOS_DIR.mkdir(parents=True)
    RSP.write_bytes(content)
    print(f"link-rsp: {so_count} grouped DSOs, {len(need)} imported symbols -> link.rsp (export-if-defined)")
    return 0
