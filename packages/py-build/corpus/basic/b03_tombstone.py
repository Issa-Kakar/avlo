# self-asserting: pruned modules raise the friendly tombstone error
for name in ("ctypes", "bz2", "http"):
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert "not available in AVLO" in str(e), f"{name}: wrong message: {e}"
    else:
        raise AssertionError(f"{name} imported but should be tombstoned")
print("b03 ok")
