import { clampScale, calculateZoomTransform } from '../internal/transforms';
import { useCameraStore } from '@/stores/camera-store';

/**
 * Module-level animated zoom with fixed zoom steps for buttons.
 * Reads and writes directly to the camera store.
 */

const DURATION = 180; // ms

// Predefined button zoom steps — clean percentages, roughly log-spaced
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
const STEP_EPS = 0.005; // Tolerance for "at this step" comparisons

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// --- Animation state ---
let rafId: number | null = null;
let startTime = 0;
let startScale = 1;
let startPan = { x: 0, y: 0 };
let tgtScale = 1;
let tgtPan = { x: 0, y: 0 };
let pendingStep: number | null = null; // Accumulates rapid clicks

function tick(): void {
  const t = Math.min((performance.now() - startTime) / DURATION, 1);
  const e = easeOutCubic(t);

  const scale = startScale + (tgtScale - startScale) * e;
  const pan = {
    x: startPan.x + (tgtPan.x - startPan.x) * e,
    y: startPan.y + (tgtPan.y - startPan.y) * e,
  };

  useCameraStore.getState().setScaleAndPan(scale, pan);

  if (t < 1) {
    rafId = requestAnimationFrame(tick);
  } else {
    rafId = null;
    pendingStep = null;
  }
}

// --- Step finding ---

function nextZoomStep(scale: number): number {
  for (const step of ZOOM_STEPS) {
    if (step > scale + STEP_EPS) return step;
  }
  return ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

function prevZoomStep(scale: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < scale - STEP_EPS) return ZOOM_STEPS[i];
  }
  return ZOOM_STEPS[0];
}

/** Compute center-preserving zoom target for a given target scale. */
function centerZoomTarget(targetScale: number): { scale: number; pan: { x: number; y: number } } {
  const { scale, pan, cssWidth, cssHeight } = useCameraStore.getState();
  const center = { x: cssWidth / 2, y: cssHeight / 2 };
  return calculateZoomTransform(scale, pan, targetScale / scale, center);
}

// --- Public API ---

/** Animate to target scale + pan. Retargets seamlessly if called mid-animation. */
export function animateZoom(toScale: number, toPan: { x: number; y: number }): void {
  const { scale, pan } = useCameraStore.getState();
  startScale = scale;
  startPan = { x: pan.x, y: pan.y };
  tgtScale = clampScale(toScale);
  tgtPan = toPan;
  startTime = performance.now();

  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

/** Zoom in one step toward viewport center. Rapid clicks accumulate. */
export function zoomIn(): void {
  const { scale } = useCameraStore.getState();
  // If a pending step is ahead of current, use it as base (rapid click accumulation)
  const base = (pendingStep !== null && pendingStep > scale + STEP_EPS) ? pendingStep : scale;
  const targetScale = nextZoomStep(base);
  if (targetScale <= scale + STEP_EPS) return;
  pendingStep = targetScale;
  const target = centerZoomTarget(targetScale);
  animateZoom(target.scale, target.pan);
}

/** Zoom out one step toward viewport center. Rapid clicks accumulate. */
export function zoomOut(): void {
  const { scale } = useCameraStore.getState();
  const base = (pendingStep !== null && pendingStep < scale - STEP_EPS) ? pendingStep : scale;
  const targetScale = prevZoomStep(base);
  if (targetScale >= scale - STEP_EPS) return;
  pendingStep = targetScale;
  const target = centerZoomTarget(targetScale);
  animateZoom(target.scale, target.pan);
}

/** Animated reset to scale=1, pan={0,0}. */
export function animateZoomReset(): void {
  pendingStep = 1;
  animateZoom(1, { x: 0, y: 0 });
}

/** Animate camera to fit given world bounds with padding.
 *  maxScale caps zoom (pass current scale to only zoom out).
 *  minScale floors zoom (prevents extreme zoom-out on huge content). */
export function animateToFit(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding = 80,
  maxScale = Infinity,
  minScale = 0,
): void {
  const { cssWidth, cssHeight } = useCameraStore.getState();
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  if (bw <= 0 || bh <= 0) return;
  let fitScale = Math.min((cssWidth - padding * 2) / bw, (cssHeight - padding * 2) / bh);
  // Apply floor then cap: ensures "never zoom in" wins over floor when currentScale < minScale
  fitScale = clampScale(Math.min(Math.max(fitScale, minScale), maxScale));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  animateZoom(fitScale, { x: cx - cssWidth / (2 * fitScale), y: cy - cssHeight / (2 * fitScale) });
}

/** Cancel any in-progress zoom animation. */
export function cancelZoom(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingStep = null;
}
