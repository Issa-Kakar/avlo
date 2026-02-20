/**
 * TEXT CONTEXT MENU ICONS
 *
 * Pure functions that create SVG elements for the text context menu.
 * All icons are 16x16 by default.
 */

function createSVG(width = 16, height = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('fill', 'none');
  return svg;
}

/**
 * Bold icon - letter "B" in bold weight
 */
export function createBoldIcon(): SVGSVGElement {
  const svg = createSVG();
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', '8');
  text.setAttribute('y', '12');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', 'Inter, system-ui, sans-serif');
  text.setAttribute('font-size', '12');
  text.setAttribute('font-weight', '700');
  text.setAttribute('fill', 'currentColor');
  text.textContent = 'B';
  svg.appendChild(text);
  return svg;
}

/**
 * Italic icon - letter "I" in italic style
 */
export function createItalicIcon(): SVGSVGElement {
  const svg = createSVG();
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', '8');
  text.setAttribute('y', '12');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', 'Georgia, serif');
  text.setAttribute('font-size', '12');
  text.setAttribute('font-style', 'italic');
  text.setAttribute('fill', 'currentColor');
  text.textContent = 'I';
  svg.appendChild(text);
  return svg;
}

/**
 * Align left icon - 3 horizontal lines, left-aligned
 */
export function createAlignLeftIcon(): SVGSVGElement {
  const svg = createSVG();
  const lines = [
    { y: 3, width: 12 },
    { y: 7, width: 8 },
    { y: 11, width: 10 },
  ];
  for (const line of lines) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '2');
    rect.setAttribute('y', String(line.y));
    rect.setAttribute('width', String(line.width));
    rect.setAttribute('height', '2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'currentColor');
    svg.appendChild(rect);
  }
  return svg;
}

/**
 * Align center icon - 3 horizontal lines, centered
 */
export function createAlignCenterIcon(): SVGSVGElement {
  const svg = createSVG();
  const lines = [
    { y: 3, width: 12 },
    { y: 7, width: 8 },
    { y: 11, width: 10 },
  ];
  for (const line of lines) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const x = (16 - line.width) / 2;
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(line.y));
    rect.setAttribute('width', String(line.width));
    rect.setAttribute('height', '2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'currentColor');
    svg.appendChild(rect);
  }
  return svg;
}

/**
 * Align right icon - 3 horizontal lines, right-aligned
 */
export function createAlignRightIcon(): SVGSVGElement {
  const svg = createSVG();
  const lines = [
    { y: 3, width: 12 },
    { y: 7, width: 8 },
    { y: 11, width: 10 },
  ];
  for (const line of lines) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const x = 14 - line.width;
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(line.y));
    rect.setAttribute('width', String(line.width));
    rect.setAttribute('height', '2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'currentColor');
    svg.appendChild(rect);
  }
  return svg;
}

/**
 * Text color icon - letter "A" with colored underline bar (20x20)
 */
export function createTextColorIcon(color: string): SVGSVGElement {
  const svg = createSVG(20, 20);
  // Letter A
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', '10');
  text.setAttribute('y', '13.5');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-family', 'Inter, system-ui, sans-serif');
  text.setAttribute('font-size', '14');
  text.setAttribute('font-weight', '600');
  text.setAttribute('fill', 'currentColor');
  text.textContent = 'A';
  svg.appendChild(text);

  // Colored underline bar
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bar.setAttribute('x', '3');
  bar.setAttribute('y', '16.5');
  bar.setAttribute('width', '14');
  bar.setAttribute('height', '2.5');
  bar.setAttribute('rx', '1.25');
  bar.setAttribute('fill', color);
  svg.appendChild(bar);

  return svg;
}

/**
 * Chevron down icon - small dropdown indicator
 */
export function createChevronDownIcon(): SVGSVGElement {
  const svg = createSVG(10, 10);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 3.5L5 6.5L8 3.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * Minus icon - for size decrement
 */
export function createMinusIcon(): SVGSVGElement {
  const svg = createSVG(12, 12);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.5 6H9.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * Plus icon - for size increment
 */
export function createPlusIcon(): SVGSVGElement {
  const svg = createSVG(12, 12);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 2.5V9.5M2.5 6H9.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * Highlight icon - blocky chisel-tip marker with filled cap and colored bar (20x20)
 *
 * Anatomy (cap at upper-right, chisel nib at lower-left):
 *   Filled cap → barrel outline → flat chisel nib → color bar
 * The filled cap is the key cue that reads "marker" not "eraser".
 */
export function createHighlightIcon(color: string | null): SVGSVGElement {
  const svg = createSVG(20, 20);

  // Filled cap section (top ~35% of barrel — adds visual weight)
  const capFill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  capFill.setAttribute('d', 'M11.5 1.5L17 4.5L15 7.5L9.5 4.5Z');
  capFill.setAttribute('fill', 'currentColor');
  svg.appendChild(capFill);

  // Full marker outline: barrel + chisel nib as one continuous path
  // Barrel: parallel-sided rectangle at ~30deg tilt
  // Nib: flat chisel tip extending from barrel bottom-left
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', 'M11.5 1.5L17 4.5L12 13L5 14L6.5 10Z');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '1.3');
  outline.setAttribute('stroke-linejoin', 'round');
  outline.setAttribute('fill', 'none');
  svg.appendChild(outline);

  // Cap divider line (reinforces cap-barrel joint)
  const capLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  capLine.setAttribute('x1', '9.5');
  capLine.setAttribute('y1', '4.5');
  capLine.setAttribute('x2', '15');
  capLine.setAttribute('y2', '7.5');
  capLine.setAttribute('stroke', 'currentColor');
  capLine.setAttribute('stroke-width', '1');
  svg.appendChild(capLine);

  // Color bar at bottom (matches text color icon position)
  if (color === null) {
    const base = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    base.setAttribute('x', '3');
    base.setAttribute('y', '16.5');
    base.setAttribute('width', '14');
    base.setAttribute('height', '2.5');
    base.setAttribute('rx', '1.25');
    base.setAttribute('fill', '#d1d5db');
    svg.appendChild(base);

    for (let i = 0; i < 4; i++) {
      const block = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      block.setAttribute('x', String(4.5 + i * 3));
      block.setAttribute('y', '16.5');
      block.setAttribute('width', '1.5');
      block.setAttribute('height', '2.5');
      block.setAttribute('fill', '#e5e7eb');
      svg.appendChild(block);
    }
  } else {
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('x', '3');
    bar.setAttribute('y', '16.5');
    bar.setAttribute('width', '14');
    bar.setAttribute('height', '2.5');
    bar.setAttribute('rx', '1.25');
    bar.setAttribute('fill', color);
    svg.appendChild(bar);
  }

  return svg;
}

/**
 * More icon - three vertical dots
 */
export function createMoreIcon(): SVGSVGElement {
  const svg = createSVG();
  const dots = [4, 8, 12];
  for (const y of dots) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '8');
    circle.setAttribute('cy', String(y));
    circle.setAttribute('r', '1.5');
    circle.setAttribute('fill', 'currentColor');
    svg.appendChild(circle);
  }
  return svg;
}
