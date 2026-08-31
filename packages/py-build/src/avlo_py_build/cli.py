"""avlo-build — one CLI, one command per pipeline stage.

Every subcommand is a thin argparse entry over a module in this package;
handlers import lazily so `avlo-build <cmd> --help` stays instant. The whole
process re-execs under PYTHONHASHSEED=0 before dispatch (marshalled sets in
pyc bodies iterate in hash order — uniform determinism posture beats
per-command judgment calls).

Docker lanes (fork build, recipes loop) are NOT here yet — they remain
scripts/run-build.mjs + scripts/run-recipes.mjs until their replatform
phases; `trace record` shells out to scripts/node/trace-record.mjs the same
way (fork boots stay Node by language policy).
"""

import argparse
import os
import sys
from importlib import import_module


def _handler(module: str, fn: str = "run"):
    def call(args):
        return getattr(import_module(f"avlo_py_build.{module}"), fn)(args)

    return call


def main(argv: list[str] | None = None) -> None:
    if os.environ.get("PYTHONHASHSEED") != "0":
        from .packlib import ensure_hashseed

        ensure_hashseed()

    p = argparse.ArgumentParser(prog="avlo-build", description=__doc__.split("\n", 1)[0])
    sub = p.add_subparsers(metavar="command", required=True)

    sp = sub.add_parser("config", help="validate build.config.json / emit its JSON Schema")
    csub = sp.add_subparsers(metavar="action", required=True)
    csub.add_parser("check", help="pydantic validation + fontTools-pin + host-interpreter cross-checks").set_defaults(
        run=_handler("config", "run_check")
    )
    csub.add_parser("schema", help="print JSON Schema (for editor tooling)").set_defaults(run=_handler("config", "run_schema"))

    sp = sub.add_parser("fetch-wheels", help="download + sha-verify the pinned recipes wheels into .cache/wheels/")
    sp.add_argument("--stamp", action="store_true", help="re-pin {version,file,sha256} from the stock release lock")
    sp.add_argument("--only", metavar="a,b", help="narrow to these wheel names")
    sp.set_defaults(run=_handler("fetch_wheels"))

    sp = sub.add_parser("link-rsp", help="regenerate .cache/link-sos/link.rsp from the grouped DSOs' import unions")
    sp.set_defaults(run=_handler("link_rsp"))

    sp = sub.add_parser("pack-stdlib", help="pruned, pyc-only stdlib zip → dist/stage/python_stdlib.zip")
    sp.add_argument("--repro", action="store_true", help="build twice, byte-compare (G0)")
    sp.set_defaults(run=_handler("pack_stdlib"))

    sp = sub.add_parser("pack-bundles", help="deterministic package-bundle tars → dist/stage/bundles/")
    sp.add_argument("bundles", nargs="*", help="bundle names (or wheel names with --unpruned)")
    sp.add_argument("--all", action="store_true", help="every configured bundle")
    sp.add_argument("--repro", action="store_true", help="build twice, byte-compare (G-M2.R)")
    sp.add_argument("--stage-only", action="store_true", help="stop at the staged tree (.cache/stage/<bundle>/)")
    sp.add_argument("--tar-only", action="store_true", help="tar an existing staged tree")
    sp.add_argument("--unpruned", action="store_true", help="materialize patched-but-unpruned trees for the tracer")
    sp.set_defaults(run=_handler("pack_package"))

    sp = sub.add_parser("trace", help="import tracer (G3): record / check / propose")
    tsub = sp.add_subparsers(metavar="mode", required=True)
    tp = tsub.add_parser("record", help="run package corpus groups over unpruned trees (Node fork boot)")
    tp.add_argument("--group", help="one corpus group only")
    tp.set_defaults(run=_handler("trace", "run_record"))
    tsub.add_parser("check", help="trace ∩ prune = ∅ AND no PIL/fontTools attempt").set_defaults(run=_handler("trace", "run_check"))
    tp = tsub.add_parser("propose", help="unreached-subtree prune candidates for human curation")
    tp.add_argument("pkg")
    tp.set_defaults(run=_handler("trace", "run_propose"))

    sp = sub.add_parser("census", help="DSO census + grouped-world audit over the staged bundle tars")
    sp.add_argument("--check", action="store_true", help="gate mode (grouped-world v2 checks)")
    sp.set_defaults(run=_handler("census"))

    sp = sub.add_parser("verify-groups", help="gate the linked grouped side modules (dist/groups/<b>.so)")
    sp.add_argument("--spike", metavar="BUNDLE", help="verify dist/groups/spike-<b>.so instead")
    sp.add_argument("--pkgs", metavar="a,b", help="spike: restrict to these packages' extensions")
    sp.set_defaults(run=_handler("verify_groups"))

    sp = sub.add_parser("verify-pytree", help="rebuilt-vs-upstream .py byte-equality per DSO package")
    sp.add_argument("pkgs", nargs="*", help="subset of packages (spike lane)")
    sp.set_defaults(run=_handler("verify_pytree"))

    sp = sub.add_parser("compress", help="brotli .br siblings for every servable artifact")
    sp.add_argument("--force", action="store_true", help="recompress even when up to date")
    sp.set_defaults(run=_handler("compress"))

    sp = sub.add_parser("budgets", help="size-budget gate (G1) over raw + .br ceilings")
    sp.add_argument("--update", action="store_true", help="restamp artifact ceilings (measured × headroom)")
    sp.set_defaults(run=_handler("budgets"))

    sp = sub.add_parser("stage", help="stage artifacts to web/public/py-dev/fork/ + regenerate codegen + build-lock")
    sp.add_argument("--check", action="store_true", help="drift gate: fail if anything on disk differs")
    sp.set_defaults(run=_handler("stage"))

    sp = sub.add_parser("publish", help="staged artifacts → R2 under <buildHash>/ (local miniflare seed by default)")
    sp.add_argument("--remote", action="store_true", help="publish to the real avlo-py bucket")
    sp.add_argument("--local", action="store_true", help="(default) seed the dev miniflare tree")
    sp.add_argument("--dry-run", action="store_true", help="print the upload plan only")
    sp.set_defaults(run=_handler("publish"))

    sp = sub.add_parser("repro", help="determinism doubles on demand: pack-stdlib + pack-bundles, byte-compared")
    sp.add_argument("--stdlib", action="store_true", help="stdlib only")
    sp.add_argument("--bundles", action="store_true", help="bundles only")
    sp.set_defaults(run=_handler("repro"))

    args = p.parse_args(argv)
    sys.exit(args.run(args) or 0)
