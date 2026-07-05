"""Minimal RGBA8 PNG encoder — pure Python over stdlib zlib.

Replaces Pillow for matplotlib's Agg PNG path (wheel patch 0002-pillow-ectomy
rewires `image.imsave` / `FigureCanvasAgg.print_png` here). Deterministic by
construction: fixed zlib level 9, filter 0 scanlines, no timestamps; the
`metadata` kwarg is accepted for imsave-signature compatibility and
deliberately ignored. Import-light (zlib only) — it ships in the stdlib zip
and must not drag anything extra into the baseline snapshot.
"""

import zlib


def _chunk(tag, payload):
    return (
        len(payload).to_bytes(4, "big")
        + tag
        + payload
        + zlib.crc32(tag + payload).to_bytes(4, "big")
    )


def write_png(rgba, fname, dpi=None, metadata=None):
    """Write an HxWx4 uint8 buffer as an RGBA PNG.

    rgba : numpy array or any object exposing a 3-D uint8 buffer (H, W, 4).
    fname: filesystem path or binary file-like (has .write).
    dpi  : optional scalar -> pHYs chunk (pixels per metre, both axes).
    """
    mv = memoryview(rgba)
    if mv.ndim != 3 or mv.shape[2] != 4 or mv.itemsize != 1:
        raise ValueError(
            f"write_png expects HxWx4 uint8, got shape {mv.shape!r} itemsize {mv.itemsize}"
        )
    h, w = mv.shape[0], mv.shape[1]
    data = mv.tobytes()  # C-order copy regardless of source strides
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None) per scanline
        raw += data[y * stride : (y + 1) * stride]

    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out += _chunk(
        b"IHDR",
        w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 6, 0, 0, 0]),
    )
    if dpi:
        ppm = round(dpi / 0.0254).to_bytes(4, "big")
        out += _chunk(b"pHYs", ppm + ppm + b"\x01")
    out += _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += _chunk(b"IEND", b"")

    if hasattr(fname, "write"):
        fname.write(bytes(out))
    else:
        with open(fname, "wb") as f:
            f.write(bytes(out))
