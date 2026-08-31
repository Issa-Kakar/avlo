# Corpus group 'numpy' — the numpy+pandas set, DSOs loaded by NATURAL import
# through the sitecustomize group finder (zero JS in the mount path).
import corpus_lib as C
import pytest

GROUP = "numpy"


@pytest.mark.parametrize("sample", C.samples_for(GROUP), ids=lambda p: p.name)
def test_sample(group_runtime, sample):
    C.run_sample(group_runtime, sample)
