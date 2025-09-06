import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ToolbarState {
  tool: 'pen' | 'highlighter' | 'text' | 'eraser' | 'stamp';
  size: number;
  color: string;
  opacity: number;
}

interface DeviceUIState {
  // Toolbar state
  toolbar: ToolbarState;

  // Track last seen scene per room (for ghost preview after clear)
  lastSeenSceneByRoom: Record<string, number>;

  // Collaboration mode preference
  collaborationMode: 'server' | 'peer';

  // UI preferences
  sidebarOpen: boolean;
  minimapVisible: boolean;

  // Actions
  setTool: (tool: ToolbarState['tool']) => void;
  setToolSize: (size: number) => void;
  setToolColor: (color: string) => void;
  setToolOpacity: (opacity: number) => void;
  updateLastSeenScene: (roomId: string, scene: number) => void;
  setCollaborationMode: (mode: 'server' | 'peer') => void;
  toggleSidebar: () => void;
  toggleMinimap: () => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set) => ({
      // Default state
      toolbar: {
        tool: 'pen',
        size: 2,
        color: '#000000',
        opacity: 1,
      },
      lastSeenSceneByRoom: {},
      collaborationMode: 'server',
      sidebarOpen: true,
      minimapVisible: true,

      // Actions
      setTool: (tool) =>
        set((state) => ({
          toolbar: { ...state.toolbar, tool },
        })),

      setToolSize: (size) =>
        set((state) => ({
          toolbar: { ...state.toolbar, size },
        })),

      setToolColor: (color) =>
        set((state) => ({
          toolbar: { ...state.toolbar, color },
        })),

      setToolOpacity: (opacity) =>
        set((state) => ({
          toolbar: { ...state.toolbar, opacity },
        })),

      updateLastSeenScene: (roomId, scene) =>
        set((state) => ({
          lastSeenSceneByRoom: {
            ...state.lastSeenSceneByRoom,
            [roomId]: scene,
          },
        })),

      setCollaborationMode: (mode) => set({ collaborationMode: mode }),

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleMinimap: () => set((state) => ({ minimapVisible: !state.minimapVisible })),
    }),
    {
      name: 'avlo:v1:ui', // localStorage key
      version: 1,
      // Migration function for future schema changes
      migrate: (persistedState: any, version: number) => {
        if (version === 0) {
          // Migration from version 0 to 1
          return { ...persistedState, version: 1 };
        }
        return persistedState as DeviceUIState;
      },
    },
  ),
);
