import type React from 'react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CanvasRuntime } from '@/runtime/CanvasRuntime';
import { contextMenuController } from '@/runtime/ContextMenuController';
import { ContextMenu } from './context-menu/ContextMenu';

export interface CanvasProps {
  className?: string;
}

/**
 * Canvas - Thin React wrapper for CanvasRuntime.
 *
 * Responsibilities:
 * - Mount DOM elements (canvases + editor host)
 * - Create/destroy CanvasRuntime on mount/unmount
 *
 * Room context is set by route beforeLoad via connectRoom().
 * All rendering, event handling, tool dispatch, snapshot subscription,
 * and cursor management is delegated to CanvasRuntime.
 */
export const Canvas: React.FC<CanvasProps> = ({ className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const cursorHostRef = useRef<HTMLDivElement>(null);

  // 1. Create and start CanvasRuntime
  // Runtime handles: render loops, input, snapshot subscription, cursor updates, editor host
  useLayoutEffect(() => {
    const container = containerRef.current;
    const gridCanvas = gridCanvasRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const editorHost = editorHostRef.current;
    const cursorHost = cursorHostRef.current;
    if (!container || !gridCanvas || !baseCanvas || !overlayCanvas || !editorHost || !cursorHost) return;

    const runtime = new CanvasRuntime();
    runtime.start({ container, gridCanvas, baseCanvas, overlayCanvas, editorHost, cursorHost });

    return () => {
      runtime.stop();
    };
  }, []);

  // 2. Context menu controller — binds portal div for positioning
  useLayoutEffect(() => {
    const el = document.getElementById('context-menu-portal');
    if (el) contextMenuController.init(el);
    return () => contextMenuController.destroy();
  }, []);

  return (
    <>
      <div ref={containerRef} className="relative w-full h-full overflow-hidden" style={{ backgroundColor: '#fafafa' }}>
        {/* Grid canvas (WebGPU/Canvas2D) — below all content. The container div supplies the
            #fafafa fill; the base canvas clears transparent, so the grid shows through between
            objects. Backing store is 0×0 until the grid is enabled (near-zero memory when off). */}
        <canvas
          ref={gridCanvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            display: 'block',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
        <canvas
          ref={baseCanvasRef}
          className={className}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            display: 'block',
            width: '100%',
            height: '100%',
            touchAction: 'none',
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'block',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
        <div
          ref={editorHostRef}
          className="dom-overlay-root"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            pointerEvents: 'none',
          }}
        />
        <div
          ref={cursorHostRef}
          className="cursor-host"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            pointerEvents: 'none',
            contain: 'layout style',
          }}
        />
      </div>
      {createPortal(<ContextMenu />, document.getElementById('context-menu-portal')!)}
    </>
  );
};
