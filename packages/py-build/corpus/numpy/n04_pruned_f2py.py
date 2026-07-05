# trace: skip — deliberately imports PRUNED modules; running it under the
# tracer (unpruned trees) would poison the trace ∩ prune = ∅ gate.
# self-asserting: the per-bundle tombstone registry (_avlo_pruned_numpy)
for name in ("numpy.f2py", "numpy._pyinstaller"):
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert "not available in AVLO" in str(e), e
    else:
        raise AssertionError(f"{name} should be tombstoned")
print("n04 ok")
