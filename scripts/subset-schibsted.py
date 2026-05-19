#!/usr/bin/env python3
"""Subset Schibsted Grotesk — the canvas UI / brand font.

Source: client/public/fonts/SchibstedGrotesk[wght].woff2 (variable wght 400-900, ~70 KB).
Output: same path, in-place overwrite.

Choices (different from Inter/Lora/Grandstander/JBMono in this repo because this
font is UI chrome, not canvas content):
  - wght axis clipped 400-700 (drops ExtraBold/Black gvar deltas).
  - Features: ccmp + locl + kern + mark + mkmk + liga + tnum + case.
    Extras vs. canvas fonts: liga (standard ligs — brand readability),
    tnum (aligned digits in counts/badges), case (raised punctuation in caps).
  - Unicode: Google Fonts "latin" subset — same range as the canvas fonts.
  - Hinting kept (prep + gasp benefit UI at small sizes).
  - All name records kept (OFL license + brand attribution).

Run from repo root:
    .venv/bin/python scripts/subset-schibsted.py
(uses the venv at /home/issak/dev/avlo/.venv)
"""

from __future__ import annotations

import sys
from io import BytesIO
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "client/public/fonts/SchibstedGrotesk[wght].woff2"

# Google Fonts "latin" subset — matches the other woff2s in this folder.
LATIN_UNICODE_RANGES = (
    "U+0000-00FF,"
    "U+0131,"  # dotless i
    "U+0152-0153,"  # OE, oe
    "U+02BB-02BC,"  # turned commas
    "U+02C6,"  # modifier circumflex
    "U+02DA,"  # ring above
    "U+02DC,"  # small tilde
    "U+0304,U+0308,U+0329,"  # combining macron / diaeresis / vertical line below
    "U+2000-206F,"  # general punctuation (em dash, ellipsis, smart quotes, ...)
    "U+20AC,"  # euro
    "U+2122,"  # trademark
    "U+2190-219F,"  # arrows block (←, →, ↑, ↓, ...)
    "U+2212,U+2215,"  # minus, division slash
    "U+FEFF,U+FFFD"  # ZWNBSP, replacement char
)

FEATURES = ["ccmp", "locl", "kern", "mark", "mkmk", "liga", "tnum", "case"]

WGHT_RANGE = (400, 700)


def parse_unicodes(spec: str) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("U+"):
            part = part[2:]
        if "-" in part:
            lo, hi = part.split("-")
            for cp in range(int(lo, 16), int(hi, 16) + 1):
                out.add(cp)
        else:
            out.add(int(part, 16))
    return out


def main() -> int:
    if not SRC.exists():
        print(f"ERR: source not found: {SRC}", file=sys.stderr)
        return 1

    src_size = SRC.stat().st_size
    print(f"Source: {SRC.name} ({src_size:,} B)")

    font = TTFont(str(SRC))

    # Guard against re-running on already-subsetted output (script overwrites
    # in place, so a second run on the prior output silently drops glyphs not
    # in the new subset). Upstream ships wght 400-900.
    wght = next(a for a in font["fvar"].axes if a.axisTag == "wght")
    if (wght.minValue, wght.maxValue) == WGHT_RANGE:
        print(
            f"  ABORT: input already subsetted (wght {wght.minValue}-{wght.maxValue}).\n"
            f"  Re-download upstream original first:\n"
            f"    curl -sL -o '{SRC}' \\\n"
            f"      'https://raw.githubusercontent.com/schibsted/schibsted-grotesk/main/fonts/variable/SchibstedGrotesk%5Bwght%5D.woff2'",
            file=sys.stderr,
        )
        return 2

    # 1. Clip wght axis 400-900 -> 400-700 (still variable, just narrower).
    font = instantiateVariableFont(
        font,
        axisLimits={"wght": WGHT_RANGE},
        inplace=False,
        optimize=True,
    )
    print(f"  axis clipped: wght {WGHT_RANGE[0]}-{WGHT_RANGE[1]}")

    # 2. Subset glyphs + features.
    opts = Options()
    opts.flavor = "woff2"
    opts.layout_features = FEATURES
    opts.name_IDs = ["*"]  # keep OFL license + attribution + variable instance names
    opts.name_legacy = True
    opts.name_languages = ["*"]
    opts.notdef_outline = False
    opts.recommended_glyphs = False
    opts.glyph_names = False
    opts.legacy_kern = False
    opts.symbol_cmap = False
    opts.legacy_cmap = False
    opts.hinting = True
    opts.desubroutinize = False  # CFF only; no-op for glyf but explicit.

    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=parse_unicodes(LATIN_UNICODE_RANGES))
    subsetter.subset(font)

    # 3. Write back in-place.
    font.flavor = "woff2"
    buf = BytesIO()
    font.save(buf)
    data = buf.getvalue()
    SRC.write_bytes(data)

    out_size = SRC.stat().st_size
    ratio = out_size / src_size * 100
    print(f"  features: {','.join(FEATURES)}")
    print(f"Wrote:  {SRC.name} ({out_size:,} B, {ratio:.1f}% of source)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
