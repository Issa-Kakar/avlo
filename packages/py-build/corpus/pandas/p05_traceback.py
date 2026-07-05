# trace: skip — asserts the PACKED artifact's pyc-only traceback shape; the
# tracer's unpruned trees ship .py source, so the no-source assert can't hold.
# self-asserting: traceback contract (G6) — library frames resolve to a
# site-packages file+line WITHOUT source text (pyc-only bundles)
import traceback

import pandas as pd

try:
    pd.DataFrame({"a": [1]}).no_such_method()
except AttributeError:
    tb = traceback.format_exc()
    assert "pandas/core/generic.py" in tb, tb
    lines = tb.splitlines()
    i = next(k for k, ln in enumerate(lines) if "pandas/core/generic.py" in ln)
    assert ", line " in lines[i] and "in __getattr__" in lines[i], lines[i]
    # pyc-only: no 4-space-indented source line may follow a library frame
    assert not (i + 1 < len(lines) and lines[i + 1].startswith("    ")), tb
else:
    raise AssertionError("expected AttributeError")
print("p05 ok")
