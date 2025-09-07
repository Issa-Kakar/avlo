import React from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';

interface MinimapProps {
  className?: string;
}

export function Minimap({ className = '' }: MinimapProps) {
  const { minimapCollapsed, toggleMinimap } = useDeviceUIStore();

  const handleToggle = () => {
    toggleMinimap();
  };

  const handlePillClick = () => {
    // When pill is clicked, expand the minimap
    if (minimapCollapsed) {
      toggleMinimap();
    }
  };

  if (minimapCollapsed) {
    return (
      <div className={`minimap collapsed ${className}`}>
        <div className="minimap-header">
          <span className="minimap-title">Minimap</span>
          <button className="minimap-toggle" onClick={handlePillClick} aria-label="Expand minimap">
            <svg className="icon icon-sm" viewBox="0 0 24 24">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`minimap ${className}`}>
      <div className="minimap-header">
        <span className="minimap-title">Minimap</span>
        <button className="minimap-toggle" onClick={handleToggle} aria-label="Collapse minimap">
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      <div className="minimap-content">
        {/* Static viewport rect for Phase 9 */}
        <div
          className="minimap-viewport"
          style={{
            width: '60px',
            height: '40px',
            top: '20px',
            left: '40px',
          }}
        />

        {/* Future: Render miniature version of canvas content */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--text-tertiary)',
            fontSize: 'var(--text-xs)',
            pointerEvents: 'none',
          }}
        >
          Preview
        </div>
      </div>
    </div>
  );
}
