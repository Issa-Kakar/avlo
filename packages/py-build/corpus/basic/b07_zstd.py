# self-asserting: _zstd is STATIC (2026-08) — the 3.14 compression.zstd
# wrapper round-trips for real, at a non-default level, with a dict-free
# streaming decompressor. Failure modes guarded: module tombstoned again,
# wrapper pruned but C module present, or a broken static link.
import compression.zstd as zstd

payload = b"avlo-zstd-corpus " * 4096
comp = zstd.compress(payload, level=7)
assert len(comp) < len(payload) // 4, f"no real compression: {len(comp)}"
assert zstd.decompress(comp) == payload

d = zstd.ZstdDecompressor()
assert d.decompress(comp) == payload
assert d.eof

import _zstd  # the C module itself imports directly

assert hasattr(_zstd, "ZstdCompressor")
print("b07 ok")
