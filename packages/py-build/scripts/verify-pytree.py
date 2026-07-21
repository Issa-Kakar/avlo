#!/usr/bin/env python3
"""Provenance gate for the recipe rebuilds: rebuilt-wheel `.py` trees must be
byte-identical to the pinned upstream wheels' — same sdist + same recipes +
same toolchain ⇒ equal; a non-allowlisted mismatch is a PIN BUG, never
something to allowlist away. Rebuilt `.py` never ships either way (upstream
wheels remain the .py source; the rebuild contributes only grouped .so's) —
this gate is what makes that split sound.

  python3 scripts/verify-pytree.py            # all DSO-bearing packages
  python3 scripts/verify-pytree.py kiwisolver # subset (spike)

Compares every *.py member (``*.dist-info/**`` excluded) of the upstream
wheel (.cache/wheels/<pin>, sha-verified) against the rebuilt wheel
(dist/groups/wheels/). Tolerated WITHOUT allowlisting: rebuilt-only files
matching pyodide-build's unvendor patterns (dirs named test/tests, files
test_*.py / *_test.py / conftest.py) — upstream release wheels are shipped
test-unvendored while our no-deps loop skips install-time unvendoring.
Everything else needs a `pkg:path` line in config/pkg-equality-allow.txt
under a `# reason:` comment (expected residents: meson-generated version
stamps like numpy/__config__.py).
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "build.config.json").read_text())
GROUPS = json.loads((ROOT / "config/dso-groups/groups.json").read_text())
WHEEL_CACHE = ROOT / ".cache/wheels"
REBUILT_DIR = ROOT / "dist/groups/wheels"
ALLOW_PATH = ROOT / "config/pkg-equality-allow.txt"


def load_allowlist() -> dict[str, str]:
    """'pkg:path' -> reason (nearest preceding '# reason:')."""
    allow: dict[str, str] = {}
    if not ALLOW_PATH.exists():
        return allow
    reason = "(no reason recorded)"
    for line in ALLOW_PATH.read_text().splitlines():
        line = line.strip()
        if line.startswith("# reason:"):
            reason = line.removeprefix("# reason:").strip()
        elif line and not line.startswith("#"):
            allow[line] = reason
    return allow


def is_test_path(rel: str) -> bool:
    parts = rel.split("/")
    if any(p in ("test", "tests") for p in parts[:-1]):
        return True
    base = parts[-1]
    return base.startswith("test_") and base.endswith(".py") or base.endswith("_test.py") or base == "conftest.py"


def py_members(wheel: Path) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    with zipfile.ZipFile(wheel) as z:
        for name in z.namelist():
            if not name.endswith(".py"):
                continue
            if any(part.endswith(".dist-info") for part in name.split("/")):
                continue
            out[name] = z.read(name)
    return out


def rebuilt_wheel(pkg: str) -> Path:
    cands = sorted(REBUILT_DIR.glob(f"{pkg}-*.whl"))
    if len(cands) != 1:
        sys.exit(f"verify-pytree: FAIL — expected exactly 1 rebuilt wheel for {pkg}, found {[c.name for c in cands]}")
    return cands[0]


def main() -> None:
    only = set(sys.argv[1:]) or None
    pkgs = sorted({p for g in GROUPS["bundles"].values() for p in g["packages"]})
    if only:
        pkgs = [p for p in pkgs if p in only]
    allow = load_allowlist()
    used_allow: set[str] = set()
    violations: list[str] = []

    for pkg in pkgs:
        pin = CONFIG["recipes"]["wheels"][pkg]
        upstream_path = WHEEL_CACHE / pin["file"]
        if not upstream_path.exists():
            sys.exit(f"verify-pytree: FAIL — {upstream_path} missing (run fetch-wheels first)")
        if hashlib.sha256(upstream_path.read_bytes()).hexdigest() != pin["sha256"]:
            sys.exit(f"verify-pytree: FAIL — {pin['file']} sha mismatch vs config pin")
        upstream = py_members(upstream_path)
        rebuilt = py_members(rebuilt_wheel(pkg))

        same = 0
        for rel, want in upstream.items():
            key = f"{pkg}:{rel}"
            got = rebuilt.get(rel)
            if got is None:
                if key in allow:
                    used_allow.add(key)
                else:
                    violations.append(f"{pkg}: {rel} missing from rebuilt wheel")
            elif got != want:
                if key in allow:
                    used_allow.add(key)
                else:
                    violations.append(f"{pkg}: {rel} differs ({len(want)} -> {len(got)} bytes)")
            else:
                same += 1
        extra_tolerated = 0
        for rel in rebuilt:
            if rel in upstream:
                continue
            key = f"{pkg}:{rel}"
            if is_test_path(rel):
                extra_tolerated += 1
            elif key in allow:
                used_allow.add(key)
            else:
                violations.append(f"{pkg}: rebuilt-only non-test file {rel}")
        print(f"{pkg}: {same}/{len(upstream)} .py byte-identical, {extra_tolerated} rebuilt-only test files tolerated")

    for key in allow:
        if key not in used_allow and (only is None or key.split(":", 1)[0] in only):
            violations.append(f"allowlist entry unused (stale?): {key}")
    if violations:
        print(f"\nverify-pytree FAILURES ({len(violations)}):", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        sys.exit(1)
    print("verify-pytree OK")


if __name__ == "__main__":
    main()
