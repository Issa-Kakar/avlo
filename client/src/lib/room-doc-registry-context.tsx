import { createContext, useContext, useRef, ReactNode } from 'react';
import { RoomDocManagerRegistry, createRoomDocManagerRegistry } from './room-doc-registry';

const RoomDocRegistryContext = createContext<RoomDocManagerRegistry | null>(null);

interface RoomDocRegistryProviderProps {
  children: ReactNode;
  registry?: RoomDocManagerRegistry;
}

export function RoomDocRegistryProvider({ children, registry }: RoomDocRegistryProviderProps) {
  const registryRef = useRef<RoomDocManagerRegistry>(undefined);
  if (!registryRef.current) {
    registryRef.current = registry ?? createRoomDocManagerRegistry();
  }
  return (
    <RoomDocRegistryContext value={registryRef.current}>
      {children}
    </RoomDocRegistryContext>
  );
}

export function useRoomDocRegistry(): RoomDocManagerRegistry {
  const ctx = useContext(RoomDocRegistryContext);
  if (!ctx) {
    throw new Error('useRoomDocRegistry must be used within a RoomDocRegistryProvider');
  }
  return ctx;
}

export function useHasRoomDocRegistry(): boolean {
  return useContext(RoomDocRegistryContext) !== null;
}
