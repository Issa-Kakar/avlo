# Corpus group 'mpl' — the numpy+matplotlib set. The gate tests run AFTER the
# samples (definition order) over the same module-scoped runtime.
import corpus_lib as C
import pytest

GROUP = "mpl"


@pytest.mark.parametrize("sample", C.samples_for(GROUP), ids=lambda p: p.name)
def test_sample(group_runtime, sample):
    C.run_sample(group_runtime, sample)


def test_font_gate(group_runtime):
    C.assert_font_gate(group_runtime)


def test_figure_pixels(group_runtime):
    C.assert_figure_pixels(group_runtime)
