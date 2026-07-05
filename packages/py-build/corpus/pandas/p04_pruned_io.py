# trace: skip — deliberately imports PRUNED modules; running it under the
# tracer (unpruned trees) would poison the trace ∩ prune = ∅ gate.
# self-asserting: pruned pandas subtrees tombstone precisely while their
# shipped parents keep importing, and user-level surfaces hit the same error
import pandas.io.formats  # noqa: F401 — shipped parent must import fine
import pandas.io.sas  # noqa: F401 — eager front door stays

for name in ("pandas.io.formats.style", "pandas.io.clipboard", "pandas.io.sas.sas7bdat"):
    try:
        __import__(name)
    except ModuleNotFoundError as e:
        assert "not available in AVLO" in str(e), f"{name}: {e}"
    else:
        raise AssertionError(f"{name} should be tombstoned")

import pandas as pd

try:
    _ = pd.DataFrame({"a": [1]}).style  # lazy Styler path
except (ModuleNotFoundError, AttributeError) as e:
    # pandas probes jinja2 BEFORE touching the pruned style module, so its own
    # "requires jinja2" AttributeError fires first — equally actionable.
    assert "not available in AVLO" in str(e) or "jinja2" in str(e), e
else:
    raise AssertionError("df.style should fail actionably")
print("p04 ok")
