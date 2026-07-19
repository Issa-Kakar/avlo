# self-asserting: datetime machinery + the zoneinfo→pytz TZif bridge
# (_avlo_runtime.ensure_tzpath — stdlib zoneinfo reads pytz's tz database,
# so no separate tzdata package ships). pandas 3.0 dropped pytz as its tz
# backend — every tz op now rides zoneinfo, so the bridge must be up BEFORE
# pandas tz ops (the product executor guarantees this: post_restore runs
# after mounts, before user code; the corpus runner mirrors it post-mount).
import _avlo_runtime

_avlo_runtime.ensure_tzpath()

import pandas as pd

idx = pd.date_range("2026-01-01", periods=4, freq="D")
assert len(idx) == 4 and str(idx[3].date()) == "2026-01-04"

ts = pd.Timestamp("2026-07-05 12:00", tz="UTC")
est = ts.tz_convert("America/New_York")  # pandas 3 → zoneinfo → pytz TZif
assert est.hour == 8, est

from datetime import datetime
from zoneinfo import ZoneInfo

d = datetime(2026, 7, 5, 12, 0, tzinfo=ZoneInfo("UTC"))
ny = d.astimezone(ZoneInfo("America/New_York"))  # stdlib → pytz TZif path
assert ny.hour == 8, ny
print("p02 ok")
