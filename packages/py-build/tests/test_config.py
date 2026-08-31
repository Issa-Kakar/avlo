"""The committed build.config.json must always validate against the model —
this is the cheap standing guard for the config-check gate."""

import sys

from avlo_py_build.config import Config, load_raw


def test_committed_config_validates():
    cfg = Config.model_validate(load_raw())
    assert cfg.py_mm == "3.14" and cfg.py_tag == "314"
    assert set(cfg.sets) == {"numpy+pandas", "numpy+matplotlib", "all"}
    # deps-first invariant spot-check: every set lists numpy first
    assert all(members[0] == "numpy" for members in cfg.sets.values())


def test_fonttools_pin_matches_installed():
    from importlib.metadata import version

    cfg = Config.model_validate(load_raw())
    assert version("fonttools") == cfg.hostTools.fonttools, (
        "packages/py-build/pyproject.toml fonttools pin must equal hostTools.fonttools (determinism boundary)"
    )


def test_host_interpreter_matches_toolchain_minor():
    cfg = Config.model_validate(load_raw())
    want = tuple(int(p) for p in cfg.toolchain.python.split(".")[:2])
    assert sys.version_info[:2] == want, "pyc magic must match the wasm interpreter"
