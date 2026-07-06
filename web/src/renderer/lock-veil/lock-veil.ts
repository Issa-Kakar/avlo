import { forEachRemoteLockedId, hasRemoteLocks, remoteLockedCount } from '@/core/locks/lock-table';
import { getObjectsById } from '@/runtime/room-runtime';
import { getCanvasElement, subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { VEIL_BOXES, VEIL_CAMERA, VEIL_INIT, type VeilMsg } from './veil-protocol';

/**
 * Lock veil — main-thread half. A dedicated worker-owned canvas layer (between the base
 * canvas and the overlay: same z-index as base, inserted DOM-after it) paints a grey filter
 * rect over every remote-locked bbox. The main thread only ships state:
 *
 *   lock events / locked-geometry changes → microtask-coalesced bbox gather → one
 *     transferred Float64Array (an observer fire touching N locked objects posts once)
 *   camera fires (only while locks are held — one compare when idle) → tiny scalar message
 *
 * No overlay coupling, no base dirty rects, no main-thread veil painting; the browser
 * composites the layer. Worker + canvas are session-scoped (image-pool pattern) and created
 * lazily on the first remote lock; the element survives room remounts (a transferred canvas
 * keeps displaying the worker's frames across DOM re-insertion) and re-inserts itself next
 * to the live room's base canvas. `notifyLockVeil` is a hoisted function handed to
 * `bindLockTable`, keeping the lock table a leaf module.
 */

const EMPTY_BOXES = new Float64Array(0);

let worker: Worker | null = null;
let veilCanvas: HTMLCanvasElement | null = null;
let scheduled = false;

/** Injected into the lock table by RoomDocManager (`bindLockTable`). */
export function notifyLockVeil(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flushVeil);
}

function flushVeil(): void {
  scheduled = false;

  if (!hasRemoteLocks()) {
    // Nothing to show. Hide the placeholder element here — a transferred canvas resized to
    // 0×0 releases its buffer but does NOT push a blank frame, so the placeholder would
    // keep compositing the last drawn veil. Visibility is main-controlled (deterministic);
    // the worker's 0×0 is purely the memory release. (EMPTY_BOXES is cloned, not
    // transferred — a transferred buffer couldn't be reused.)
    if (veilCanvas !== null) veilCanvas.style.display = 'none';
    worker?.postMessage({ t: VEIL_BOXES, b: EMPTY_BOXES, n: 0 } satisfies VeilMsg);
    return;
  }

  ensureVeil();
  ensureMounted();
  if (veilCanvas !== null) veilCanvas.style.display = 'block';
  postCamera();

  const boxes = new Float64Array(remoteLockedCount() * 4);
  const byId = getObjectsById();
  let n = 0;
  forEachRemoteLockedId((id) => {
    const handle = byId.get(id);
    if (handle === undefined) return;
    const b = handle.bbox;
    const o = n * 4;
    boxes[o] = b[0];
    boxes[o + 1] = b[1];
    boxes[o + 2] = b[2];
    boxes[o + 3] = b[3];
    n++;
  });
  worker?.postMessage({ t: VEIL_BOXES, b: boxes, n } satisfies VeilMsg, [boxes.buffer]);
}

function postCamera(): void {
  const w = worker;
  if (w === null) return;
  const { scale, pan, dpr, cssWidth, cssHeight } = useCameraStore.getState();
  w.postMessage({
    t: VEIL_CAMERA,
    s: scale,
    x: pan.x,
    y: pan.y,
    d: dpr,
    w: (cssWidth * dpr) | 0,
    h: (cssHeight * dpr) | 0,
  } satisfies VeilMsg);
}

function ensureVeil(): void {
  if (worker !== null) return;

  const canvas = document.createElement('canvas');
  const s = canvas.style;
  s.position = 'absolute';
  s.inset = '0';
  s.zIndex = '1'; // inserted DOM-after the base canvas (z:1) → above base, below overlay (z:2)
  s.display = 'block';
  s.width = '100%';
  s.height = '100%';
  s.pointerEvents = 'none';
  veilCanvas = canvas;

  const off = canvas.transferControlToOffscreen();
  worker = new Worker(new URL('./lock-veil-worker.ts', import.meta.url), { type: 'module' });
  worker.postMessage({ t: VEIL_INIT, canvas: off } satisfies VeilMsg, [off]);

  // Permanent subscription (session-scoped, like the worker) — one compare when idle.
  // Also re-mounts after a room remount: the camera fires as the new canvas sizes up.
  subscribeCamera(() => {
    if (!hasRemoteLocks()) return;
    ensureMounted();
    postCamera();
  });
}

function ensureMounted(): void {
  const veil = veilCanvas;
  if (veil === null || veil.isConnected) return;
  getCanvasElement()?.insertAdjacentElement('afterend', veil);
}
