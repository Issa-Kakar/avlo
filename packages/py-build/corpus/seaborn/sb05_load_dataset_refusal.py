# trace: skip — deliberately drives the pruned http stack (tombstone probe);
# on the tracer's unpruned stdlib this would LOAD http and violate G3.
# self-asserting: the network entry point fails with the precise tombstone
# (patch 0001 made urllib lazy, so `import seaborn` itself stays alive).
import seaborn as sns

try:
    sns.load_dataset("penguins")
    raise AssertionError("load_dataset should not succeed without a network")
except ModuleNotFoundError as e:
    assert "http" in str(e) and "not available" in str(e), str(e)
print("sb05 ok")
