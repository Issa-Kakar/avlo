# self-asserting: pruned modules raise the friendly tombstone error
# (compression.zstd: the 3.14 wrapper over the disabled _zstd)
for name in ("ctypes", "bz2", "http", "compression.zstd"):
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert "not available in AVLO" in str(e), f"{name}: wrong message: {e}"
    else:
        raise AssertionError(f"{name} imported but should be tombstoned")
print("b03 ok")
