import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getObjectsById } from '@/runtime/room-runtime';
import { animateToFit, zoomIn, zoomOut, zoomTo } from '@/runtime/viewport/zoom';
import { useCameraStore } from '@/stores/camera-store';
import { IconHelp, IconMouseSettings, IconZoomMinus, IconZoomPlus, IconZoomToFit } from './icons';

import './ZoomControls.css';

// Keep focus on the canvas; suppresses text-selection from quick double-clicks.
const preventFocus = (e: MouseEvent) => e.preventDefault();

/**
 * Live zoom-% label, decoupled from React's render cycle.
 *
 * The camera store rewrites `scale` 60-120×/sec during wheel/pinch/animated
 * zoom. A React subscription would reconcile + commit the whole bar on every
 * write — and each commit dirties layout the wheel handler's own
 * `getBoundingClientRect()` then force-reflows. Instead: subscribe
 * imperatively, coalesce to one rAF per frame, write `textContent` directly.
 * Two gates keep writes minimal — skip pan-only camera writes, and skip
 * frames where the rounded percent is unchanged. Zero React renders during
 * zoom; no rAF scheduled while idle.
 */
function useZoomPercentLabel() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastScale = NaN;
    let lastPct = NaN;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const pct = Math.round(useCameraStore.getState().scale * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      el.textContent = `${pct}%`;
    };
    paint(); // initial fill before first paint (lastPct is NaN → always writes)
    const unsub = useCameraStore.subscribe((s) => {
      if (s.scale === lastScale) return; // pan-only write — nothing to repaint
      lastScale = s.scale;
      if (raf === 0) raf = requestAnimationFrame(paint);
    });
    return () => {
      unsub();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}

export function ZoomControls() {
  const [menuOpen, setMenuOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const pctRef = useZoomPercentLabel();

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpen]);

  function handleZoomToFit() {
    const objectsById = getObjectsById();
    if (!objectsById.size) {
      setMenuOpen(false);
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const handle of objectsById.values()) {
      const [bMinX, bMinY, bMaxX, bMaxY] = handle.bbox;
      if (bMinX < minX) minX = bMinX;
      if (bMinY < minY) minY = bMinY;
      if (bMaxX > maxX) maxX = bMaxX;
      if (bMaxY > maxY) maxY = bMaxY;
    }
    animateToFit({ minX, minY, maxX, maxY }, 80);
    setMenuOpen(false);
  }

  function handlePreset(targetScale: number) {
    zoomTo(targetScale);
    setMenuOpen(false);
  }

  return (
    <div className="zoom-bar" ref={barRef}>
      <button className="zoom-bar-btn" title="Mouse settings" onMouseDown={preventFocus}>
        <IconMouseSettings />
      </button>

      <div className="zoom-bar-divider" />

      <button className="zoom-bar-btn" onMouseDown={preventFocus} onClick={zoomOut} title="Zoom out">
        <IconZoomMinus />
      </button>

      <button
        className={`zoom-bar-pct${menuOpen ? ' active' : ''}`}
        onMouseDown={preventFocus}
        onClick={() => setMenuOpen((prev) => !prev)}
        title="Zoom presets"
      >
        <span ref={pctRef} />
      </button>

      <button className="zoom-bar-btn" onMouseDown={preventFocus} onClick={zoomIn} title="Zoom in">
        <IconZoomPlus />
      </button>

      <div className="zoom-bar-divider" />

      <button className="zoom-bar-btn" title="Help &amp; shortcuts" onMouseDown={preventFocus}>
        <IconHelp />
      </button>

      {menuOpen && (
        <div className="zoom-menu">
          <button className="zoom-menu-item" onMouseDown={preventFocus} onClick={handleZoomToFit}>
            <IconZoomToFit /> Zoom to fit
          </button>
          <div className="zoom-menu-divider" />
          <button className="zoom-menu-item" onMouseDown={preventFocus} onClick={() => handlePreset(0.5)}>
            Zoom to 50%
          </button>
          <button className="zoom-menu-item" onMouseDown={preventFocus} onClick={() => handlePreset(1)}>
            Zoom to 100%
          </button>
          <button className="zoom-menu-item" onMouseDown={preventFocus} onClick={() => handlePreset(1.5)}>
            Zoom to 150%
          </button>
          <button className="zoom-menu-item" onMouseDown={preventFocus} onClick={() => handlePreset(2)}>
            Zoom to 200%
          </button>
        </div>
      )}
    </div>
  );
}
