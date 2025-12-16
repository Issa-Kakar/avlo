import { createContext, useContext, useRef, ReactNode } from 'react';
import { RoomDocManagerRegistry, createRoomDocManagerRegistry } from './room-doc-registry';

// Context type
interface RoomDocRegistryContextValue {
  registry: RoomDocManagerRegistry;
}

// Create the context
const RoomDocRegistryContext = createContext<RoomDocRegistryContextValue | null>(null);

// Provider props
interface RoomDocRegistryProviderProps {
  children: ReactNode;
  registry?: RoomDocManagerRegistry; // Optional: allow injection for testing
}

/**
 * Provider component for RoomDocManagerRegistry
 * Creates and maintains a single registry instance for the app
 * Tests can inject their own registry instance
 */
export function RoomDocRegistryProvider({ children, registry }: RoomDocRegistryProviderProps) {
  // Create registry once and maintain it for the lifetime of the provider
  const registryRef = useRef<RoomDocManagerRegistry>();

  if (!registryRef.current) {
    registryRef.current = registry ?? createRoomDocManagerRegistry();
  }

  return (
    <RoomDocRegistryContext.Provider value={{ registry: registryRef.current }}>
      {children}
    </RoomDocRegistryContext.Provider>
  );
}

/**
 * Hook to access the RoomDocManagerRegistry
 * Must be used within a RoomDocRegistryProvider
 */
export function useRoomDocRegistry(): RoomDocManagerRegistry {
  const context = useContext(RoomDocRegistryContext);

  if (!context) {
    throw new Error(
      'useRoomDocRegistry must be used within a RoomDocRegistryProvider. ' +
        'Wrap your app with <RoomDocRegistryProvider> or provide a registry for testing.',
    );
  }

  return context.registry;
}

/**
 * Hook to check if we're within a registry provider
 * Useful for components that optionally use the registry
 *
 * NOTE: This is a React Hook and must follow the Rules of Hooks
 * (cannot be called conditionally, must be called from React components/hooks)
 */
export function useHasRoomDocRegistry(): boolean {
  const context = useContext(RoomDocRegistryContext);
  return context !== null;
}
