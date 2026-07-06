import { VEIL_CAMERA, VEIL_INIT, type VeilMsg } from './veil-protocol';

/**
 * Lock-veil worker — owns the veil canvas (transferControlToOffscreen) and paints one
 * translucent grey rect per remote-locked bbox. Pure state machine: every message updates
 * typed-array/scalar state and redraws; message rate IS the frame rate (the main thread's
 * camera subscriber fires per pan/zoom frame, lock updates are event-driven), so no rAF.
 *
 * All rects accumulate into ONE path filled once — overlapping bboxes (marquee'd clusters)
 * cover uniformly instead of double-darkening. Backing store drops to 0×0 while no locks
 * are held (grid-canvas pattern).
 */

const VEIL_FILL = 'rgba(140, 140, 140, 0.3)';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let boxes = new Float64Array(0); // [minX,minY,maxX,maxY] × count, world units
let count = 0;
let scale = 1;
let panX = 0;
let panY = 0;
let dpr = 1;
let width = 0; // device px
let height = 0;

self.onmessage = (e: MessageEvent<VeilMsg>) => {
  const m = e.data;
  if (m.t === VEIL_INIT) {
    canvas = m.canvas;
    ctx = canvas.getContext('2d');
    return;
  }
  if (m.t === VEIL_CAMERA) {
    scale = m.s;
    panX = m.x;
    panY = m.y;
    dpr = m.d;
    width = m.w;
    height = m.h;
  } else {
    boxes = m.b;
    count = m.n;
  }
  draw();
};

function draw(): void {
  const c = canvas;
  const g = ctx;
  if (c === null || g === null) return;
  if (count === 0) {
    if (c.width !== 0) {
      c.width = 0; // release the backing store while idle
      c.height = 0;
    }
    return;
  }
  if (width === 0 || height === 0) return; // no camera yet

  if (c.width !== width || c.height !== height) {
    c.width = width; // resize clears + resets ctx state
    c.height = height;
  } else {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, width, height);
  }

  const k = dpr * scale;
  g.setTransform(k, 0, 0, k, -panX * k, -panY * k);

  // Visible world bounds — cull off-viewport rects (4 compares each).
  const vx0 = panX;
  const vy0 = panY;
  const vx1 = panX + width / k;
  const vy1 = panY + height / k;

  g.fillStyle = VEIL_FILL;
  g.beginPath();
  const b = boxes;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const x0 = b[o];
    const y0 = b[o + 1];
    const x1 = b[o + 2];
    const y1 = b[o + 3];
    if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
    g.rect(x0, y0, x1 - x0, y1 - y0);
  }
  g.fill();
}
