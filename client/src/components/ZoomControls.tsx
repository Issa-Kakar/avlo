import { useState, useEffect, useRef } from 'react';
import { useCameraStore, selectScale, MIN_ZOOM, MAX_ZOOM } from '@/stores/camera-store';
import { zoomIn, zoomOut, zoomTo, animateToFit } from '@/canvas/animation';
import { getCurrentSnapshot } from '@/canvas/room-runtime';
import { IconZoomPlus, IconZoomMinus, IconZoomToFit, IconHelp, IconMouseSettings } from './icons';

import './ZoomControls.css';

export function ZoomControls() {
  const scale = useCameraStore(selectScale);
  const zoomPercentage = Math.round(scale * 100);
  const [menuOpen, setMenuOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

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
    const snapshot = getCurrentSnapshot();
    if (!snapshot.objectsById.size) {
      setMenuOpen(false);
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const handle of snapshot.objectsById.values()) {
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
      <button className="zoom-bar-btn" title="Mouse settings">
        <IconMouseSettings />
      </button>

      <div className="zoom-bar-divider" />

      <button
        className="zoom-bar-btn"
        onClick={zoomOut}
        disabled={scale <= MIN_ZOOM}
        title="Zoom out"
      >
        <IconZoomMinus />
      </button>

      <button
        className={`zoom-bar-pct${menuOpen ? ' active' : ''}`}
        onClick={() => setMenuOpen((prev) => !prev)}
        title="Zoom presets"
      >
        {zoomPercentage}%
      </button>

      <button
        className="zoom-bar-btn"
        onClick={zoomIn}
        disabled={scale >= MAX_ZOOM}
        title="Zoom in"
      >
        <IconZoomPlus />
      </button>

      <div className="zoom-bar-divider" />

      <button className="zoom-bar-btn" title="Help &amp; shortcuts">
        <IconHelp />
      </button>

      {menuOpen && (
        <div className="zoom-menu">
          <button className="zoom-menu-item" onClick={handleZoomToFit}>
            <IconZoomToFit /> Zoom to fit
          </button>
          <div className="zoom-menu-divider" />
          <button className="zoom-menu-item" onClick={() => handlePreset(0.5)}>
            Zoom to 50%
          </button>
          <button className="zoom-menu-item" onClick={() => handlePreset(1)}>
            Zoom to 100%
          </button>
          <button className="zoom-menu-item" onClick={() => handlePreset(1.5)}>
            Zoom to 150%
          </button>
          <button className="zoom-menu-item" onClick={() => handlePreset(2)}>
            Zoom to 200%
          </button>
        </div>
      )}
    </div>
  );
}
