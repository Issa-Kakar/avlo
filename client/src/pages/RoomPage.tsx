/**
 * RoomPage Component - Phase 6 to 7 Integration
 *
 * Main room page that hosts the collaborative whiteboard.
 * Extracted from the test harness with proper structure for production use.
 */

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { RoomDocRegistryProvider } from '../lib/room-doc-registry-context';
import { ViewTransformProvider, useViewTransform } from '../canvas/ViewTransformContext';
import { Canvas } from '../canvas/Canvas';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useRoomSnapshot } from '../hooks/use-room-snapshot';
import { useConnectionGates } from '../hooks/use-connection-gates';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { MobileViewOnlyBanner } from '../components/MobileViewOnlyBanner';
import { ClearBoardButton } from '../components/ClearBoardButton';
import { Toolbar } from '../components/Toolbar/Toolbar';
import { ErrorBoundary } from '../components/ErrorBoundary';

interface RoomCanvasProps {
  roomId: string;
}

function RoomCanvas({ roomId }: RoomCanvasProps) {
  const room = useRoomDoc(roomId);
  const snapshot = useRoomSnapshot(roomId);
  const { viewState, setScale, setPan, resetView } = useViewTransform();
  const { isOnline } = useConnectionGates(roomId);

  // Reset view transform when roomId changes
  useEffect(() => {
    resetView();
  }, [roomId, resetView]);

  const handleZoomIn = () => {
    setScale(viewState.scale * 1.2);
  };

  const handleZoomOut = () => {
    setScale(viewState.scale / 1.2);
  };

  const handlePan = (dx: number, dy: number) => {
    setPan({
      x: viewState.pan.x + dx,
      y: viewState.pan.y + dy,
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Mobile View-Only Banner */}
      <MobileViewOnlyBanner />

      {/* Connection Banner */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-2 z-40">
          <p className="text-sm text-amber-800 text-center">
            📵 Offline - Your changes are saved locally
          </p>
        </div>
      )}

      {/* Room Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 z-30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold text-gray-800">Room: {roomId}</h1>
            <ConnectionStatus roomId={roomId} />
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">Scene: {snapshot.scene}</span>
            <span className="text-xs text-gray-500">Strokes: {snapshot.strokes.length}</span>
            <ClearBoardButton
              room={room}
              roomId={roomId}
              scene={snapshot.scene}
              className="text-sm"
            />
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex relative">
        {/* Toolbar */}
        <Toolbar className="w-64 flex-shrink-0" />

        {/* Canvas Container */}
        <div className="flex-1 relative">
          {/* Zoom Controls */}
          <div className="absolute top-4 right-4 bg-white rounded-lg shadow-md p-2 z-20 flex gap-1">
            <button
              onClick={handleZoomOut}
              className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
              title="Zoom Out"
            >
              −
            </button>
            <span className="px-2 py-1 text-sm text-gray-600 min-w-[60px] text-center">
              {Math.round(viewState.scale * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
              title="Zoom In"
            >
              +
            </button>
            <button
              onClick={resetView}
              className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors ml-2"
              title="Reset View"
            >
              Reset
            </button>
          </div>

          {/* Pan Controls */}
          <div className="absolute bottom-4 right-4 bg-white rounded-lg shadow-md p-2 z-20">
            <div className="grid grid-cols-3 gap-1">
              <div></div>
              <button
                onClick={() => handlePan(0, -50)}
                className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
                title="Pan Up"
              >
                ↑
              </button>
              <div></div>
              <button
                onClick={() => handlePan(-50, 0)}
                className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
                title="Pan Left"
              >
                ←
              </button>
              <button
                onClick={() => handlePan(0, 0)}
                className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
                title="Center"
              >
                ●
              </button>
              <button
                onClick={() => handlePan(50, 0)}
                className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
                title="Pan Right"
              >
                →
              </button>
              <div></div>
              <button
                onClick={() => handlePan(0, 50)}
                className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
                title="Pan Down"
              >
                ↓
              </button>
              <div></div>
            </div>
          </div>

          {/* Canvas */}
          <Canvas roomId={roomId} className="w-full h-full" />
        </div>
      </div>
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();

  if (!roomId) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-700">Invalid Room</h1>
          <p className="text-gray-500 mt-2">No room ID provided</p>
        </div>
      </div>
    );
  }

  // Parse query parameters to check for persist=0 flag (dev feature)
  const urlParams = new URLSearchParams(window.location.search);
  const skipIndexedDB = urlParams.get('persist') === '0';

  return (
    <ErrorBoundary>
      <RoomDocRegistryProvider skipIndexedDB={skipIndexedDB}>
        <ViewTransformProvider>
          <RoomCanvas roomId={roomId} />
        </ViewTransformProvider>
      </RoomDocRegistryProvider>
    </ErrorBoundary>
  );
}
