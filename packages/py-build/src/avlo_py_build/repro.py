"""Determinism doubles, on demand (the old board ran these on every pass;
they now run when determinism is actually in question — a toolchain or
packer change):

  avlo-build repro             # stdlib ×2 byte-compare + bundles --repro
  avlo-build repro --stdlib    # stdlib only
  avlo-build repro --bundles   # bundles only
"""

from argparse import Namespace

from . import pack_package, pack_stdlib


def run(args) -> int:
    both = not (args.stdlib or args.bundles)
    if args.stdlib or both:
        rc = pack_stdlib.run(Namespace(repro=True))
        if rc:
            return rc
    if args.bundles or both:
        rc = pack_package.run(
            Namespace(bundles=[], all=True, repro=True, stage_only=False, tar_only=False, unpruned=False)
        )
        if rc:
            return rc
    print("repro: all byte-identity doubles green")
    return 0
