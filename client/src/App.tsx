import { Routes, Route, Navigate } from 'react-router-dom';
import { RoomDocRegistryProvider } from './lib/room-doc-registry-context';
import RoomPage from './components/RoomPage';

export default function App() {
  return (
    <RoomDocRegistryProvider>
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="*" element={<Navigate to="/room/dev" replace />} />
      </Routes>
    </RoomDocRegistryProvider>
  );
}
