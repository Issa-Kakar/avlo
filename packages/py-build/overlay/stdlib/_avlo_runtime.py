"""AVLO runtime fixups — the Python side of the snapshot restore contract.

The JS executor calls post_restore() immediately after every snapshot restore
AND after every in-place blit reset. Keep this module import-light: it must
not drag anything into the baseline snapshot that isn't already there.
"""

import sys


def post_restore() -> None:
    """Reseed entropy consumers + drop caches that alias pre-snapshot state."""
    import importlib

    importlib.invalidate_caches()

    import linecache

    linecache.clearcache()

    # random: reseed from the (JS-backed) OS entropy source. Only if the
    # snapshot happened to import it — the baseline warmup deliberately
    # excludes it.
    random = sys.modules.get("random")
    if random is not None:
        random.seed()

    # numpy: reseed the legacy global RNG and refresh the default_rng path.
    numpy = sys.modules.get("numpy")
    if numpy is not None:
        import os

        seed = int.from_bytes(os.urandom(4), "little")
        numpy.random.seed(seed)

    ensure_tzpath()


def ensure_tzpath() -> None:
    """Point stdlib zoneinfo at pytz's TZif tree when pytz is mounted."""
    zoneinfo = sys.modules.get("zoneinfo")
    if zoneinfo is None:
        return
    try:
        import pytz  # noqa: F401 — presence check only
    except ImportError:
        return
    import os

    tz_root = os.path.join(os.path.dirname(pytz.__file__), "zoneinfo")
    if tz_root not in zoneinfo.TZPATH:
        zoneinfo.reset_tzpath([tz_root, *zoneinfo.TZPATH])
