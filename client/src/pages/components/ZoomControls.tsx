import React from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';

interface ZoomControlsProps {
  className?: string;
}

export function ZoomControls({ className = '' }: ZoomControlsProps) {
  const { zoom, setZoom } = useDeviceUIStore();

  const handleZoomIn = () => {
    const newZoom = Math.min(2.0, zoom + 0.25);
    setZoom(newZoom);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(0.25, zoom - 0.25);
    setZoom(newZoom);
  };

  const handleZoomReset = () => {
    setZoom(1.0);
  };

  const zoomPercentage = Math.round(zoom * 100);

  return (
    <div className={`floating-controls ${className}`}>
      <div className="zoom-controls">
        <button
          className="zoom-btn"
          onClick={handleZoomOut}
          disabled={zoom <= 0.25}
          aria-label="Zoom out"
          title="Zoom Out"
        >
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        <button
          className="zoom-label"
          onClick={handleZoomReset}
          title="Reset zoom to 100%"
          style={{ cursor: 'pointer' }}
          aria-label={`Current zoom: ${zoomPercentage}%. Click to reset.`}
        >
          {zoomPercentage}%
        </button>

        <button
          className="zoom-btn"
          onClick={handleZoomIn}
          disabled={zoom >= 2.0}
          aria-label="Zoom in"
          title="Zoom In"
        >
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12" />
            <line x1="12" y1="5" x2="12" y2="19" />
          </svg>
        </button>
      </div>
    </div>
  );
}
