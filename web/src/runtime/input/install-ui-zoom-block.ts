/**
 * Canvas-page page-zoom block.
 *
 * Browsers zoom the entire page on Ctrl/⌘ + wheel, Ctrl/⌘ + (+/-/=/0), and
 * Safari pinch gestures. The canvas-scoped wheel handler in `InputManager`
 * only covers its own DOM subtree; `keyboard-manager` short-circuits while
 * any input has focus. This installs three window-level capture-phase
 * listeners that block the browser default everywhere without consuming
 * the event (no `stopPropagation`), so the canvas wheel handler still runs.
 *
 * Scoped to the canvas room: CanvasRuntime invokes on start, calls the
 * returned disposer on stop. Non-canvas routes (landing, lists) keep
 * native browser zoom — the policy is "this page is a canvas page", not
 * "this app is".
 *
 * Also toggles `html.canvas-room`, which `index.css` uses to scope the
 * `touch-action`/`overscroll-behavior` policy (mobile pinch + pull-to-refresh).
 */
export function installUIZoomBlock(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key;
    if (k === '+' || k === '-' || k === '=' || k === '0') e.preventDefault();
  };

  const onGesture = (e: Event) => e.preventDefault();

  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('keydown', onKey, { capture: true });
  // `gesturestart` is Safari-only and not declared in WindowEventMap.
  (window as EventTarget).addEventListener('gesturestart', onGesture, { passive: false });

  document.documentElement.classList.add('canvas-room');

  return () => {
    window.removeEventListener('wheel', onWheel, { capture: true });
    window.removeEventListener('keydown', onKey, { capture: true });
    (window as EventTarget).removeEventListener('gesturestart', onGesture);
    document.documentElement.classList.remove('canvas-room');
  };
}
