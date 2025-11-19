/**
 * DEVELOPMENT TEST HARNESS
 *
 * This is a visual test component for local development only.
 * It allows manual testing of the drawing system without running unit tests.
 *
 * NOTE: Uses type assertions (as any) for Y.Doc access - this is intentional
 * for this dev-only component. Production code should never do this.
 */

import { Routes, Route } from 'react-router-dom';
import { RoomDocRegistryProvider } from './lib/room-doc-registry-context';
import { ViewTransformProvider, useViewTransform } from './canvas/ViewTransformContext';
import { Canvas } from './canvas/Canvas';
import { useRoomDoc } from './hooks/use-room-doc';
import { useRoomSnapshot } from './hooks/use-room-snapshot';
import RoomPage from './pages/RoomPage';

function CanvasWithControls({ roomId }: { roomId: string }) {
  const room = useRoomDoc(roomId);
  const snapshot = useRoomSnapshot(roomId);
  const { viewState, setScale, setPan, resetView } = useViewTransform();

  const handleClearCanvas = () => {
    // Clear button clicked - incrementing scene
    // Increment scene by pushing a new timestamp to scene_ticks
    // NOTE: Using 'any' here for dev test only - production code should use proper helpers
    // TODO: In Phase 10, we'll have a proper clearBoard() method on RoomDocManager
    room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const meta = root.get('meta') as any;
      const sceneTicks = meta.get('scene_ticks') as any;
      if (sceneTicks) {
        const timestamp = Date.now();
        // Pushing scene tick
        sceneTicks.push([timestamp]); // Y.Array.push expects an array of items
        // Scene ticks updated
      }
    });
  };

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
    <div className="min-h-screen bg-gray-50">
      <div className="fixed top-4 left-4 bg-white rounded-lg shadow-md p-3 z-10 space-y-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-600">Drawing Test</h2>
          <p className="text-xs text-gray-500 mt-1">Click and drag to draw</p>
          <p className="text-xs text-gray-400 mt-1">Room: {roomId}</p>
          <p className="text-xs text-gray-400 mt-1">Objects: {snapshot.objectsById.size}</p>
          <p className="text-xs text-gray-400 mt-1">Zoom: {Math.round(viewState.scale * 100)}%</p>
        </div>

        <div className="flex gap-1">
          <button
            onClick={handleClearCanvas}
            className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={handleZoomIn}
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
          >
            −
          </button>
          <button
            onClick={resetView}
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
          >
            Reset
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1">
          <div></div>
          <button
            onClick={() => handlePan(0, -50)}
            className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
          >
            ↑
          </button>
          <div></div>
          <button
            onClick={() => handlePan(-50, 0)}
            className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
          >
            ←
          </button>
          <button
            onClick={() => handlePan(0, 0)}
            className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
          >
            ●
          </button>
          <button
            onClick={() => handlePan(50, 0)}
            className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
          >
            →
          </button>
          <div></div>
          <button
            onClick={() => handlePan(0, 50)}
            className="px-2 py-1 text-xs bg-gray-400 text-white rounded hover:bg-gray-500"
          >
            ↓
          </button>
          <div></div>
        </div>

        <div className="text-xs text-gray-400 border-t pt-2">
          <p>Tips:</p>
          <p>• Use mouse wheel to zoom (TODO)</p>
          <p>• Hold space to pan (TODO)</p>
          <p>• Mobile: view-only mode</p>
        </div>
      </div>
      <Canvas roomId={roomId} className="w-full h-screen" />
    </div>
  );
}

function TestHarness() {
  // Legacy localhost:3000 testing, we use RoomPage.tsx for actual rooms
  const roomId = 'dev';

  return (
    <ViewTransformProvider>
      <CanvasWithControls roomId={roomId} />
    </ViewTransformProvider>
  );
}

export default function App() {
  // Single registry provider at root level - manages ALL rooms in this tab
  return (
    <RoomDocRegistryProvider>
      <Routes>
        {/* Test harness at root and /test */}
        <Route path="/" element={<TestHarness />} />
        <Route path="/test" element={<TestHarness />} />

        {/* Room page for actual rooms */}
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </RoomDocRegistryProvider>
  );
}
