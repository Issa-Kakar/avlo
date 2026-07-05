# self-asserting: overlay modules shipped in the stdlib zip are importable and
# the post-restore contract is callable
import _avlo_runtime

_avlo_runtime.post_restore()  # no-op-safe on a fresh interpreter
import sitecustomize  # noqa: F401 — already imported by site; must not blow up

print("b05 ok")
