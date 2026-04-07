/**
 * Arrow Key Pan - Continuous canvas panning with arrow keys
 *
 * Module-level state tracking held arrow keys + own RAF loop.
 * keyboard-manager delegates arrow keydown/keyup here.
 *
 * @module canvas/arrow-key-pan
 */

import { useCameraStore } from '@/stores/camera-store';

const BASE_SPEED = 800; // CSS px/s at full acceleration
const RAMP_MS = 400; // Acceleration ramp duration
const START_FRACTION = 0.25; // Initial speed = 25% of base

const heldDirs = new Set<string>();
let rafId: number | null = null;
let startTime = 0;
let lastTime = 0;

function computeSpeed(now: number): number {
  const elapsed = now - startTime;
  const t = Math.min(1, elapsed / RAMP_MS);
  const factor = START_FRACTION + (1 - START_FRACTION) * t * t; // easeInQuad
  return BASE_SPEED * factor;
}

function tick(): void {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  let dx = 0,
    dy = 0;
  if (heldDirs.has('ArrowLeft')) dx -= 1;
  if (heldDirs.has('ArrowRight')) dx += 1;
  if (heldDirs.has('ArrowUp')) dy -= 1;
  if (heldDirs.has('ArrowDown')) dy += 1;

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) {
    stop();
    return;
  }
  dx /= len;
  dy /= len;

  const { scale, pan } = useCameraStore.getState();
  const worldSpeed = computeSpeed(now) / scale;

  useCameraStore.getState().setPan({
    x: pan.x + dx * worldSpeed * dt,
    y: pan.y + dy * worldSpeed * dt,
  });

  rafId = requestAnimationFrame(tick);
}

function stop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

export function startDirection(key: string): void {
  heldDirs.add(key);
  if (rafId === null) {
    startTime = performance.now();
    lastTime = startTime;
    rafId = requestAnimationFrame(tick);
  }
}

export function stopDirection(key: string): void {
  heldDirs.delete(key);
  if (heldDirs.size === 0) stop();
}

export function stopAll(): void {
  heldDirs.clear();
  stop();
}
