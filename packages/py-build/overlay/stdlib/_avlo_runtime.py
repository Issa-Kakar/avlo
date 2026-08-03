"""AVLO runtime fixups — the Python side of the snapshot restore contract.

The JS executor calls post_restore() immediately after every snapshot restore
AND after every in-place blit reset. Keep this module import-light: it runs
inside every captured heap image, so anything it imports gets baked into
every set's snapshot.
"""

import sys


def post_restore() -> None:
    """Reseed entropy consumers + drop caches that alias pre-snapshot state."""
    import importlib

    importlib.invalidate_caches()

    import linecache

    linecache.clearcache()

    # random: reseed from the (JS-backed) OS entropy source — only if the
    # captured image happened to import it (the capture bake doesn't).
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
    """Point stdlib zoneinfo at pytz's TZif tree when the pytz bundle is
    mounted. Called after every bundle mount / restore / blit. Path-probed
    (no pytz import — this must stay cheap and import-light): the pytz
    bundle's mount point is fixed by the packer prefix. PYTHONTZPATH covers a
    FUTURE `import zoneinfo` (its TZPATH reads the env at first import);
    reset_tzpath covers an already-imported one."""
    import os

    tz_root = f"/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages/pytz/zoneinfo"
    if not os.path.isdir(tz_root):
        return
    os.environ["PYTHONTZPATH"] = tz_root
    zoneinfo = sys.modules.get("zoneinfo")
    if zoneinfo is not None and tz_root not in zoneinfo.TZPATH:
        zoneinfo.reset_tzpath([tz_root, *zoneinfo.TZPATH])
