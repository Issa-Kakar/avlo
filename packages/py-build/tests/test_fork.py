"""avlo-build fork — the host-side half (pins → build-args, export → dist/raw
promotion). The docker build itself is exercised by `fork --repro`."""

from avlo_py_build import fork
from avlo_py_build.config import load


def test_build_args_carry_every_pin():
    cfg = load()
    args = " ".join(fork._build_args())
    assert f"BASE_IMAGE={cfg.image.ref}@{cfg.image.digest}" in args
    assert f"PYODIDE_COMMIT={cfg.pyodide.commit}" in args
    assert f"SOURCE_DATE_EPOCH={cfg.fork.sourceDateEpoch}" in args
    assert f"TARGETS={cfg.fork.targets}" in args


def test_promote_rewrites_only_changed_bytes(tmp_path, monkeypatch):
    raw, src = tmp_path / "raw", tmp_path / "src"
    raw.mkdir()
    src.mkdir()
    for name in fork.EXPORTS:
        (src / name).write_bytes(name.encode())
    (raw / "pyodide.mjs").write_bytes(b"pyodide.mjs")  # identical → untouched
    (raw / "pyodide.mjs.br").write_bytes(b"br")  # sibling of a kept file → kept
    (raw / "pyodide.asm.wasm").write_bytes(b"old")  # differs → rewritten
    (raw / "pyodide-lock.json").write_bytes(b"stray")  # not an export → pruned
    monkeypatch.setattr(fork, "RAW_DIR", raw)
    before = (raw / "pyodide.mjs").stat().st_mtime_ns

    assert fork._promote(src) == len(fork.EXPORTS) - 1
    assert (raw / "pyodide.mjs").stat().st_mtime_ns == before
    assert (raw / "pyodide.asm.wasm").read_bytes() == b"pyodide.asm.wasm"
    assert (raw / "pyodide.mjs.br").exists()
    assert not (raw / "pyodide-lock.json").exists()
    assert fork._promote(src) == 0
