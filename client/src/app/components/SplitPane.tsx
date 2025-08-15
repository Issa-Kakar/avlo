// Resizer is keyboard accessible; ratio persisted to localStorage.
import React, { useState, useEffect, useRef, useCallback } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initialRatio?: number;
  storageKey?: string;
}

export function SplitPane({
  left,
  right,
  initialRatio = 0.7,
  storageKey = 'split',
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? parseFloat(stored) : initialRatio;
  });
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    localStorage.setItem(storageKey, ratio.toString());
  }, [ratio, storageKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newRatio = Math.max(0.2, Math.min(0.8, (e.clientX - rect.left) / rect.width));
      setRatio(newRatio);
    },
    [isDragging],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = 0.02;
    if (e.key === 'ArrowLeft') {
      setRatio((r) => Math.max(0.2, r - step));
    } else if (e.key === 'ArrowRight') {
      setRatio((r) => Math.min(0.8, r + step));
    } else if (e.key === 'Escape') {
      (e.target as HTMLElement).blur();
    }
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `${ratio}fr ${1 - ratio}fr`,
        height: '100%',
        position: 'relative',
      }}
    >
      <div style={{ overflow: 'hidden' }}>{left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        data-testid="split-resizer"
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        style={{
          position: 'absolute',
          left: `${ratio * 100}%`,
          top: 0,
          bottom: 0,
          width: '4px',
          marginLeft: '-2px',
          backgroundColor: isDragging ? 'var(--accent)' : 'var(--border)',
          cursor: 'col-resize',
          transition: isDragging ? 'none' : 'background-color 150ms',
          zIndex: 10,
        }}
      />
      <div style={{ overflow: 'hidden' }}>{right}</div>
    </div>
  );
}
