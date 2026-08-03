"""Minimal RGBA8 PNG encoder — pure Python over stdlib zlib.

Replaces Pillow for matplotlib's Agg PNG path (wheel patch 0002-pillow-ectomy
rewires `image.imsave` / `FigureCanvasAgg.print_png` here). Deterministic by
construction: fixed zlib level, filter 0 scanlines, no timestamps; the
`metadata` kwarg is accepted for imsave-signature compatibility and
deliberately ignored. Import-light (zlib only) — it ships in the stdlib zip;
keep it dependency-free so importing it never drags extra modules into a
captured snapshot.

Level 1, not 9 (2026-08): zlib is deterministic at every level, so assetId
dedup (sha256 of the exact bytes) is unaffected by the choice. Level 9 was
720 ms of a 906 ms savefig on a 1920x1440 figure; level 1 is ~39 ms at ~+28%
bytes. The IDAT stream feeds scanline-by-scanline through one compressobj
over zero-copy memoryview slices — peak transient memory ~1x the pixel
payload (the old path made ~3 full copies), which keeps large figures away
from the executor's heap-growth respawn heuristic.
"""

import zlib

_LEVEL = 1


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
    stride = w * 4
    # Zero-copy 1-D byte view when C-contiguous (the imsave patch site passes
    # np.ascontiguousarray output); one flattening copy otherwise.
    flat = mv.cast("B") if mv.c_contiguous else memoryview(mv.tobytes())

    co = zlib.compressobj(_LEVEL)
    idat = bytearray()
    for y in range(h):
        idat += co.compress(b"\x00")  # filter type 0 (None) per scanline
        idat += co.compress(flat[y * stride : (y + 1) * stride])
    idat += co.flush()

    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out += _chunk(
        b"IHDR",
        w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, 6, 0, 0, 0]),
    )
    if dpi:
        ppm = round(dpi / 0.0254).to_bytes(4, "big")
        out += _chunk(b"pHYs", ppm + ppm + b"\x01")
    out += _chunk(b"IDAT", idat)
    out += _chunk(b"IEND", b"")

    if hasattr(fname, "write"):
        fname.write(bytes(out))
    else:
        with open(fname, "wb") as f:
            f.write(out)
