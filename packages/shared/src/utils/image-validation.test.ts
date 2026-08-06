import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isSvg, parseImageDimensions, validateImage } from './image-validation';

/** Byte builders are written out longhand here — the magic bytes ARE the subject. */
const png = (w = 8, h = 6): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
};

const gif = (w = 4, h = 3, version: '87a' | '89a' = '89a'): Uint8Array => {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, version === '89a' ? 0x39 : 0x37, 0x61]);
  b[6] = w & 0xff;
  b[7] = w >> 8;
  b[8] = h & 0xff;
  b[9] = h >> 8;
  return b;
};

/** SOI + SOF0 immediately: height @7-8 BE, width @9-10 BE. */
const jpegSof0 = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dv = new DataView(b.buffer);
  dv.setUint16(7, h);
  dv.setUint16(9, w);
  return b;
};

/** SOI + APP0 (segLen 4) + SOF2 at offset 8 — exercises the marker skip loop. */
const jpegSof2AfterApp0 = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(26);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08]);
  const dv = new DataView(b.buffer);
  dv.setUint16(13, h); // i=8 → height @ i+5
  dv.setUint16(15, w); // width @ i+7
  return b;
};

const webpHeader = (): Uint8Array => {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46, 0x18, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  return b;
};

const webpVp8 = (w: number, h: number): Uint8Array => {
  const b = webpHeader();
  b.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 ' lossy
  b[26] = w & 0xff;
  b[27] = (w >> 8) & 0x3f;
  b[28] = h & 0xff;
  b[29] = (h >> 8) & 0x3f;
  return b;
};

const webpVp8l = (w: number, h: number): Uint8Array => {
  const b = webpHeader();
  b.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L' lossless
  const wm = w - 1;
  const hm = h - 1;
  b[21] = wm & 0xff;
  b[22] = ((wm >> 8) & 0x3f) | ((hm & 0x03) << 6);
  b[23] = (hm >> 2) & 0xff;
  b[24] = (hm >> 10) & 0x0f;
  return b;
};

const webpVp8x = (w: number, h: number): Uint8Array => {
  const b = webpHeader();
  b.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X' extended
  const wm = w - 1;
  const hm = h - 1;
  b[24] = wm & 0xff;
  b[25] = (wm >> 8) & 0xff;
  b[26] = (wm >> 16) & 0xff;
  b[27] = hm & 0xff;
  b[28] = (hm >> 8) & 0xff;
  b[29] = (hm >> 16) & 0xff;
  return b;
};

const ico = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(22);
  b.set([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, w === 256 ? 0 : w, h === 256 ? 0 : h]);
  return b;
};

describe('validateImage', () => {
  it('detects each allow-listed format from magic bytes with the right mime', () => {
    expect(validateImage(png())).toEqual({ valid: true, mimeType: 'image/png' });
    expect(validateImage(jpegSof0(4, 4))).toEqual({ valid: true, mimeType: 'image/jpeg' });
    expect(validateImage(gif(1, 1, '89a'))).toEqual({ valid: true, mimeType: 'image/gif' });
    expect(validateImage(gif(1, 1, '87a'))).toEqual({ valid: true, mimeType: 'image/gif' });
    expect(validateImage(webpVp8(4, 4))).toEqual({ valid: true, mimeType: 'image/webp' });
    expect(validateImage(ico(16, 16))).toEqual({ valid: true, mimeType: 'image/x-icon' });
  });

  it('rejects sub-12-byte buffers regardless of magic', () => {
    expect(validateImage(png().slice(0, 11)).valid).toBe(false);
    expect(validateImage(new Uint8Array(0)).valid).toBe(false);
  });

  it('rejects SVG and arbitrary text (no sniffable magic)', () => {
    expect(validateImage(new TextEncoder().encode('<svg xmlns="x"></svg>')).valid).toBe(false);
    expect(validateImage(new TextEncoder().encode('hello world, not an image')).valid).toBe(false);
  });

  it('CHARACTERIZED: the ICO check is loose — any 00 00 01 00 prefix passes as image/x-icon', () => {
    // The 4-byte reserved/type prefix is all the sniff has; arbitrary data shaped like
    // this validates. Accepted: ICO has no richer magic, and the R2 objects are inert.
    const impostor = new Uint8Array(16);
    impostor.set([0x00, 0x00, 0x01, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    expect(validateImage(impostor)).toEqual({ valid: true, mimeType: 'image/x-icon' });
  });
});

describe('parseImageDimensions', () => {
  it('reads PNG IHDR big-endian dims', () => {
    expect(parseImageDimensions(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
  });

  it('reads GIF little-endian dims', () => {
    expect(parseImageDimensions(gif(320, 200), 'image/gif')).toEqual({ width: 320, height: 200 });
  });

  it('reads JPEG SOF0 directly and SOF2 through the segment-skip loop', () => {
    expect(parseImageDimensions(jpegSof0(800, 600), 'image/jpeg')).toEqual({ width: 800, height: 600 });
    expect(parseImageDimensions(jpegSof2AfterApp0(1024, 768), 'image/jpeg')).toEqual({ width: 1024, height: 768 });
  });

  it('reads all three WebP container flavors — VP8 lossy, VP8L packed, VP8X 24-bit', () => {
    expect(parseImageDimensions(webpVp8(300, 200), 'image/webp')).toEqual({ width: 300, height: 200 });
    expect(parseImageDimensions(webpVp8l(100, 50), 'image/webp')).toEqual({ width: 100, height: 50 });
    expect(parseImageDimensions(webpVp8x(4000, 3000), 'image/webp')).toEqual({ width: 4000, height: 3000 });
  });

  it('maps the ICO 0-byte dimension convention to 256', () => {
    expect(parseImageDimensions(ico(16, 32), 'image/x-icon')).toEqual({ width: 16, height: 32 });
    expect(parseImageDimensions(ico(256, 256), 'image/x-icon')).toEqual({ width: 256, height: 256 });
  });

  it('returns 0×0 for unknown mimes and too-short buffers', () => {
    expect(parseImageDimensions(png(), 'image/tiff')).toEqual({ width: 0, height: 0 });
    expect(parseImageDimensions(png().slice(0, 20), 'image/png')).toEqual({ width: 0, height: 0 });
    expect(parseImageDimensions(gif().slice(0, 8), 'image/gif')).toEqual({ width: 0, height: 0 });
  });
});

describe('properties', () => {
  const MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'application/octet-stream'];

  it('is total: no input bytes can make any parser throw, and <12 bytes never validate', () => {
    // These run on attacker-supplied upload bodies — crashing is a worker 500.
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.constantFrom(...MIMES), (bytes, mime) => {
        const v = validateImage(bytes);
        if (bytes.length < 12) expect(v).toEqual({ valid: false, mimeType: '' });
        const d = parseImageDimensions(bytes, mime);
        expect(d.width).toBeGreaterThanOrEqual(0);
        expect(d.height).toBeGreaterThanOrEqual(0);
        isSvg(bytes); // must not throw
      }),
    );
  });

  it('round-trips arbitrary dimensions through every builder + parser pair', () => {
    const u16 = fc.integer({ min: 0, max: 0xffff });
    fc.assert(
      fc.property(u16, u16, (w, h) => {
        expect(parseImageDimensions(gif(w, h), 'image/gif')).toEqual({ width: w, height: h });
        expect(parseImageDimensions(jpegSof0(w, h), 'image/jpeg')).toEqual({ width: w, height: h });
        expect(parseImageDimensions(jpegSof2AfterApp0(w, h), 'image/jpeg')).toEqual({ width: w, height: h });
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 0xffffffff }), (w, h) => {
        expect(parseImageDimensions(png(w, h), 'image/png')).toEqual({ width: w, height: h });
      }),
    );
    const vp8 = fc.integer({ min: 0, max: 0x3fff });
    fc.assert(
      fc.property(vp8, vp8, (w, h) => {
        expect(parseImageDimensions(webpVp8(w, h), 'image/webp')).toEqual({ width: w, height: h });
      }),
    );
    const vp8l = fc.integer({ min: 1, max: 0x4000 }); // +1-packed 14-bit
    fc.assert(
      fc.property(vp8l, vp8l, (w, h) => {
        expect(parseImageDimensions(webpVp8l(w, h), 'image/webp')).toEqual({ width: w, height: h });
      }),
    );
    const vp8x = fc.integer({ min: 1, max: 0x1000000 }); // +1-packed 24-bit
    fc.assert(
      fc.property(vp8x, vp8x, (w, h) => {
        expect(parseImageDimensions(webpVp8x(w, h), 'image/webp')).toEqual({ width: w, height: h });
      }),
    );
  });
});

describe('isSvg', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('detects <svg and <?xml prefixes, case-insensitively, with leading whitespace', () => {
    expect(isSvg(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true);
    expect(isSvg(enc('<?xml version="1.0"?><svg/>'))).toBe(true);
    expect(isSvg(enc('  \n\t<SVG/>'))).toBe(true);
  });

  it('skips a UTF-8 BOM', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('<svg/>')]);
    expect(isSvg(bom)).toBe(true);
  });

  it('rejects non-SVG text, sub-4-byte buffers, and svg content past the 256-byte window', () => {
    expect(isSvg(enc('<html><body>nope</body></html>'))).toBe(false);
    expect(isSvg(enc('<s'))).toBe(false);
    expect(isSvg(enc(`${' '.repeat(300)}<svg/>`))).toBe(false);
  });
});
