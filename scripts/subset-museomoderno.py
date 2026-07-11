#!/usr/bin/env python3
# /// script
# requires-python = ">=3.13"
# dependencies = ["fonttools[woff]>=4.63"]
# ///
"""Subset MuseoModerno — the "avlo" logo wordmark font.

Source: web/public/fonts/MuseoModerno[wght].ttf (variable wght 100-900, ~184 KB,
        the raw Google Fonts download).
Output: web/public/fonts/MuseoModerno[wght].woff2 (self-hosted, replaces the
        Google Fonts <link> in index.html).

Mirrors scripts/subset-schibsted.py — MuseoModerno is UI chrome (the logo), not
canvas content, so it gets the same treatment as Schibsted Grotesk:
  - wght axis clipped 400-700 (drops the unused Thin..ExtraBold/Black deltas;
    the wordmark uses 600).
  - Features: ccmp + locl + kern + mark + mkmk + liga + tnum + case (the ones
    MuseoModerno actually carries are kept; requesting absent ones is a no-op).
  - Unicode: Google Fonts "latin" subset — same range as every other font here.
    NOT restricted to a-v-l-o: keep the full Latin set in case the font gets
    reused elsewhere in the UI. Narrow it to the wordmark glyphs later if the
    logo stays its only consumer.
  - Hinting kept (cheap; benefits any small-size UI use).
  - All name records kept (OFL license + attribution).

The source .ttf is deleted after a successful run (web/public/fonts/ ships woff2
only). To re-run, re-fetch the upstream original first:
    curl -sL -o 'web/public/fonts/MuseoModerno[wght].ttf' \
      'https://github.com/google/fonts/raw/main/ofl/museomoderno/MuseoModerno%5Bwght%5D.ttf'

Run from repo root (uv reads the inline deps above — no venv needed):
    uv run scripts/subset-museomoderno.py
"""

from __future__ import annotations

import sys
from io import BytesIO
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "web/public/fonts/MuseoModerno[wght].ttf"
OUT = REPO_ROOT / "web/public/fonts/MuseoModerno[wght].woff2"

# Google Fonts "latin" subset — identical to subset-schibsted.py and the
# self-hosted content fonts in this folder.
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
        print(
            f"ERR: source not found: {SRC}\n"
            f"  Re-fetch the upstream original:\n"
            f"    curl -sL -o '{SRC}' \\\n"
            f"      'https://github.com/google/fonts/raw/main/ofl/museomoderno/MuseoModerno%5Bwght%5D.ttf'",
            file=sys.stderr,
        )
        return 1

    src_size = SRC.stat().st_size
    print(f"Source: {SRC.name} ({src_size:,} B)")

    font = TTFont(str(SRC))

    wght = next(a for a in font["fvar"].axes if a.axisTag == "wght")
    print(f"  upstream wght axis: {wght.minValue}-{wght.maxValue}")

    # NOTE: subset BEFORE instancing. Clipping the wght axis prunes the gvar
    # deltas of blank glyphs (space, nbsp, ...) to nothing and drops them from
    # gvar.variations while they stay in the glyph order; the subsequent gvar
    # subset pass then KeyErrors on them. Subsetting first runs against the
    # pristine (complete) gvar, and the instancer's own drop is harmless since
    # no subset pass follows it.

    # 1. Subset glyphs + features (font still spans the full wght axis here).
    opts = Options()
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

    # 2. Clip wght axis 100-900 -> 400-700 (still variable, just narrower).
    font = instantiateVariableFont(
        font,
        axisLimits={"wght": WGHT_RANGE},
        inplace=False,
        optimize=True,
    )
    print(f"  axis clipped: wght {WGHT_RANGE[0]}-{WGHT_RANGE[1]}")

    # 3. Write woff2.
    font.flavor = "woff2"
    buf = BytesIO()
    font.save(buf)
    OUT.write_bytes(buf.getvalue())

    out_size = OUT.stat().st_size
    ratio = out_size / src_size * 100
    print(f"  features: {','.join(FEATURES)}")
    print(f"Wrote:  {OUT.name} ({out_size:,} B, {ratio:.1f}% of source ttf)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
