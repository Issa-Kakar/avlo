import React from 'react';
import { useViewTransform } from '../../canvas/ViewTransformContext';
import { PERFORMANCE_CONFIG } from '@avlo/shared';

interface ZoomControlsProps {
  className?: string;
}

export function ZoomControls({ className = '' }: ZoomControlsProps) {
  const { viewState, setScale, resetView } = useViewTransform();

  const handleZoomIn = () => {
    const newScale = Math.min(viewState.scale * 1.2, PERFORMANCE_CONFIG.MAX_ZOOM);
    setScale(newScale);
  };

  const handleZoomOut = () => {
    const newScale = Math.max(viewState.scale / 1.2, PERFORMANCE_CONFIG.MIN_ZOOM);
    setScale(newScale);
  };

  const handleZoomReset = () => {
    resetView();
  };

  const zoomPercentage = Math.round(viewState.scale * 100);

  return (
    <div className={`floating-controls ${className}`}>
      <div className="zoom-controls">
        <button
          className="zoom-btn"
          onClick={handleZoomOut}
          disabled={viewState.scale <= PERFORMANCE_CONFIG.MIN_ZOOM}
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
          disabled={viewState.scale >= PERFORMANCE_CONFIG.MAX_ZOOM}
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
