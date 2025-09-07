import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'stamps' | 'pan' | 'select';

export interface ToolSettings {
  size: number;
  color: string;
  opacity?: number;
}

interface DeviceUIState {
  // Phase 9: Enhanced toolbar state
  activeTool: Tool;
  pen: ToolSettings;
  highlighter: ToolSettings;
  eraser: { size: number };
  text: { size: number; color: string };

  // UI state
  zoom: number;
  editorCollapsed: boolean;
  minimapCollapsed: boolean;
  toolbarPos: { x: number; y: number };

  // Track last seen scene per room (for ghost preview after clear)
  lastSeenSceneByRoom: Record<string, number>;

  // Collaboration mode preference
  collaborationMode: 'server' | 'peer';

  // Actions
  setActiveTool: (tool: Tool) => void;
  setPenSettings: (settings: Partial<ToolSettings>) => void;
  setHighlighterSettings: (settings: Partial<ToolSettings>) => void;
  setEraserSize: (size: number) => void;
  setTextSettings: (settings: Partial<{ size: number; color: string }>) => void;
  setZoom: (zoom: number) => void;
  toggleEditor: () => void;
  toggleMinimap: () => void;
  setToolbarPosition: (pos: { x: number; y: number }) => void;
  updateLastSeenScene: (roomId: string, scene: number) => void;
  setCollaborationMode: (mode: 'server' | 'peer') => void;
}

// Export ToolbarState for backward compatibility
export interface ToolbarState {
  tool: Tool;
  color: string;
  size: number;
  opacity: number;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set) => ({
      // Phase 9: Enhanced default state
      activeTool: 'pen',
      pen: { size: 4, color: '#0F172A' },
      highlighter: { size: 8, color: '#F59E0B', opacity: 0.25 },
      eraser: { size: 10 },
      text: { size: 16, color: '#0F172A' },

      zoom: 1.0,
      editorCollapsed: false,
      minimapCollapsed: false,
      toolbarPos: { x: 24, y: 24 },

      lastSeenSceneByRoom: {},
      collaborationMode: 'server',

      // Actions
      setActiveTool: (tool) => set({ activeTool: tool }),

      setPenSettings: (settings) =>
        set((state) => ({
          pen: { ...state.pen, ...settings },
        })),

      setHighlighterSettings: (settings) =>
        set((state) => ({
          highlighter: { ...state.highlighter, ...settings },
        })),

      setEraserSize: (size) =>
        set((state) => ({
          eraser: { ...state.eraser, size },
        })),

      setTextSettings: (settings) =>
        set((state) => ({
          text: { ...state.text, ...settings },
        })),

      setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(2.0, zoom)) }),

      toggleEditor: () => set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      toggleMinimap: () => set((state) => ({ minimapCollapsed: !state.minimapCollapsed })),

      setToolbarPosition: (pos) => set({ toolbarPos: pos }),

      updateLastSeenScene: (roomId, scene) =>
        set((state) => ({
          lastSeenSceneByRoom: {
            ...state.lastSeenSceneByRoom,
            [roomId]: scene,
          },
        })),

      setCollaborationMode: (mode) => set({ collaborationMode: mode }),
    }),
    {
      name: 'avlo.toolbar.v1', // Phase 9: updated localStorage key
      version: 2,
      // Migration function for schema changes
      migrate: (persistedState: any, version: number) => {
        if (version === 0 || version === 1) {
          // Migration from older versions
          const oldState = persistedState as any;
          return {
            activeTool: oldState.toolbar?.tool || 'pen',
            pen: { size: 4, color: oldState.toolbar?.color || '#0F172A' },
            highlighter: { size: 8, color: '#F59E0B', opacity: 0.25 },
            eraser: { size: 10 },
            text: { size: 16, color: '#0F172A' },
            zoom: 1.0,
            editorCollapsed: false,
            minimapCollapsed: oldState.minimapVisible === false,
            toolbarPos: { x: 24, y: 24 },
            lastSeenSceneByRoom: oldState.lastSeenSceneByRoom || {},
            collaborationMode: oldState.collaborationMode || 'server',
          };
        }
        return persistedState as DeviceUIState;
      },
    },
  ),
);
