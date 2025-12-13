import React, { useRef, useEffect, useLayoutEffect } from 'react';
import type { RoomId } from '@avlo/shared';
import { useRoomDoc } from '../hooks/use-room-doc';
import { getObjectCacheInstance } from '../renderer/object-cache';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getVisibleWorldBounds } from '@/stores/camera-store';
import { boundsIntersect } from './internal/transforms';
import { CanvasRuntime } from './CanvasRuntime';
import { setActiveRoom } from './room-runtime';
import { setEditorHost } from './editor-host-registry';
import { applyCursor } from './cursor-manager';
import { invalidateWorld, holdPreviewForOneFrame, invalidateOverlay } from './invalidation-helpers';

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
 * - Subscribe to snapshots for dirty rect invalidation
 * - Create/destroy CanvasRuntime on mount/unmount
 *
 * All rendering, event handling, and tool dispatch is delegated to CanvasRuntime.
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

  // 2. Set editor host for TextTool DOM access
  useLayoutEffect(() => {
    setEditorHost(editorHostRef.current);
    return () => setEditorHost(null);
  }, []);

  // 3. Create and start CanvasRuntime
  useLayoutEffect(() => {
    const container = containerRef.current;
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!container || !baseCanvas || !overlayCanvas) return;

    const runtime = new CanvasRuntime();
    runtimeRef.current = runtime;
    runtime.start({ container, baseCanvas, overlayCanvas });

    return () => {
      runtime.stop();
      runtimeRef.current = null;
      getObjectCacheInstance().clear();
    };
  }, []);

  // 4. Subscribe to snapshots for dirty rect invalidation
  useEffect(() => {
    let lastDocVersion = -1;

    const unsubscribe = roomDoc.subscribeSnapshot((snapshot) => {
      if (!runtimeRef.current) return;

      // Check if document content changed (not just presence)
      if (snapshot.docVersion !== lastDocVersion) {
        lastDocVersion = snapshot.docVersion;

        // Hold preview for one frame to prevent flash on commit
        holdPreviewForOneFrame();

        // Process dirty patch from manager
        if (snapshot.dirtyPatch) {
          const { rects, evictIds } = snapshot.dirtyPatch;

          // Evict from cache
          const cache = getObjectCacheInstance();
          cache.evictMany(evictIds);

          // Only invalidate visible dirty regions
          const viewport = getVisibleWorldBounds();
          for (const bounds of rects) {
            if (boundsIntersect(bounds, viewport)) {
              invalidateWorld(bounds);
            }
          }
        } else if (lastDocVersion < 2) {
          invalidateWorld(getVisibleWorldBounds());
          // Initial load without dirtyPatch - full invalidation handled by runtime
        }

        // Update overlay for new doc content
        invalidateOverlay();
      } else {
        // Presence-only change - update overlay only
        invalidateOverlay();
      }
    });

    // Initialize with current snapshot
    lastDocVersion = roomDoc.currentSnapshot.docVersion;

    return unsubscribe;
  }, [roomDoc]);

  // 5. Update cursor on tool switch
  const activeTool = useDeviceUIStore((s) => s.activeTool);
  useLayoutEffect(() => {
    applyCursor();
  }, [activeTool]);

  return (
    <div ref={containerRef} className="relative w-full h-full" style={{ backgroundColor: '#FFFFFF' }}>
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
  );
};
