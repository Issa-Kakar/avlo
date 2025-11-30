import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'image' | 'code';
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'arrow';

// Size types for new system
export type SizePreset = 10 | 14 | 18 | 22; // For pen/highlighter/shapes
export type TextSizePreset = 20 | 30 | 40 | 50; // For text

// Global drawing settings that all tools share
export interface DrawingSettings {
  size: SizePreset;
  color: string;
  opacity: number;
  fill: boolean;  // Whether fill is enabled (only affects shapes)
}

interface DeviceUIState {
  // Tool state
  activeTool: Tool;

  // UNIFIED drawing settings - all tools use these
  drawingSettings: DrawingSettings;

  // Tool-specific settings that don't carry over
  highlighterOpacity: number; // Highlighter always uses 0.45 opacity
  textSize: TextSizePreset; // Text has different size scale
  shapeVariant: ShapeVariant; // Which shape is selected

  // Placeholder tools
  image: {
    enabled: boolean; // UI placeholder for image tool
  };

  // UI state - removed toolbarPos since it's fixed now
  editorCollapsed: boolean; // Keep for future code editor
  isTextEditing: boolean; // Track if text editor DOM is active

  // New color system
  fixedColors: string[]; // 8 fixed palette colors
  recentColors: string[]; // Last 5 custom colors (excludes fixed)
  isColorPopoverOpen: boolean; // Color popover state

  // Collaboration mode preference
  collaborationMode: 'server' | 'peer';

  // Actions
  setActiveTool: (tool: Tool) => void;

  // Unified drawing settings setters
  setDrawingSettings: (settings: Partial<DrawingSettings>) => void;
  setDrawingSize: (size: SizePreset) => void;
  setDrawingColor: (color: string) => void;
  setDrawingOpacity: (opacity: number) => void;
  setFillEnabled: (enabled: boolean) => void;

  // Tool-specific setters (these don't affect global settings)
  setHighlighterOpacity: (opacity: number) => void;
  setTextSize: (size: TextSizePreset) => void;
  setShapeVariant: (variant: ShapeVariant) => void;

  toggleEditor: () => void; // Keep for future code editor
  setCollaborationMode: (mode: 'server' | 'peer') => void;
  setIsTextEditing: (editing: boolean) => void;

  // Helper methods for getting current tool settings
  getCurrentToolSettings: () => { size: number; color: string; opacity: number; fill?: boolean };

  // New color system actions
  addRecentColor: (hex: string) => void;
  setColorPopoverOpen: (open: boolean) => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set, get) => ({
      // Updated default state with unified drawing settings
      activeTool: 'pen',

      // UNIFIED drawing settings - all tools use these
      drawingSettings: {
        size: 10,
        color: '#262626', // Soft black ink
        opacity: 1.0,
        fill: false, // Fill off by default
      },

      // Tool-specific settings that don't carry over
      highlighterOpacity: 0.45, // Highlighter always uses this
      textSize: 30, // Text has different size scale
      shapeVariant: 'rectangle', // Default shape

      image: { enabled: false }, // UI placeholder

      editorCollapsed: false, // Keep for future code editor
      isTextEditing: false,

      // New color system defaults
      fixedColors: [
        '#262626', // Soft black (ink)
        '#EF4444', // Red
        '#F97316', // Orange
        '#EAB308', // Yellow
        '#22C55E', // Green
        '#3B82F6', // Blue
        '#8B5CF6', // Violet
        '#6B7280', // Gray
      ],
      recentColors: [],
      isColorPopoverOpen: false,

      collaborationMode: 'server',

      // Actions
      setActiveTool: (tool) => set({ activeTool: tool }),

      // Unified drawing settings setters
      setDrawingSettings: (settings) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, ...settings },
        })),

      setDrawingSize: (size) => {
        // Validate size is actually a SizePreset (10, 14, 18, or 22)
        if (![10, 14, 18, 22].includes(size)) {
          console.error(`Invalid SizePreset: ${size}. Expected 10, 14, 18, or 22. Ignoring.`);
          return;
        }
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, size },
        }));
      },

      setDrawingColor: (color) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, color },
        })),

      setDrawingOpacity: (opacity) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, opacity },
        })),

      setFillEnabled: (enabled) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, fill: enabled },
        })),

      // Tool-specific setters (these don't affect global settings)
      setHighlighterOpacity: (opacity) => set({ highlighterOpacity: opacity }),

      setTextSize: (size) => {
        // Validate text size is a valid TextSizePreset
        if (![20, 30, 40, 50].includes(size)) {
          console.error(`Invalid text size: ${size}. Expected 20, 30, 40, or 50. Ignoring.`);
          return;
        }
        set({ textSize: size });
      },

      setShapeVariant: (variant) => set({ shapeVariant: variant }),

      toggleEditor: () => set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setCollaborationMode: (mode) => set({ collaborationMode: mode }),

      setIsTextEditing: (editing) => set({ isTextEditing: editing }),

      // Helper method to get current tool settings
      getCurrentToolSettings: () => {
        const state = get();
        const { activeTool, drawingSettings, highlighterOpacity, textSize } = state;

        // Base settings from unified drawing settings
        const settings = {
          size: drawingSettings.size as number,
          color: drawingSettings.color,
          opacity: drawingSettings.opacity,
          fill: drawingSettings.fill,
        };

        // Override with tool-specific settings
        switch (activeTool) {
          case 'highlighter':
            settings.opacity = highlighterOpacity;
            break;
          case 'text':
            settings.size = textSize;
            break;
          // eraser uses fixed 10px radius - no size override needed
          // pen/shape use unified settings
        }

        return settings;
      },

      // New color system actions
      addRecentColor: (hex) =>
        set((state) => {
          const fixed = new Set(state.fixedColors.map((c) => c.toLowerCase()));
          const h = hex.trim().toLowerCase();

          // Validate hex format
          if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(h)) return {};

          // Don't add fixed colors to recents
          if (fixed.has(h)) return {};

          // Add to front, remove duplicates, keep max 5
          const next = [h, ...state.recentColors.filter((c) => c.toLowerCase() !== h)].slice(0, 5);
          return { recentColors: next };
        }),

      setColorPopoverOpen: (open) => set({ isColorPopoverOpen: open }),
    }),
    {
      name: 'avlo.toolbar.v3', // New key for unified settings
      version: 4,
      // Migration function for schema changes
      migrate: (persistedState: any, version: number) => {
        // Helper functions for migration
        const migrateSize = (oldSize: number): SizePreset => {
          if (oldSize <= 5) return 10; // S
          if (oldSize <= 10) return 14; // M
          if (oldSize <= 15) return 18; // L
          return 22; // XL
        };

        const migrateTextSize = (oldSize: number): TextSizePreset => {
          if (oldSize <= 16) return 20; // S
          if (oldSize <= 24) return 30; // M
          if (oldSize <= 32) return 40; // L
          return 50; // XL
        };

        const migrateColor = (oldColor: string): string => {
          const colorMap: Record<string, string> = {
            '#111827': '#262626', // Old ink to new soft black
            '#0F172A': '#262626', // Another old ink variant
            '#F97316': '#EAB308', // Old orange to new yellow
            '#F59E0B': '#EAB308', // Old amber to new yellow
            '#10B981': '#22C55E', // Old green to new green
          };
          return colorMap[oldColor] || oldColor;
        };

        if (version < 4) {
          const oldState = persistedState as any;

          // Determine unified settings from the active tool's settings
          let unifiedSize = 10 as SizePreset;
          let unifiedColor = '#262626';
          let unifiedOpacity = 1.0;

          // Get settings from old active tool or pen as default
          const activeTool = oldState.activeTool || 'pen';
          if (oldState.pen && (activeTool === 'pen' || !oldState[activeTool])) {
            unifiedSize = migrateSize(oldState.pen.size || 10);
            unifiedColor = migrateColor(oldState.pen.color || '#262626');
            unifiedOpacity = oldState.pen.opacity || 1.0;
          } else if (oldState.shape?.settings && activeTool === 'shape') {
            unifiedSize = migrateSize(oldState.shape.settings.size || 10);
            unifiedColor = migrateColor(oldState.shape.settings.color || '#262626');
            unifiedOpacity = oldState.shape.settings.opacity || 1.0;
          }

          return {
            activeTool: oldState.activeTool || 'pen',

            // New unified drawing settings
            drawingSettings: {
              size: unifiedSize,
              color: unifiedColor,
              opacity: unifiedOpacity,
              fill: oldState.fillEnabledUI || oldState.drawingSettings?.fill || false,
            },

            // Tool-specific settings
            highlighterOpacity: oldState.highlighter?.opacity || 0.45,
            textSize: migrateTextSize(oldState.text?.size || 30),
            shapeVariant: oldState.shape?.variant || 'rectangle',

            image: { enabled: false },

            // Keep some old state
            editorCollapsed: oldState.editorCollapsed || false,
            isTextEditing: oldState.isTextEditing || false,
            collaborationMode: oldState.collaborationMode || 'server',

            // Add new color system fields
            fixedColors: [
              '#262626',
              '#EF4444',
              '#F97316',
              '#EAB308',
              '#22C55E',
              '#3B82F6',
              '#8B5CF6',
              '#6B7280',
            ],
            recentColors: oldState.recentColors || [],
            isColorPopoverOpen: false,
          };
        }
        return persistedState as DeviceUIState;
      },
    },
  ),
);
