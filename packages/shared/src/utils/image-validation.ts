/**
 * Image validation via magic byte detection.
 * Shared between worker (upload validation) and client (fail-fast in ingest).
 */

export function validateImage(bytes: Uint8Array): { valid: boolean; mimeType: string } {
  if (bytes.length < 12) return { valid: false, mimeType: '' };

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { valid: true, mimeType: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg' };
  }
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp' };
  }
  // GIF: GIF8 (GIF87a or GIF89a)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { valid: true, mimeType: 'image/gif' };
  }
  // ICO: 00 00 01 00 (reserved=0, type=1 icon)
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { valid: true, mimeType: 'image/x-icon' };
  }

  return { valid: false, mimeType: '' };
}

/**
 * Parse image dimensions from binary headers.
 * Returns { width: 0, height: 0 } for unrecognized or too-short data.
 */
export function parseImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  const none = { width: 0, height: 0 };

  switch (mimeType) {
    case 'image/png': {
      // IHDR chunk: bytes 16-23 (big-endian width @ 16, height @ 20)
      if (bytes.length < 24) return none;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }

    case 'image/jpeg': {
      // Scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) markers
      let i = 2; // skip SOI (FF D8)
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
        }
        // Skip to next marker using segment length
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        i += 2 + segLen;
      }
      return none;
    }

    case 'image/webp': {
      if (bytes.length < 30) return none;
      // VP8 (lossy): starts at offset 12
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
        if (bytes[15] === 0x20) {
          // VP8 lossy — dimensions at offset 26-29 (little-endian, 14-bit)
          if (bytes.length < 30) return none;
          return {
            width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
            height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
          };
        }
        if (bytes[15] === 0x4c) {
          // VP8L (lossless) — signature byte at 21, dims packed in next 4 bytes
          if (bytes.length < 25) return none;
          const b0 = bytes[21],
            b1 = bytes[22],
            b2 = bytes[23],
            b3 = bytes[24];
          return {
            width: (b0 | ((b1 & 0x3f) << 8)) + 1,
            height: ((b1 >> 6) | (b2 << 2) | ((b3 & 0xf) << 10)) + 1,
          };
        }
        if (bytes[15] === 0x58) {
          // VP8X (extended) — canvas size at bytes 24-29 (24-bit LE, +1)
          if (bytes.length < 30) return none;
          const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
          const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
          return { width: w, height: h };
        }
      }
      return none;
    }

    case 'image/gif': {
      // Bytes 6-9 (little-endian)
      if (bytes.length < 10) return none;
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }

    case 'image/x-icon': {
      // First image entry at byte 6: width (0 = 256), height (0 = 256)
      if (bytes.length < 8) return none;
      return {
        width: bytes[6] || 256,
        height: bytes[7] || 256,
      };
    }

    default:
      return none;
  }
}

/**
 * Detect SVG content by checking for <?xml or <svg prefix.
 * Handles optional UTF-8 BOM (EF BB BF).
 */
export function isSvg(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 256);
  if (len < 4) return false;

  // Skip UTF-8 BOM
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }

  // Decode first 256 bytes as UTF-8
  const text = new TextDecoder().decode(bytes.subarray(start, len)).trimStart().toLowerCase();
  return text.startsWith('<?xml') || text.startsWith('<svg');
}
