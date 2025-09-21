import type { Snapshot } from '@avlo/shared';
import { getStrokeCacheInstance } from '../stroke-builder/stroke-cache';

/**
 * Calculate perceived brightness of a color (0-255)
 * Using relative luminance formula
 */
function getColorBrightness(color: string): number {
  // Parse hex color
  let r = 0,
    g = 0,
    b = 0;

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  }

  // Calculate relative luminance
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Determine the best dimming strategy based on stroke color
 */
function getDimmingStrategy(strokeColor: string): {
  overlayColor: string;
  blendMode: CanvasRenderingContext2D['globalCompositeOperation'];
  extraThickness: number;
} {
  const brightness = getColorBrightness(strokeColor);

  // Dark colors (black, dark blue, etc) need light overlay
  if (brightness < 80) {
    return {
      overlayColor: 'rgba(255, 255, 255, 0.7)', // White overlay for dark strokes
      blendMode: 'screen', // Lightens the stroke
      extraThickness: 4,
    };
  }
  // Mid-tone colors
  else if (brightness < 180) {
    // For mid-tones, use inverted overlay for best contrast
    return {
      overlayColor:
        brightness < 130
          ? 'rgba(255, 200, 200, 0.8)' // Light red tint for darker mid-tones
          : 'rgba(0, 0, 0, 0.8)', // Black for lighter mid-tones
      blendMode: 'source-over',
      extraThickness: 3,
    };
  }
  // Light colors need dark overlay
  else {
    return {
      overlayColor: 'rgba(0, 0, 0, 0.9)', // Strong black for light strokes
      blendMode: 'source-over',
      extraThickness: 3,
    };
  }
}

export function drawDimmedStrokes(
  ctx: CanvasRenderingContext2D,
  hitIds: string[],
  snapshot: Snapshot,
  baseOpacity: number,
): void {
  const hitSet = new Set(hitIds);
  const cache = getStrokeCacheInstance();

  ctx.save();

  // Render hit strokes with adaptive dimming
  for (const stroke of snapshot.strokes) {
    if (!hitSet.has(stroke.id)) continue;

    const renderData = cache.getOrBuild(stroke);
    if (!renderData.path || renderData.pointCount < 2) continue;

    // Get adaptive dimming strategy based on stroke color
    const strategy = getDimmingStrategy(stroke.style.color);

    // Adjust opacity based on tool type
    const toolFactor = stroke.style.tool === 'highlighter' ? 0.6 : 1.0;
    const baseAlpha = Math.min(1, Math.max(0.5, baseOpacity * toolFactor));

    ctx.save();

    // Apply blend mode for better contrast
    ctx.globalCompositeOperation = strategy.blendMode;
    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = strategy.overlayColor;
    ctx.lineWidth = stroke.style.size + strategy.extraThickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(renderData.path);

    // For very thick black strokes, add a secondary pass with outline
    if (stroke.style.size > 10 && getColorBrightness(stroke.style.color) < 50) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = baseAlpha * 0.4;
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.8)'; // Red tint outline
      ctx.lineWidth = stroke.style.size + 8;
      ctx.stroke(renderData.path);
    }

    ctx.restore();
  }

  // Render hit text blocks with adaptive overlay
  for (const text of snapshot.texts) {
    if (!hitSet.has(text.id)) continue;

    // Adaptive text dimming based on text color
    const brightness = getColorBrightness(text.color);
    if (brightness < 80) {
      // Light overlay for dark text
      ctx.fillStyle = `rgba(255, 200, 200, ${Math.max(0.5, baseOpacity * 0.7)})`;
    } else {
      // Dark overlay for light text
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.4, baseOpacity * 0.8)})`;
    }

    ctx.fillRect(text.x, text.y, text.w, text.h);
  }

  ctx.restore();
}
