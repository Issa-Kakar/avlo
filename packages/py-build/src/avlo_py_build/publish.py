"""Publish the staged py artifacts to R2 under their build-lock hash prefix.

  avlo-build publish [--local|--remote] [--dry-run]   (--local default)

Local seeds the dev miniflare R2 simulator (pnpm py:seed); remote publishes
to the real avlo-py bucket. Invariant enforced by the preflight: RESTAGE ⇒
RESEED — every uploaded byte is re-hashed against the committed build-lock,
so a stale dist/ or a stale lock refuses loudly instead of serving a mix.

Upload plan: every lock artifact + bundle tar, each with its .br sibling,
then manifest.json strictly LAST — an aborted upload leaves an incomplete
prefix WITHOUT its completion marker, which the probe treats as unpublished.

Transport is still `wrangler r2 object put` (no checksum flag — the
binding-put upgrade with server-side sha256 verify is researched in NOTES
Open items and lands with the publish/serving phase, likely as boto3 to the
S3 endpoint per the replatform plan §2.8).
"""

import hashlib
import json
import subprocess
import sys

from .paths import BUILD_LOCK, FORK_PUBLIC, PKG_ROOT, REPO_ROOT

BUCKET = "avlo-py"

# Raw source locations (the .br siblings live beside them — they never reach fork/).
SOURCES = {
    "pyodide.asm.mjs": "dist/raw/pyodide.asm.mjs",
    "pyodide.asm.wasm": "dist/raw/pyodide.asm.wasm",
    "pyodide.mjs": "dist/raw/pyodide.mjs",
    "python_stdlib.zip": "dist/stage/python_stdlib.zip",
}
# NOTE: no fallback — an unmapped extension must fail loudly, not upload a
# bogus content type.
MIME = {
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".zip": "application/zip",
    ".json": "application/json",
    ".tar": "application/x-tar",
}


def _content_type(file: str) -> str:
    return MIME[file[file.rfind(".") :]]


def run(args) -> int:
    remote = args.remote
    dry_run = args.dry_run
    lock = json.loads(BUILD_LOCK.read_text())

    # ---- preflight: restage ⇒ reseed -----------------------------------------
    uploads: list[dict] = []  # { key, path, contentType, encoding? }

    def preflight(name: str, rel: str, want: dict) -> None:
        p = PKG_ROOT / rel
        if not p.exists():
            sys.exit(f"missing {rel} — build/stage first")
        buf = p.read_bytes()
        if len(buf) != want["size"] or hashlib.sha256(buf).hexdigest() != want["sha256"]:
            sys.exit(f"{rel} drifted from build-lock (restage ⇒ reseed: rerun avlo-build stage, commit the lock, reseed)")
        br_path = p.with_name(p.name + ".br")
        if not br_path.exists():
            sys.exit(f"missing {rel}.br — run avlo-build compress")
        if br_path.stat().st_mtime < p.stat().st_mtime:
            sys.exit(f"{rel}.br is OLDER than its source — run avlo-build compress")
        key_base = f"{lock['buildHash']}/bundles/{name}" if name.endswith(".tar") else f"{lock['buildHash']}/{name}"
        uploads.append({"key": key_base, "path": p, "contentType": _content_type(name)})
        uploads.append({"key": f"{key_base}.br", "path": br_path, "contentType": _content_type(name), "encoding": "br"})

    for name, rel in SOURCES.items():
        preflight(name, rel, lock["artifacts"][name])
    for b, want in lock["bundles"].items():
        preflight(f"{b}.tar", f"dist/stage/bundles/{b}.tar", want)

    manifest_path = FORK_PUBLIC / "manifest.json"
    if not manifest_path.exists():
        sys.exit("staged manifest.json missing — run avlo-build stage")
    manifest_bytes = manifest_path.read_bytes()
    if json.loads(manifest_bytes)["buildHash"] != lock["buildHash"]:
        sys.exit("staged manifest.json buildHash != build-lock — rerun avlo-build stage")
    uploads.append({"key": f"{lock['buildHash']}/manifest.json", "path": manifest_path, "contentType": "application/json"})

    # ---- wrangler invocation ----------------------------------------------------
    # --local: --persist-to must be ABSOLUTE and must NOT include the trailing
    # /v3 — wrangler appends it, landing in the exact tree dev-miniflare reads
    # (.wrangler/state/v3). --remote: config supplies the account context.
    mode_args = (
        ["--remote", "--config", str(REPO_ROOT / "workers/py/wrangler.jsonc")]
        if remote
        else ["--local", "--persist-to", str(REPO_ROOT / ".wrangler/state")]
    )

    def wr(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
        return subprocess.run(["npx", "wrangler", "r2", "object", *cmd, *mode_args], cwd=REPO_ROOT, **kwargs)

    if remote and not dry_run:
        # Divergence refusal: one probe of the completion marker.
        probe = wr(
            ["get", f"{BUCKET}/{lock['buildHash']}/manifest.json", "--pipe"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
        if probe.returncode == 0:
            if probe.stdout == manifest_bytes:
                print(f"already published: {lock['buildHash']} (manifest byte-identical)")
                return 0
            sys.exit(
                f"HASH BUG: {lock['buildHash']}/manifest.json exists remotely with DIFFERENT bytes — "
                "same hash must mean same artifacts"
            )

    for u in uploads:
        flags = ["--file", str(u["path"]), "--content-type", u["contentType"]]
        if u.get("encoding"):
            flags += ["--content-encoding", u["encoding"]]
        print(f"{'[dry-run] ' if dry_run else ''}put {BUCKET}/{u['key']}{' (br)' if u.get('encoding') else ''}")
        if not dry_run:
            r = wr(["put", f"{BUCKET}/{u['key']}", *flags], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
            if r.returncode != 0:
                sys.exit(f"wrangler put failed for {u['key']}")
    print(f"{'[dry-run] ' if dry_run else ''}published {len(uploads)} keys under {lock['buildHash']} ({'remote' if remote else 'local'})")
    return 0
