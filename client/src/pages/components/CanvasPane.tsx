import React, { useRef, useEffect, useCallback } from 'react';
import { Canvas } from '../../canvas/Canvas';

interface CanvasPaneProps {
  roomId: string;
  children?: React.ReactNode;
}

export function CanvasPane({ roomId, children }: CanvasPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle DPR scaling for crisp rendering
  const handleResize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    // Set CSS size
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    // Apply DPR scaling once
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  // Set up resize observer for responsive canvas
  useEffect(() => {
    let resizeObserver: ResizeObserver;

    if (containerRef.current) {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(containerRef.current);

      // Initial resize
      handleResize();
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [handleResize]);

  // Handle window resize as fallback
  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  return (
    <div ref={containerRef} className="canvas-container">
      {/* Grid Background */}
      <div className="canvas-grid" />

      {/* Main Canvas */}
      <Canvas roomId={roomId} className="canvas" />

      {/* Floating Elements */}
      {children}
    </div>
  );
}
