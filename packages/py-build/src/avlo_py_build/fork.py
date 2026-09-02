"""avlo-build fork — the forked-Pyodide build, driven off docker/fork.Dockerfile.

  avlo-build fork                    # build → export → promote into dist/raw (per-file change report)
  avlo-build fork --dest DIR         # export to DIR instead; dist/raw untouched (A/B comparisons)
  avlo-build fork --repro            # two cold builds (ccache off, compile lanes uncached), byte-compare;
                                     # dist/raw untouched — the determinism proof, on demand
  avlo-build fork --no-cache         # ignore the BuildKit layer cache entirely
  avlo-build fork --dev [--reset] [-- CMD …]
                                     # incremental-make escape hatch: a persistent docker volume seeded
                                     # from the `build` stage (patched tree + built emsdk/cpython), host
                                     # uid, /pb mounted read-only, /out = dist/dev-raw. Non-canonical by
                                     # construction: nothing under dist/dev-raw can be staged.

Every pin (image ref@digest, repo/tag/commit, SOURCE_DATE_EPOCH, make targets,
job overrides) is read from build.config.json and passed as build-args — the
Dockerfile carries no defaults, so it cannot silently drift from the config.
Canonical bytes come from the Dockerfile path ONLY; the layer cache is
machine-global (the `default` docker-driver builder shares the daemon's image
store, so the pulled pyodide-env image and every cached lane serve all
worktrees), and ccache rides a BuildKit cache mount across builds.
"""

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import load
from .paths import PKG_ROOT, RAW_DIR

DOCKERFILE = PKG_ROOT / "docker/fork.Dockerfile"
DEV_RAW = PKG_ROOT / "dist/dev-raw"
DEV_IMAGE = "avlo-py-fork:build"
DEV_VOLUME = "avlo-py-fork-dev"
# The docker-driver builder: uses the daemon's image store (no second 4 GB
# pull of the env image) and its build cache lives in /var/lib/docker.
BUILDER = "default"
# Mirrors the Dockerfile's `dist` stage COPY list; _export asserts each landed.
EXPORTS = ("pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide.mjs", "python_stdlib.zip", "pyodide.d.ts", "builtin-modules.json")


def _require_docker() -> None:
    if shutil.which("docker") is None:
        sys.exit("fork: docker CLI not found")
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        sys.exit("fork: the docker daemon is not reachable — start it (e.g. `sudo systemctl start docker`) and retry")


def _build_args() -> list[str]:
    cfg = load()
    args = {
        "BASE_IMAGE": f"{cfg.image.ref}@{cfg.image.digest}",
        "PYODIDE_REPO": cfg.pyodide.repo,
        "PYODIDE_TAG": cfg.pyodide.tag,
        "PYODIDE_COMMIT": cfg.pyodide.commit,
        "SOURCE_DATE_EPOCH": str(cfg.fork.sourceDateEpoch),
        "TARGETS": cfg.fork.targets,
    }
    if cfg.fork.jobs.make:
        args["JOBS_MAKE"] = str(cfg.fork.jobs.make)
    if cfg.fork.jobs.emcc:
        args["JOBS_EMCC"] = str(cfg.fork.jobs.emcc)
    out: list[str] = []
    for k, v in args.items():
        out += ["--build-arg", f"{k}={v}"]
    return out


def _buildx(target: str, *extra: str, no_cache: bool = False) -> None:
    cmd = [
        "docker", "buildx", "build", "--builder", BUILDER,
        "-f", str(DOCKERFILE), "--target", target,
        "--progress", "auto" if sys.stdout.isatty() else "plain",
        *_build_args(), *(["--no-cache"] if no_cache else []), *extra, str(PKG_ROOT),
    ]
    print("=== " + shlex.join(cmd[:8]) + " …", flush=True)
    if subprocess.run(cmd, cwd=PKG_ROOT).returncode != 0:
        sys.exit(f"fork: docker build failed (target {target})")


def _export(dest: Path, *extra: str, no_cache: bool = False) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    _buildx("dist", "--output", f"type=local,dest={dest}", *extra, no_cache=no_cache)
    missing = [n for n in EXPORTS if not (dest / n).is_file()]
    if missing:
        sys.exit(f"fork: export is missing {missing}")


def _promote(src: Path) -> int:
    """Replace dist/raw with the export: rewrite only files whose bytes changed
    (identical files keep their mtime, so compress's up-to-date check stays
    valid), drop strays, keep .br siblings of kept files (compress refreshes
    them by mtime). A changed file lands via temp + rename: atomic, and a
    FRESH inode — dist/raw files get hardlinked into test views, and a
    promotion must never write through someone else's link."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    changed = 0
    for name in EXPORTS:
        new = (src / name).read_bytes()
        dst = RAW_DIR / name
        if dst.exists() and dst.read_bytes() == new:
            print(f"unchanged {name}")
            continue
        tag = "CHANGED" if dst.exists() else "new"
        tmp = dst.with_name(dst.name + ".tmp")
        tmp.write_bytes(new)
        shutil.copymode(src / name, tmp)
        os.replace(tmp, dst)
        changed += 1
        print(f"{tag:9s} {name}")
    keep = set(EXPORTS) | {f"{n}.br" for n in EXPORTS}
    for p in sorted(RAW_DIR.iterdir()):
        if p.is_file() and p.name not in keep:
            p.unlink()
            print(f"pruned stray {p.name}")
    print(f"fork: dist/raw promoted ({changed} file(s) changed)" if changed else "fork: dist/raw unchanged")
    return changed


def _compare(a: Path, b: Path) -> list[str]:
    return [n for n in EXPORTS if (a / n).read_bytes() != (b / n).read_bytes()]


def _repro() -> int:
    with tempfile.TemporaryDirectory(prefix="fork-repro-", dir=PKG_ROOT / ".cache") as td:
        a, b = Path(td) / "a", Path(td) / "b"
        print("=== repro A: canonical build (layer cache + ccache as usual)")
        _export(a)
        print("=== repro B: cold compile lanes, ccache disabled")
        _export(b, "--no-cache-filter", "cpython,build", "--build-arg", "CCACHE=0")
        diff = _compare(a, b)
    if diff:
        print(f"fork --repro: NOT byte-identical: {diff}", file=sys.stderr)
        return 1
    print("fork --repro: byte-identical across two cold builds ✓")
    return 0


def _dev(args) -> int:
    uid, gid = os.getuid(), os.getgid()
    _buildx("build", "-t", DEV_IMAGE)
    vols = subprocess.run(["docker", "volume", "ls", "-q"], capture_output=True, text=True, check=True).stdout.split()
    if args.reset and DEV_VOLUME in vols:
        subprocess.run(["docker", "volume", "rm", "-f", DEV_VOLUME], check=True)
        vols.remove(DEV_VOLUME)
    if DEV_VOLUME not in vols:
        # Docker seeds a NEW named volume from the image's /src on first mount;
        # chown it once so the session runs as the host user.
        print(f"=== seeding volume {DEV_VOLUME} from {DEV_IMAGE} (one-time copy of the built tree)")
        subprocess.run(
            ["docker", "run", "--rm", "-v", f"{DEV_VOLUME}:/src", DEV_IMAGE, "chown", "-R", f"{uid}:{gid}", "/src"],
            check=True,
        )
    DEV_RAW.mkdir(parents=True, exist_ok=True)
    cmd = [
        "docker", "run", "--rm", *(["-it"] if sys.stdin.isatty() else []),
        "--user", f"{uid}:{gid}", "-e", "HOME=/src",
        "-v", f"{DEV_VOLUME}:/src", "-v", f"{PKG_ROOT}:/pb:ro", "-v", f"{DEV_RAW}:/out",
        "-w", "/src", DEV_IMAGE, "bash",
    ]
    if args.cmd:
        cmd += ["-c", shlex.join(args.cmd)]
    else:
        print(
            "dev shell: `source pyodide_env.sh` for the toolchain; `make -j4 <targets>` is incremental here; "
            "copy results to /out (= dist/dev-raw). Non-canonical: stage/publish read dist/raw only."
        )
    return subprocess.run(cmd).returncode


def run(args) -> int:
    _require_docker()
    if args.dev:
        return _dev(args)
    if args.repro:
        return _repro()
    if args.dest:
        _export(Path(args.dest).resolve(), no_cache=args.no_cache)
        print(f"fork: exported to {args.dest} (dist/raw untouched)")
        return 0
    with tempfile.TemporaryDirectory(prefix="fork-out-", dir=PKG_ROOT / ".cache") as td:
        _export(Path(td), no_cache=args.no_cache)
        _promote(Path(td))
    return 0
