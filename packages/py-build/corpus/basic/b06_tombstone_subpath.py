# self-asserting: dotted tombstone keys — a pruned SUBTREE (xml.sax) errors
# precisely while its shipped parent (xml, xml.etree) keeps importing (D6).
import xml  # noqa: F401 — shipped parent must import fine
import xml.etree.ElementTree as ET

e = ET.Element("a")  # no expat needed to build elements
assert e.tag == "a"

for name in ("xml.sax", "xml.sax.handler"):
    try:
        __import__(name)
    except ModuleNotFoundError as err:
        msg = str(err)
        assert "not available in AVLO" in msg, f"{name}: wrong message: {msg}"
        # Parents import first, so a child of a pruned subtree errors naming
        # the pruned ROOT (xml.sax) — the actionable name, not the leaf.
        assert "'xml.sax'" in msg, f"{name}: message names the wrong module: {msg}"
    else:
        raise AssertionError(f"{name} imported but should be tombstoned")

# _avlo_png rides the stdlib zip from Step 1 on — importable + encodes.
# 4x3x4 uint8 buffer without numpy: memoryview cast over raw bytes.
import io

import _avlo_png

mv = memoryview(bytearray(range(48))).cast("B", (4, 3, 4))
buf = io.BytesIO()
_avlo_png.write_png(mv, buf, dpi=100)
png = buf.getvalue()
assert png[:8] == b"\x89PNG\r\n\x1a\n", "bad signature"
assert b"IHDR" in png[:33] and png.endswith(b"IEND\xaeB`\x82"), "bad chunks"

print("b06 ok")
