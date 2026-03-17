import React, { useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { RoomId } from '@avlo/shared';
import { useRoomDoc } from '../hooks/use-room-doc';
import { CanvasRuntime } from './CanvasRuntime';
import { setActiveRoom } from './room-runtime';
import { contextMenuController } from './ContextMenuController';
import { ContextMenu } from '@/components/context-menu/ContextMenu';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

/**
 * Canvas - Thin React wrapper for CanvasRuntime.
 *
 * Responsibilities:
 * - Mount DOM elements (canvases + editor host)
 * - Set room context (tools need getActiveRoomDoc())
 * - Set editor host (TextTool needs DOM mounting)
 * - Create/destroy CanvasRuntime on mount/unmount
 *
 * All rendering, event handling, tool dispatch, snapshot subscription,
 * and cursor management is delegated to CanvasRuntime.
 */
export const Canvas: React.FC<CanvasProps> = ({ roomId, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CanvasRuntime | null>(null);

  // Get roomDoc from hook (must be at top level)
  const roomDoc = useRoomDoc(roomId);

  // 1. Set active room context for imperative access
  // Tools and render loops use getActiveRoomDoc() to access Y.Doc
  useLayoutEffect(() => {
    setActiveRoom({ roomId, roomDoc });
    return () => setActiveRoom(null);
  }, [roomId, roomDoc]);

  // 2. Create and start CanvasRuntime
  // Runtime handles: render loops, input, snapshot subscription, cursor updates, editor host
  useLayoutEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const editorHost = editorHostRef.current;
    if (!container || !baseCanvas || !overlayCanvas || !editorHost) return;

    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;
    runtime.start({ container, baseCanvas, overlayCanvas, editorHost });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, []);

  // 3. Context menu controller — binds portal div for positioning
  useLayoutEffect(() => {
    const el = document.getElementById('context-menu-portal');
    if (el) contextMenuController.init(el);
    return () => contextMenuController.destroy();
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        className="relative w-full h-full overflow-hidden"
        style={{ backgroundColor: '#FFFFFF' }}
      >
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
      </div>
      {createPortal(<ContextMenu />, document.getElementById('context-menu-portal')!)}
    </>
  );
};
