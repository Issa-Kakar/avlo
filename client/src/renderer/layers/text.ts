/**
 * Text rendering utilities.
 *
 * NOTE: Text in this codebase is a PLACEHOLDER implementation.
 * The entire text system will be fully replaced - don't worry about
 * updates or improving the logic here. Known issues (e.g., font size
 * not scaling during transforms) are expected and will be addressed
 * in the complete rewrite.
 */

import type { ObjectHandle } from '@avlo/shared';
import {
  getFrame,
  getText,
  getColor,
  getFontSize,
  getFontFamily,
  getFontWeight,
  getFontStyle,
  getTextAlignH,
  getOpacity,
} from '@avlo/shared';
import type { ScaleTransform } from '@/stores/selection-store';
import { applyTransformToFrame, applyUniformScaleToFrame } from '@/lib/geometry/transform';

// Helper function for text wrapping
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

export function drawTextBox(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
  const { y } = handle;

  // Get frame and text content
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const [x, y0, w] = frame;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, textContent, w);
  const lineHeight = fontSize * 1.2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, y0 + i * lineHeight);
  }

  ctx.restore();
}

/**
 * Draw text with transform applied to frame (placeholder - only scales frame position, not text itself).
 */
export function drawTextWithTransform(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: { kind: string; dx?: number; dy?: number; origin?: [number, number]; scaleX?: number; scaleY?: number }
): void {
  const { y } = handle;

  // Get original frame and compute transformed frame
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const transformedFrame = applyTransformToFrame(frame, transform);
  const [x, y0, w] = transformedFrame;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling (font size not scaled - placeholder behavior, will change)
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Calculate text position based on alignment
  let textX = x;
  if (textAlign === 'center') {
    textX = x + w / 2;
  } else if (textAlign === 'right') {
    textX = x + w;
  }

  // Simple text wrapping
  const lines = wrapText(ctx, textContent, w);
  const lineHeight = fontSize * 1.2;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], textX, y0 + i * lineHeight);
  }

  ctx.restore();
}

/**
 * Draw text with uniform scale (placeholder - only scales frame position, not text itself).
 */
export function drawTextWithUniformScale(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  transform: ScaleTransform
): void {
  const { y } = handle;
  const frame = getFrame(y);
  const textContent = getText(y);
  if (!frame || !textContent) return;

  const { scaleX, scaleY, origin, originBounds } = transform;

  // Apply uniform scale with position preservation (matches shape behavior)
  const transformedFrame = applyUniformScaleToFrame(frame, originBounds, origin, scaleX, scaleY);
  const [transformedX, transformedY, newW] = transformedFrame;

  // Get text styling
  const color = getColor(y);
  const fontSize = getFontSize(y);
  const fontFamily = getFontFamily(y);
  const fontWeight = getFontWeight(y);
  const fontStyle = getFontStyle(y);
  const textAlign = getTextAlignH(y);
  const opacity = getOpacity(y);

  ctx.save();
  ctx.globalAlpha = opacity;

  // Set up text styling (font size not scaled - placeholder behavior, will change)
  ctx.fillStyle = color;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as 'left' | 'center' | 'right';
  ctx.textBaseline = 'top';

  // Compute X position based on text alignment
  let textX = transformedX;
  if (textAlign === 'center') {
    textX = transformedX + newW / 2;
  } else if (textAlign === 'right') {
    textX = transformedX + newW;
  }

  ctx.fillText(textContent, textX, transformedY);
  ctx.restore();
}
