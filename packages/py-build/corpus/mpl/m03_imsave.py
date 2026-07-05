# self-asserting: PNG write path via _avlo_png (pillow-ectomy) — savefig and
# imsave produce real PNGs; non-PNG rasters and imread refuse clearly
import io

import matplotlib.image as mimage
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(2, 2), dpi=100)
ax.plot([0, 1], [1, 0])
buf = io.BytesIO()
fig.savefig(buf, format="png")
assert buf.getvalue()[:8] == b"\x89PNG\r\n\x1a\n"
plt.close(fig)

arr = np.zeros((5, 7, 4), dtype=np.uint8)
arr[..., 0] = 255
arr[..., 3] = 255
b2 = io.BytesIO()
mimage.imsave(b2, arr, format="png")
assert b2.getvalue()[:8] == b"\x89PNG\r\n\x1a\n"

fig2 = plt.figure()
try:
    fig2.savefig(io.BytesIO(), format="jpg")
except ValueError as e:
    assert "PNG" in str(e) or "Pillow" in str(e), e
else:
    raise AssertionError("jpg savefig should refuse")
finally:
    plt.close(fig2)

try:
    mimage.imread(io.BytesIO(b"\x89PNG"))
except ValueError as e:
    assert "Pillow" in str(e), e
else:
    raise AssertionError("imread should refuse")
print("m03 ok")
