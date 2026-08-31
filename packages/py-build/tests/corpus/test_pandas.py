# Corpus group 'pandas' — the numpy+pandas set (tz bridge up post-mount).
import corpus_lib as C
import pytest

GROUP = "pandas"


@pytest.mark.parametrize("sample", C.samples_for(GROUP), ids=lambda p: p.name)
def test_sample(group_runtime, sample):
    C.run_sample(group_runtime, sample)
