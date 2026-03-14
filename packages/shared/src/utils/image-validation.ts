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
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp' };
  }
  // GIF: GIF8 (GIF87a or GIF89a)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { valid: true, mimeType: 'image/gif' };
  }

  return { valid: false, mimeType: '' };
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
