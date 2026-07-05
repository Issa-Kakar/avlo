# self-asserting: the baseline warmup module set actually works
import datetime
import json
import math
import re
from collections import Counter

assert json.loads(json.dumps({"a": [1, 2.5, None, True]})) == {"a": [1, 2.5, None, True]}
assert math.isclose(math.sin(math.pi / 2), 1.0)
assert re.findall(r"\d+", "a1b22c333") == ["1", "22", "333"]
assert Counter("avlo avlo").most_common(1)[0][1] == 2
assert datetime.date(2026, 1, 2).isoformat() == "2026-01-02"
print("b02 ok")
