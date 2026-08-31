/**
 * Trackpad Pan — two-finger scroll panning for trackpad input mode.
 *
 * Direct 1:1 viewport pan per wheel event, nothing else. Momentum is the OS's
 * job, not ours: macOS trackpads and Windows Precision Touchpads keep emitting a
 * decaying stream of wheel events after liftoff (the momentum phase), so panning
 * on them directly glides for free with a native feel. Platforms with no OS
 * inertia (native Linux) simply stop dead on release — no synthetic coast.
 *
 * We deliberately do NOT fabricate momentum. A synthesized coast is unfixably
 * problematic here: (1) stacked on top of OS inertia it double-counts and the
 * canvas flies away; (2) there is no "wheel-up" event to trigger from, so it must
 * infer stream-end via an idle timeout — a ~120ms freeze that then lurches back
 * into motion, a visible stutter on settle; (3) telling a trackpad from a mouse
 * needs a device signal the `wheel` event does not carry (integer/vertical-only
 * deltas are ambiguous on Linux, and browser zoom / display scaling makes even a
 * mouse report fractional deltas). PanTool coasts cleanly only because a pointer
 * gives it `pointerup` + `pointerType` for free; the wheel path has neither.
 *
 * Pans via setPanXY directly — touches no tool/cursor/capture state (a viewport
 * scroll, unlike an MMB grab). Sign is `+` (delta-derived), the opposite of
 * PanTool's `−` (cursor-derived). Respects the OS natural-scroll setting.
 *
 * @module runtime/viewport/trackpad-pan
 */

import { useCameraStore } from '@/stores/camera-store';

/** Apply one plain (non-ctrl) wheel event in trackpad mode: pan the viewport 1:1. */
export function applyTrackpadPan(dX: number, dY: number): void {
  const { scale, pan, setPanXY } = useCameraStore.getState();
  // Sign is `+` (delta-derived) — opposite of PanTool's `−` (cursor-derived).
  setPanXY(pan.x + dX / scale, pan.y + dY / scale);
}
