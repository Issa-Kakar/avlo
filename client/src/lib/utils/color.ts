/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Convert RGB to hex color
 */
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Create a tinted fill color from stroke color
 * @param strokeColor - The stroke color in hex format
 * @param mixRatio - Ratio of stroke color (default 0.15 = 15% stroke, 85% white)
 */
export function createFillFromStroke(strokeColor: string, mixRatio = 0.15): string {
  const rgb = hexToRgb(strokeColor);
  if (!rgb) return strokeColor;  // Fallback to original if parsing fails

  // Mix with white (255, 255, 255)
  const tinted = {
    r: Math.round(rgb.r * mixRatio + 255 * (1 - mixRatio)),
    g: Math.round(rgb.g * mixRatio + 255 * (1 - mixRatio)),
    b: Math.round(rgb.b * mixRatio + 255 * (1 - mixRatio))
  };

  return rgbToHex(tinted.r, tinted.g, tinted.b);
}