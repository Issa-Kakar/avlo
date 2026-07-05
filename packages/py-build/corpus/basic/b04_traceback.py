# self-asserting: traceback shape on a pyc-only stdlib — stdlib frames keep
# file+line (no source), user frames raise normally
import traceback

try:
    import json

    json.loads("{nope")
except Exception:
    tb = traceback.format_exc()
    assert "json/decoder" in tb, tb  # stdlib frame file path present
    assert "JSONDecodeError" in tb, tb
print("b04 ok")
