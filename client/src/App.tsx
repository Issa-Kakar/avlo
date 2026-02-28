import { Routes, Route, Navigate } from 'react-router-dom';
import { RoomDocRegistryProvider } from './lib/room-doc-registry-context';
import RoomPage from './components/RoomPage';
import { SelectionContextMenuDemo } from './components/SelectionContextMenu';

export default function App() {
  return (
    <RoomDocRegistryProvider>
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/demo/context-menu" element={<SelectionContextMenuDemo />} />
        <Route path="*" element={<Navigate to="/room/dev" replace />} />
      </Routes>
    </RoomDocRegistryProvider>
  ); 
}
