# self-asserting: pruned modules raise the friendly tombstone error
# (compression.lzma: the 3.14 wrapper over the disabled _lzma;
# compression.zstd is NOT here — _zstd is static since 2026-08, see b07)
for name in ("ctypes", "bz2", "http", "compression.lzma"):
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert "not available in AVLO" in str(e), f"{name}: wrong message: {e}"
    else:
        raise AssertionError(f"{name} imported but should be tombstoned")
print("b03 ok")
