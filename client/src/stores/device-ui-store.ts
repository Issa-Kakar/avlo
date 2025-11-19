import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'image';
export type ShapeVariant = 'line' | 'rectangle' | 'ellipse' | 'arrow';

// Size types for new system
export type SizePreset = 10 | 14 | 18 | 22; // For pen/highlighter/shapes
export type TextSizePreset = 20 | 30 | 40 | 50; // For text

export interface ToolSettings {
  size: SizePreset;
  color: string;
  opacity?: number;
}

interface DeviceUIState {
  // Tool state - keeping existing structure with updated size types
  activeTool: Tool;
  pen: { size: SizePreset; color: string; opacity?: number };
  highlighter: { size: SizePreset; color: string; opacity?: number };
  eraser: { size: SizePreset }; // Use SizePreset like other tools
  text: { size: TextSizePreset; color: string };
  shape: {
    variant: ShapeVariant;
    settings: { size: SizePreset; color: string; opacity?: number };
  };
  select: {
    enabled: boolean; // Placeholder for future implementation
  };
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
  fillEnabledUI: boolean; // UI-only fill toggle state for shapes

  // Collaboration mode preference
  collaborationMode: 'server' | 'peer';

  // Actions
  setActiveTool: (tool: Tool) => void;
  setPenSettings: (
    settings: Partial<{ size: SizePreset; color: string; opacity?: number }>,
  ) => void;
  setHighlighterSettings: (
    settings: Partial<{ size: SizePreset; color: string; opacity?: number }>,
  ) => void;
  setEraserSize: (size: SizePreset) => void;
  setTextSettings: (settings: Partial<{ size: TextSizePreset; color: string }>) => void;
  setShapeSettings: (
    settings: Partial<
      { variant: ShapeVariant } & { size: SizePreset; color: string; opacity?: number }
    >,
  ) => void;
  setSelectSettings: (settings: Partial<DeviceUIState['select']>) => void;
  toggleEditor: () => void; // Keep for future code editor
  setCollaborationMode: (mode: 'server' | 'peer') => void;
  setIsTextEditing: (editing: boolean) => void;

  // New helper methods for inspector
  setCurrentToolSize: (size: number | string) => void;
  setCurrentToolColor: (color: string) => void;

  // New color system actions
  addRecentColor: (hex: string) => void;
  setColorPopoverOpen: (open: boolean) => void;
  setFillEnabledUI: (enabled: boolean) => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set) => ({
      // Updated default state with new color palette and sizes
      activeTool: 'pen',
      pen: { size: 10, color: '#262626' }, // Soft black ink
      highlighter: { size: 14, color: '#EAB308', opacity: 0.45 }, // Yellow
      eraser: { size: 14 }, // Medium size by default
      text: { size: 30, color: '#262626' }, // Medium size, soft black
      shape: { variant: 'rectangle', settings: { size: 10, color: '#262626' } },
      select: { enabled: false },
      image: { enabled: false }, // New placeholder

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
      fillEnabledUI: false,

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
          eraser: { ...state.eraser, size }, // Set the actual size passed
        })),

      setTextSettings: (settings) =>
        set((state) => ({
          text: { ...state.text, ...settings },
        })),

      setShapeSettings: (settings) =>
        set((state) => ({
          shape: {
            variant: settings.variant ?? state.shape.variant,
            settings: {
              ...state.shape.settings,
              ...(settings.size !== undefined && { size: settings.size }),
              ...(settings.color !== undefined && { color: settings.color }),
              ...(settings.opacity !== undefined && { opacity: settings.opacity }),
            },
          },
        })),

      setSelectSettings: (settings) =>
        set((state) => ({
          select: { ...state.select, ...settings },
        })),

      toggleEditor: () => set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setCollaborationMode: (mode) => set({ collaborationMode: mode }),

      setIsTextEditing: (editing) => set({ isTextEditing: editing }),

      // New helper methods for inspector
      setCurrentToolSize: (size) =>
        set((state) => {
          const t = state.activeTool;

          // Convert S/M/L/XL to pixel values
          let mappedSize = typeof size === 'number' ? size : 10;
          if (typeof size === 'string') {
            const sizeMap: Record<string, number> = {
              S: t === 'text' ? 20 : 10,
              M: t === 'text' ? 30 : 14,
              L: t === 'text' ? 40 : 18,
              XL: t === 'text' ? 50 : 22,
            };
            mappedSize = sizeMap[size] || 10;
          }

          // Type guards for proper typing
          const isTextSize = (s: number): s is TextSizePreset => [20, 30, 40, 50].includes(s);
          const isNormalSize = (s: number): s is SizePreset => [10, 14, 18, 22].includes(s);

          if (t === 'pen' && isNormalSize(mappedSize))
            return { pen: { ...state.pen, size: mappedSize } };
          if (t === 'highlighter' && isNormalSize(mappedSize))
            return { highlighter: { ...state.highlighter, size: mappedSize } };
          if (t === 'eraser' && isNormalSize(mappedSize))
            return { eraser: { ...state.eraser, size: mappedSize } };
          if (t === 'text' && isTextSize(mappedSize))
            return { text: { ...state.text, size: mappedSize } };
          if (t === 'shape' && isNormalSize(mappedSize))
            return {
              shape: { ...state.shape, settings: { ...state.shape.settings, size: mappedSize } },
            };
          return {};
        }),

      setCurrentToolColor: (color) =>
        set((state) => {
          const t = state.activeTool;
          if (t === 'eraser' || t === 'pan' || t === 'select' || t === 'image') return {};

          if (t === 'pen') return { pen: { ...state.pen, color } };
          if (t === 'highlighter') return { highlighter: { ...state.highlighter, color } };
          if (t === 'text') return { text: { ...state.text, color } };
          if (t === 'shape')
            return {
              shape: { ...state.shape, settings: { ...state.shape.settings, color } },
            };
          return {};
        }),

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

      setFillEnabledUI: (enabled) => set({ fillEnabledUI: enabled }),
    }),
    {
      name: 'avlo.toolbar.v2', // Updated localStorage key for redesign
      version: 3,
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

        if (version < 3) {
          const oldState = persistedState as any;
          return {
            activeTool: oldState.activeTool || 'pen',
            pen: {
              size: migrateSize(oldState.pen?.size || 4),
              color: migrateColor(oldState.pen?.color || '#262626'),
              opacity: oldState.pen?.opacity,
            },
            highlighter: {
              size: migrateSize(oldState.highlighter?.size || 8),
              color: migrateColor(oldState.highlighter?.color || '#EAB308'),
              opacity: oldState.highlighter?.opacity || 0.45,
            },
            eraser: { size: migrateSize(oldState.eraser?.size || 8) }, // Migrate old eraser size
            text: {
              size: migrateTextSize(oldState.text?.size || 16),
              color: migrateColor(oldState.text?.color || '#262626'),
            },
            shape: {
              variant: oldState.shape?.variant || 'rectangle',
              settings: {
                size: migrateSize(oldState.shape?.settings?.size || 4),
                color: migrateColor(oldState.shape?.settings?.color || '#262626'),
                opacity: oldState.shape?.settings?.opacity,
              },
            },
            select: { enabled: oldState.select?.enabled || false },
            image: { enabled: false }, // New

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
            fillEnabledUI: oldState.fillEnabledUI || false,
          };
        }
        return persistedState as DeviceUIState;
      },
    },
  ),
);
