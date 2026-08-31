"""Fetch the pinned recipes wheels into .cache/wheels/ (gitignored), verifying
every byte against the sha256 pins in build.config.json.

  avlo-build fetch-wheels [--stamp] [--only name[,name...]]

--stamp re-resolves {version, file, sha256} for every configured wheel name
from the stock release lock (dist/raw/pyodide-lock.json — the recipes release
asset, present after any fork build), preserves traceOnly flags, and rewrites
recipes.wheels. Pins are frozen until the next explicit --stamp; a version
drift between config and lock without --stamp is an error, not a silent
re-pin. Wheels pinned with a `url` (PyPI universal wheels absent from the
stock lock, e.g. seaborn) are outside --stamp's authority: they are skipped
by the restamp AND the drift guard, and their download goes straight to the
pinned url — the sha256 pin is what makes any source provenance-equivalent.

(link.rsp regeneration used to ride along here; it is its own command now —
`avlo-build link-rsp`.)
"""

import hashlib
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx

from .config import load_raw, save_raw
from .paths import RAW_DIR, WHEEL_CACHE

LOCK_PATH = RAW_DIR / "pyodide-lock.json"
_FETCH_POOL = 8
_print_lock = threading.Lock()


def _say(line: str) -> None:
    with _print_lock:
        print(line)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _lock_entry(lock: dict, name: str) -> dict | None:
    return lock["packages"].get(name) or lock["packages"].get(name.replace("-", "_"))


def run(args) -> int:
    raw_cfg = load_raw()
    recipes = raw_cfg["recipes"]
    wheels: dict[str, dict] = recipes["wheels"]
    only = set(args.only.split(",")) if args.only else None
    names = [n for n in wheels if only is None or n in only]

    client = httpx.Client(follow_redirects=True, timeout=120)

    # The stock full lock is the pin source for --stamp and the drift guard.
    # Auto-fetch from the CDN mirror when absent or from a different pyodide
    # release — dist/raw goes stale across toolchain jumps until the first
    # fork build, and the fork's own emitted lock (if any) must never clobber
    # this full one, so provenance lives here, not in build.sh's copy list.
    def lock_is_current() -> bool:
        try:
            return json.loads(LOCK_PATH.read_text()).get("info", {}).get("version") == raw_cfg["pyodide"]["tag"]
        except (OSError, ValueError):
            return False

    if not lock_is_current():
        url = f"{recipes['mirror']}/pyodide-lock.json"
        print(f"lock    fetching stock {raw_cfg['pyodide']['tag']} lock ... ", end="", flush=True)
        res = client.get(url)
        res.raise_for_status()
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOCK_PATH.write_bytes(res.content)
        print("ok")

    if args.stamp:
        lock = json.loads(LOCK_PATH.read_text())
        for name in names:
            if wheels[name].get("url"):
                print(f"skip    {name} (url-pinned, not in the stock lock)")
                continue
            e = _lock_entry(lock, name)
            if e is None:
                sys.exit(f"--stamp: {name} not in {LOCK_PATH}")
            prev = wheels[name]
            if prev.get("version") and prev["version"] != e["version"]:
                print(f"!! {name}: version pin {prev['version']} -> {e['version']} (lock)", file=sys.stderr)
            wheels[name] = {
                "version": e["version"],
                "file": e["file_name"],
                "sha256": e["sha256"],
                **({"traceOnly": True} if prev.get("traceOnly") else {}),
            }
        save_raw(raw_cfg)
        print(f"stamped {len(names)} wheel pins from the stock lock")

    # Drift guard: pins must agree with the lock we built against.
    if LOCK_PATH.exists():
        lock = json.loads(LOCK_PATH.read_text())
        for name in names:
            if wheels[name].get("url"):
                continue  # url pins are deliberately outside the lock's authority
            e = _lock_entry(lock, name)
            if e and e["sha256"] != wheels[name]["sha256"]:
                sys.exit(f"{name}: config sha256 disagrees with the stock lock — rerun with --stamp deliberately")

    WHEEL_CACHE.mkdir(parents=True, exist_ok=True)
    fetched = 0
    fetch_lock = threading.Lock()

    # Downloads fan out over a thread pool (pure network wait; per-wheel sha
    # verify is order-independent). Log lines print whole per wheel.
    def fetch_one(name: str) -> None:
        nonlocal fetched
        pin = wheels[name]
        file, want = pin.get("file"), pin.get("sha256")
        if not file or not want:
            sys.exit(f"{name}: unpinned (run --stamp first)")
        dest = WHEEL_CACHE / file
        if dest.exists() and _sha256(dest.read_bytes()) == want:
            _say(f"ok      {file}")
            return
        # Release asset first (canonical), then the CDN mirror; url pins go
        # straight to their source — the sha256 pin makes every source
        # provenance-equivalent.
        bases = [b for b in (recipes.get("base"), recipes.get("mirror")) if b]
        sources = [pin["url"]] if pin.get("url") else [f"{base}/{file}" for base in bases]
        buf = None
        last_err = None
        for source in sources:
            res = client.get(source)
            if res.status_code == 200:
                buf = res.content
                break
            last_err = f"{source}: HTTP {res.status_code}"
        if buf is None:
            sys.exit(last_err or f"{file}: no sources")
        got = _sha256(buf)
        if got != want:
            sys.exit(f"{file}: sha256 mismatch\n  want {want}\n  got  {got}")
        dest.write_bytes(buf)
        with fetch_lock:
            fetched += 1
        _say(f"fetch   {file} {len(buf) / 1e6:.1f} MB ok")

    with ThreadPoolExecutor(_FETCH_POOL) as pool:
        for _ in pool.map(fetch_one, names):
            pass
    print(f"wheels: {len(names)} pinned, {fetched} fetched, cache {WHEEL_CACHE}")
    return 0
