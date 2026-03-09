/**
 * Edge Scrolling - Auto-pan when pointer nears viewport edge during drag
 *
 * Eligible tools: select, connector, shape (not pen/highlighter/eraser/text/pan).
 * Proximity-squared for fine-grained control + delay + easeInQuad ramp.
 *
 * @module canvas/edge-scroll
 */

import { useCameraStore, screenToWorld, getCanvasRect } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getCurrentTool } from './tool-registry';
import { setLastCursorWorld } from './cursor-tracking';

const EDGE_ZONE = 40; // CSS px from each viewport edge
const DELAY_MS = 120; // Wait before scrolling starts
const EASE_MS = 300; // Acceleration ramp after delay
const BASE_SPEED = 9; // CSS px per 16ms tick at proximity=1 (~540 px/s max)
const SMALL_SCREEN = 1000; // Viewport dimension below which speed reduces
const SMALL_FACTOR = 0.65; // Speed multiplier for small viewport dimension

let lastClientX = 0,
  lastClientY = 0;
let proxX = 0,
  proxY = 0;
let enterTime = 0;
let rafId: number | null = null;
let active = false;

function isEligible(): boolean {
  const tool = getCurrentTool();
  if (!tool?.isActive()) return false;
  const at = useDeviceUIStore.getState().activeTool;
  return at === 'select' || at === 'connector' || at === 'shape';
}

function computeProximity(pos: number, size: number): number {
  if (pos < 0) return -1;
  if (pos > size) return 1;
  if (pos < EDGE_ZONE) return -(1 - pos / EDGE_ZONE);
  if (pos > size - EDGE_ZONE) return 1 - (size - pos) / EDGE_ZONE;
  return 0;
}

function tick(): void {
  if (!isEligible() || (proxX === 0 && proxY === 0)) {
    stop();
    return;
  }

  const now = performance.now();
  const sinceEntry = now - enterTime;

  // Delay phase
  if (sinceEntry < DELAY_MS) {
    rafId = requestAnimationFrame(tick);
    return;
  }

  // Ease-in phase (easeInQuad — gentler than cubic)
  const sinceScroll = sinceEntry - DELAY_MS;
  const easeT = Math.min(1, sinceScroll / EASE_MS);
  const easeFactor = easeT * easeT;

  // Proximity squared: fine-grained control at low proximity, steeper at edge
  const px = Math.abs(proxX);
  const py = Math.abs(proxY);
  const { scale, pan } = useCameraStore.getState();
  const rect = getCanvasRect()!;
  const factorX = px * px * easeFactor * (rect.width < SMALL_SCREEN ? SMALL_FACTOR : 1);
  const factorY = py * py * easeFactor * (rect.height < SMALL_SCREEN ? SMALL_FACTOR : 1);

  const dx = (Math.sign(proxX) * BASE_SPEED * factorX) / scale;
  const dy = (Math.sign(proxY) * BASE_SPEED * factorY) / scale;

  if (dx !== 0 || dy !== 0) {
    useCameraStore.getState().setPan({ x: pan.x + dx, y: pan.y + dy });

    const world = screenToWorld(lastClientX, lastClientY);
    if (world) {
      setLastCursorWorld(world);
      getCurrentTool()?.move(world[0], world[1]);
    }
  }

  active = true;
  rafId = requestAnimationFrame(tick);
}

function stop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  proxX = proxY = 0;
  active = false;
}

export function updateEdgeScroll(clientX: number, clientY: number): void {
  lastClientX = clientX;
  lastClientY = clientY;

  if (!isEligible()) {
    stop();
    return;
  }

  const rect = getCanvasRect();
  if (!rect) {
    stop();
    return;
  }

  proxX = computeProximity(clientX - rect.left, rect.width);
  proxY = computeProximity(clientY - rect.top, rect.height);

  if (proxX === 0 && proxY === 0) {
    stop();
  } else if (rafId === null) {
    enterTime = performance.now();
    active = false;
    rafId = requestAnimationFrame(tick);
  }
}

export function stopEdgeScroll(): void {
  stop();
}

export function isEdgeScrolling(): boolean {
  return active;
}
