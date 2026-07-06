# trace: skip — seaborn.objects is pruned (its _core/plot.py imports PIL at
# top level; pillow never ships), so on the unpruned tracer tree this would
# record a PIL attempt and violate the G3 ban.
# self-asserting: the prune surfaces as a precise tombstone, not a PIL error.
try:
    import seaborn.objects  # noqa: F401

    raise AssertionError("seaborn.objects should be pruned")
except ModuleNotFoundError as e:
    assert "seaborn.objects" in str(e) and "not available" in str(e), str(e)
print("sb06 ok")
