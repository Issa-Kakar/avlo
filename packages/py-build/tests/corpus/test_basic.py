# Corpus group 'basic' — bare staged stdlib, no bundle mounts. Samples are
# DATA (corpus/basic/*.py, self-asserting); plumbing in corpus_lib.py.
import corpus_lib as C
import pytest

GROUP = "basic"


@pytest.mark.parametrize("sample", C.samples_for(GROUP), ids=lambda p: p.name)
def test_sample(group_runtime, sample):
    C.run_sample(group_runtime, sample)
