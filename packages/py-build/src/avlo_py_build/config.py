"""Typed schema + loader for build.config.json — THE reproducibility root:
identical config + identical patches ⇒ identical buildHash.

This model is the single documented home for every knob: the old in-file
`$comment` prose lives on as field descriptions ("where is the pyc -O level
set" → here + the values in build.config.json, full stop), and
`avlo-build config schema` emits JSON Schema for editor tooling.

Machine rewrites (fetch-wheels --stamp, budgets --update) go through
load_raw()/save_raw() so key order and the 2-space-JSON + trailing-newline
byte convention survive round-trips — the typed model is for READING, never
for serialization. Nothing stamps the image digest or any other pin at build
time any more: every value here is an explicit, reviewed edit.
"""

import json
import sys
from functools import cache

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .paths import CONFIG_PATH


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PyodideCfg(_Model):
    repo: str
    tag: str = Field(description="Upstream pyodide tag the fork build clones (docker/fork.Dockerfile applies the patch queues on top).")
    commit: str = Field(
        pattern=r"^[0-9a-f]{40}$",
        description="The tag's commit — THE pin (a tag is a mutable ref). The fork build hard-fails if the clone "
        "resolves elsewhere. `git ls-remote <repo> refs/tags/<tag>^{}` at a bump.",
    )


class ImageCfg(_Model):
    ref: str = Field(description="pyodide-env build image (tag form, matching the pyodide tag's Makefile.envs).")
    digest: str = Field(
        pattern=r"^sha256:[0-9a-f]{64}$",
        description="Image digest — `FROM ref@digest` in docker/fork.Dockerfile (passed as a build-arg by avlo-build "
        "fork). Never stamped by tooling; changing it is an explicit reviewed edit "
        "(`docker image inspect --format '{{index .RepoDigests 0}}' <ref>` after a pull).",
    )


class ToolchainCfg(_Model):
    python: str = Field(description="Full CPython version of the wasm interpreter. The pack commands hard-require the "
                        "same HOST minor (pyc magic must match) and derive the /lib/pythonXYY zip + site-packages paths from it.")
    emscripten: str
    abi: str = Field(description="Emscripten ABI tag (pyemscripten_<abi> wheel platform); stamped into bundle meta.json.")


class WheelPin(_Model):
    version: str
    file: str
    sha256: str
    url: str | None = Field(
        default=None,
        description="Hand-pinned PyPI universal wheel absent from the stock lock (e.g. seaborn): --stamp and the "
        "drift guard skip it, downloads go straight to this url (the sha256 pin keeps provenance equivalent).",
    )
    depends: list[str] | None = Field(
        default=None,
        description="Direct deps for url-pinned wheels — feeds bundle_requires in place of the stock lock's depends graph.",
    )
    traceOnly: bool = Field(
        default=False,
        description="Downloaded for the import tracer's unpruned trees but NEVER shipped (pillow, fonttools — the "
        "pillow-ectomy leaves residual import sites the tracer must be able to catch).",
    )


class RecipesCfg(_Model):
    release: str
    repo: str
    commit: str = Field(description="Commit of the release tag; run-recipes.mjs clones at this and hard-fails on drift.")
    pyodideBuildCommit: str = Field(description="The release's vendored pyodide-build submodule commit.")
    base: str = Field(description="Release asset base URL (canonical wheel source).")
    mirror: str = Field(
        description="Pyodide CDN mirror serving the same wheels individually (the release ships one packages.tar.gz); "
        "sha256 pins make the mirror provenance-equivalent, and it is the only source exercised when the release tag lags."
    )
    wheels: dict[str, WheelPin] = Field(
        description="Pinned from the stock release lock (.cache/pyodide-lock.json, auto-fetched from the mirror when "
        "absent/stale) via avlo-build fetch-wheels --stamp. Pins are frozen until the next explicit --stamp; version "
        "drift between config and lock without --stamp is an error, not a silent re-pin. sqlite3 is STATIC in the 314 "
        "main module — no wheel, no bundle, no set."
    )


class XbuildenvCfg(_Model):
    version: str
    url: str
    sha256: str = Field(
        description="The pyodide-build CLI does NOT sha-verify its download — recipes-build.sh pre-downloads, "
        "byte-verifies against this pin, pre-extracts, and lets `pyodide xbuildenv install` skip its own fetch."
    )


class HostToolsCfg(_Model):
    fonttools: str = Field(
        description="Host fontTools pin driving the DejaVu subset (matches the 314 stock lock's fonttools). The "
        "avlo-py-build package MUST depend on exactly this version — config check asserts the installed version; "
        "pack-bundles asserts it again at subset time. The pin (not the installer) fixes the subset bytes."
    )


class FontsCfg(_Model):
    faces: list[str] = Field(description="Text faces, subset to `unicodes` via the pinned fontTools "
                             "(--no-recalc-timestamp --no-recalc-bounds keep bytes stable).")
    keepUnsubset: list[str] = Field(
        description="Ship whole: mathtext's dejavusans fontset probes every one of these fallback families (sized "
        "delimiters, \\mathcal, cm set) — missing families spam findfont warnings into user output — and their glyph "
        "lookups (STIXNonUni rides the PUA) are fragile under subsetting."
    )
    unicodes: str


class ForkJobsCfg(_Model):
    make: int | None = Field(
        default=None,
        description="Override for the fork build's make -j width (PYODIDE_JOBS). Omitted ⇒ derived in-container as "
        "min(nproc, RAM/1.5GB) by docker/jobs.sh. Never touches the output bytes.",
    )
    emcc: int | None = Field(default=None, description="Override for EMCC_CORES (emscripten's own parallelism). Omitted ⇒ nproc.")


class ForkCfg(_Model):
    targets: str = Field(
        description="Fork-build make targets (dist/pyodide.js builds both loaders; pyodide.d.ts rides along for "
        "app-side LSP types — staged as web/src/core/py/pyodide-fork.gen.d.ts, types only, never hashed into buildHash)."
    )
    sourceDateEpoch: int = Field(
        description="SOURCE_DATE_EPOCH for the whole build: clang's __DATE__/__TIME__ (CPython's getbuildinfo.c — the "
        "only wall-clock input to the wasm; its time string sits in the tail-merged .rodata string table, so a "
        "different value shifts every address sorted after it), the patch commits' dates. Any value is fine; it is "
        "a PIN, and changing it rotates buildHash exactly like a source edit. The current value reproduces the "
        "shipped 7fdf68788eb8a2a4 bytes (Aug  3 2026 05:27:00 UTC). Bump deliberately with each rotation."
    )
    jobs: ForkJobsCfg = Field(default_factory=ForkJobsCfg, description="Per-box parallelism overrides (config as override only).")


class StdlibZipCfg(_Model):
    codec: str = Field(description="'deflate' or 'stored'. The zip is MEMFS-resident for the runtime's whole life — "
                       "deflate(9) is 7.2MB→~2.8MB RAM while zipimport's per-module inflate is microseconds and almost "
                       "every import is baked into a snapshot anyway. The RO-FS phase flips this to 'stored' as a "
                       "config edit, not a code hunt.")
    level: int


class PackCfg(_Model):
    stdlibPycOptimize: int = Field(
        default=2, description="pyc -O level for the stdlib zip (-O2: stdlib docstrings are never user-visible)."
    )
    bundlePycOptimize: int = Field(
        default=1,
        description="pyc -O level for package bundles (-O1 only: pandas/mpl compose __doc__ at runtime, -OO breaks them).",
    )
    stdlibZip: StdlibZipCfg = Field(default_factory=lambda: StdlibZipCfg(codec="deflate", level=9))
    brotliQuality: int = Field(default=11, description="Brotli quality for the .br siblings R2 stores.")
    budgetHeadroom: float = Field(
        default=1.05, description="budgets --update stamps ceiling = measured × this; a human commits the diff."
    )


class ArtifactBudget(_Model):
    raw: int
    br: int


class CompositeBudget(_Model):
    files: list[str]
    br: int


class BudgetsCfg(_Model):
    artifacts: dict[str, ArtifactBudget] = Field(
        description="Per-artifact byte ceilings (name → {raw, br}), stamped by avlo-build budgets --update "
        "(pack.budgetHeadroom over measurement, human-committed); plain runs hard-fail over any ceiling."
    )
    composites: dict[str, CompositeBudget] = Field(
        description="Wire-download sums of .br sizes (cold-path cost ceilings); hand-set, never restamped."
    )


class Config(_Model):
    """Every pin for the AVLO Python toolchain. Set order in `sets` is
    deps-first and IS the canonical cross-bundle DSO load order."""

    pyodide: PyodideCfg
    image: ImageCfg
    fork: ForkCfg = Field(description="The fork build (docker/fork.Dockerfile via avlo-build fork): targets, SOURCE_DATE_EPOCH pin, job overrides.")
    toolchain: ToolchainCfg
    recipes: RecipesCfg
    xbuildenv: XbuildenvCfg
    hostTools: HostToolsCfg
    fonts: FontsCfg
    bundles: dict[str, list[str]] = Field(
        description="Bundle → member wheels (D1). DSO-bearing bundles ship one grouped .avlo/<bundle>.so "
        "(config/dso-groups/groups.json census); pure-Python bundles take the unchanged path."
    )
    sets: dict[str, list[str]] = Field(
        description="Set key → member bundles, deps-first = the canonical cross-bundle DSO load order snapshot "
        "replay depends on ('stdlib' is the implicit zero-bundle set)."
    )
    pack: PackCfg = Field(default_factory=PackCfg, description="Pack policy knobs (pyc -O levels, zip codec, brotli, headroom).")
    budgets: BudgetsCfg

    @model_validator(mode="after")
    def _cross_refs(self) -> "Config":
        for b, members in self.bundles.items():
            for w in members:
                if w not in self.recipes.wheels:
                    raise ValueError(f"bundles.{b}: unknown wheel {w!r}")
        for s, members in self.sets.items():
            for b in members:
                if b not in self.bundles:
                    raise ValueError(f"sets.{s}: unknown bundle {b!r}")
        for name in (*self.recipes.wheels, *self.bundles, *self.sets):
            if name.startswith("$"):
                raise ValueError(f"stray comment-shaped key {name!r} — prose belongs in config.py descriptions")
        return self

    # -- derived --------------------------------------------------------------
    @property
    def py_mm(self) -> str:
        """'3.14.2' → '3.14' (site-packages / zip mount paths; NEVER hardcode)."""
        return ".".join(self.toolchain.python.split(".")[:2])

    @property
    def py_tag(self) -> str:
        """'3.14.2' → '314' (the zip mounts at /lib/python314.zip in MEMFS)."""
        return "".join(self.toolchain.python.split(".")[:2])

    def shipped_wheels(self) -> dict[str, WheelPin]:
        return {k: v for k, v in self.recipes.wheels.items() if not v.traceOnly}

    def require_host_minor(self) -> None:
        want = tuple(int(p) for p in self.toolchain.python.split(".")[:2])
        if sys.version_info[:2] != want:
            sys.exit(
                f"need CPython {want[0]}.{want[1]} (pyc magic must match the wasm interpreter), got {sys.version}"
            )

    def require_fonttools_pin(self) -> None:
        from importlib.metadata import version

        got = version("fonttools")
        if got != self.hostTools.fonttools:
            sys.exit(
                f"installed fontTools {got} != hostTools.fonttools pin {self.hostTools.fonttools} — "
                "update packages/py-build/pyproject.toml to the exact pin and `uv lock` (determinism boundary)"
            )


def load_raw() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def save_raw(raw: dict) -> None:
    """The one config byte-convention: JSON, 2-space indent, trailing newline
    (what JSON.stringify(cfg, null, 2)+'\\n' wrote historically)."""
    CONFIG_PATH.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n")


@cache
def load() -> Config:
    return Config.model_validate(load_raw())


def run_check(args) -> int:
    cfg = Config.model_validate(load_raw())
    cfg.require_fonttools_pin()
    want = tuple(int(p) for p in cfg.toolchain.python.split(".")[:2])
    host_ok = sys.version_info[:2] == want
    print(f"config OK: {len(cfg.recipes.wheels)} wheel pins, {len(cfg.bundles)} bundles, {len(cfg.sets)} sets")
    print(f"fontTools {cfg.hostTools.fonttools} pinned == installed")
    print(f"host CPython {'.'.join(map(str, sys.version_info[:3]))} {'matches' if host_ok else 'DOES NOT MATCH'} toolchain minor {cfg.py_mm}")
    return 0 if host_ok else 1


def run_schema(args) -> int:
    print(json.dumps(Config.model_json_schema(), indent=2))
    return 0
