import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getCanvasElement } from './camera-store';

export type Tool =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'text'
  | 'pan'
  | 'select'
  | 'shape'
  | 'image'
  | 'code'
  | 'connector';
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse';

// Size types for new system
export type SizePreset = 6 | 10 | 14 | 18; // For pen/highlighter/shapes
export type TextSizePreset = 20 | 30 | 40 | 50; // For text
export type ConnectorSizePreset = 2 | 4 | 6 | 8; // For connectors

// Figma-like font size presets for text context menu
export type TextFontSizePreset = 12 | 14 | 16 | 18 | 20 | 24 | 28 | 32 | 36 | 48 | 64 | 72 | 96;
export const TEXT_FONT_SIZE_PRESETS: readonly TextFontSizePreset[] = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96];

// Text alignment type
export type TextAlign = 'left' | 'center' | 'right';

// Global drawing settings that all tools share
export interface DrawingSettings {
  size: SizePreset;
  color: string;
  opacity: number;
  fill: boolean; // Whether fill is enabled (only affects shapes)
}

interface DeviceUIState {
  // Tool state
  activeTool: Tool;

  // UNIFIED drawing settings - all tools use these
  drawingSettings: DrawingSettings;

  // Tool-specific settings that don't carry over
  highlighterOpacity: number; // Highlighter always uses 0.45 opacity
  textSize: TextSizePreset; // Text has different size scale
  connectorSize: ConnectorSizePreset; // Connectors have thin sizes
  shapeVariant: ShapeVariant; // Which shape is selected

  // Text-specific settings (used by text context menu)
  textColor: string; // Text-specific color (separate from drawing color)
  textAlign: TextAlign; // Text alignment
  textFontFamily: string; // Only 'Grandstander' for now
  textIsBold: boolean; // Current cursor position has bold
  textIsItalic: boolean; // Current cursor position has italic

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

  // Cursor override (e.g., 'grabbing' during pan)
  cursorOverride: string | null;

  // Actions
  setActiveTool: (tool: Tool) => void;
  setCursorOverride: (cursor: string | null) => void;

  // Unified drawing settings setters
  setDrawingSettings: (settings: Partial<DrawingSettings>) => void;
  setDrawingSize: (size: SizePreset) => void;
  setDrawingColor: (color: string) => void;
  setDrawingOpacity: (opacity: number) => void;
  setFillEnabled: (enabled: boolean) => void;

  // Tool-specific setters (these don't affect global settings)
  setHighlighterOpacity: (opacity: number) => void;
  setTextSize: (size: TextSizePreset) => void;
  setConnectorSize: (size: ConnectorSizePreset) => void;
  setShapeVariant: (variant: ShapeVariant) => void;

  // Text-specific setters
  setTextColor: (color: string) => void;
  setTextAlign: (align: TextAlign) => void;
  setTextFontFamily: (family: string) => void;
  setTextIsBold: (bold: boolean) => void;
  setTextIsItalic: (italic: boolean) => void;

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
        size: 6,
        color: '#262626', // Soft black ink
        opacity: 1.0,
        fill: false, // Fill off by default
      },

      // Tool-specific settings that don't carry over
      highlighterOpacity: 0.45, // Highlighter always uses this
      textSize: 30, // Text has different size scale
      connectorSize: 4, // Connector default (M)
      shapeVariant: 'rectangle', // Default shape

      // Text-specific settings
      textColor: '#262626', // Soft black (same as default drawing color)
      textAlign: 'left', // Default left alignment
      textFontFamily: 'Grandstander', // Only option for now
      textIsBold: false,
      textIsItalic: false,

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

      // Cursor override - no override by default
      cursorOverride: null,

      // Actions
      setActiveTool: (tool) => set({ activeTool: tool }),
      setCursorOverride: (cursor) => {
        set({ cursorOverride: cursor });
        applyCursor();
      },

      // Unified drawing settings setters
      setDrawingSettings: (settings) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, ...settings },
        })),

      setDrawingSize: (size) => {
        // Validate size is actually a SizePreset (6, 10, 14, or 18)
        if (![6, 10, 14, 18].includes(size)) {
          console.error(`Invalid SizePreset: ${size}. Expected 6, 10, 14, or 18. Ignoring.`);
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

      setConnectorSize: (size) => {
        // Validate connector size is a valid ConnectorSizePreset
        if (![2, 4, 6, 8].includes(size)) {
          console.error(`Invalid ConnectorSizePreset: ${size}. Expected 2, 4, 6, or 8. Ignoring.`);
          return;
        }
        set({ connectorSize: size });
      },

      setShapeVariant: (variant) => set({ shapeVariant: variant }),

      // Text-specific setters
      setTextColor: (color) => set({ textColor: color }),
      setTextAlign: (align) => set({ textAlign: align }),
      setTextFontFamily: (family) => set({ textFontFamily: family }),
      setTextIsBold: (bold) => set({ textIsBold: bold }),
      setTextIsItalic: (italic) => set({ textIsItalic: italic }),

      toggleEditor: () => set((state) => ({ editorCollapsed: !state.editorCollapsed })),

      setCollaborationMode: (mode) => set({ collaborationMode: mode }),

      setIsTextEditing: (editing) => set({ isTextEditing: editing }),

      // Helper method to get current tool settings
      getCurrentToolSettings: () => {
        const state = get();
        const { activeTool, drawingSettings, highlighterOpacity, textSize, connectorSize } = state;

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
          case 'connector':
            settings.size = connectorSize;
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
      version: 7,
      // Migration function for schema changes
      migrate: (persistedState: unknown, version: number) => {
        // Helper functions for migration
        // v4 migration: legacy sizes to intermediate preset system (10/14/18/22)
        const migrateSizeV4 = (oldSize: number): number => {
          if (oldSize <= 5) return 10; // S
          if (oldSize <= 10) return 14; // M
          if (oldSize <= 15) return 18; // L
          return 22; // XL
        };

        // v5 migration: intermediate preset (10/14/18/22) to v5 preset (8/12/16/20)
        const migrateDrawingSizeV5 = (oldSize: number): number => {
          if (oldSize <= 10) return 8; // S
          if (oldSize <= 14) return 12; // M
          if (oldSize <= 18) return 16; // L
          return 20; // XL
        };

        // v6 migration: v5 preset (8/12/16/20) to v6 preset (6/10/14/18)
        const migrateDrawingSizeV6 = (oldSize: number): SizePreset => {
          if (oldSize <= 8) return 6; // S
          if (oldSize <= 12) return 10; // M
          if (oldSize <= 16) return 14; // L
          return 18; // XL
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

        // v7 migration: Add text-specific settings
        if (version === 6) {
          const state = persistedState as Record<string, unknown>;
          return {
            ...state,
            textColor: (state.textColor as string) ?? '#262626',
            textAlign: (state.textAlign as string) ?? 'left',
            textFontFamily: (state.textFontFamily as string) ?? 'Grandstander',
          };
        }

        // v6 migration: Migrate drawing sizes from 8/12/16/20 to 6/10/14/18
        if (version === 5) {
          const state = persistedState as Record<string, unknown>;
          const drawingSettings = state.drawingSettings as Record<string, unknown> | undefined;
          const currentDrawingSize = (drawingSettings?.size as number) ?? 8;
          return {
            ...state,
            drawingSettings: {
              ...drawingSettings,
              size: migrateDrawingSizeV6(currentDrawingSize),
            },
            // Add text settings for older versions
            textColor: '#262626',
            textAlign: 'left',
            textFontFamily: 'Grandstander',
          };
        }

        // v5 migration: Add connectorSize and migrate drawing sizes from 10/14/18/22 to 8/12/16/20
        if (version === 4) {
          const state = persistedState as Record<string, unknown>;
          const drawingSettings = state.drawingSettings as Record<string, unknown> | undefined;
          const currentDrawingSize = (drawingSettings?.size as number) ?? 10;
          // Chain through v5 then v6
          const v5Size = migrateDrawingSizeV5(currentDrawingSize);
          return {
            ...state,
            drawingSettings: {
              ...drawingSettings,
              size: migrateDrawingSizeV6(v5Size),
            },
            connectorSize: 4, // Default M for migrated users
            // Add text settings for older versions
            textColor: '#262626',
            textAlign: 'left',
            textFontFamily: 'Grandstander',
          };
        }

        if (version < 4) {
          const oldState = persistedState as Record<string, unknown>;

          // Determine unified settings from the active tool's settings
          let unifiedSize = 10;
          let unifiedColor = '#262626';
          let unifiedOpacity = 1.0;

          // Get settings from old active tool or pen as default
          const activeTool = (oldState.activeTool as string) || 'pen';
          const pen = oldState.pen as Record<string, unknown> | undefined;
          const shape = oldState.shape as Record<string, unknown> | undefined;
          const shapeSettings = shape?.settings as Record<string, unknown> | undefined;

          if (pen && (activeTool === 'pen' || !oldState[activeTool])) {
            unifiedSize = migrateSizeV4((pen.size as number) || 10);
            unifiedColor = migrateColor((pen.color as string) || '#262626');
            unifiedOpacity = (pen.opacity as number) || 1.0;
          } else if (shapeSettings && activeTool === 'shape') {
            unifiedSize = migrateSizeV4((shapeSettings.size as number) || 10);
            unifiedColor = migrateColor((shapeSettings.color as string) || '#262626');
            unifiedOpacity = (shapeSettings.opacity as number) || 1.0;
          }

          const highlighter = oldState.highlighter as Record<string, unknown> | undefined;
          const text = oldState.text as Record<string, unknown> | undefined;
          const existingDrawingSettings = oldState.drawingSettings as
            | Record<string, unknown>
            | undefined;

          // Chain through v5 then v6
          const v5Size = migrateDrawingSizeV5(unifiedSize);

          return {
            activeTool: oldState.activeTool || 'pen',

            // New unified drawing settings - migrate to v6 sizes
            drawingSettings: {
              size: migrateDrawingSizeV6(v5Size),
              color: unifiedColor,
              opacity: unifiedOpacity,
              fill:
                (oldState.fillEnabledUI as boolean) ||
                (existingDrawingSettings?.fill as boolean) ||
                false,
            },

            // Tool-specific settings
            highlighterOpacity: (highlighter?.opacity as number) || 0.45,
            textSize: migrateTextSize((text?.size as number) || 30),
            connectorSize: 4, // Default M for new migrated users
            shapeVariant: (shape?.variant as string) || 'rectangle',

            // Text-specific settings (new in v7)
            textColor: '#262626',
            textAlign: 'left',
            textFontFamily: 'Grandstander',

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
            recentColors: (oldState.recentColors as string[]) || [],
            isColorPopoverOpen: false,
          };
        }
        return persistedState as DeviceUIState;
      },
    },
  ),
);

// ============================================
// CURSOR MANAGEMENT
// ============================================

/**
 * Compute the appropriate cursor based on active tool.
 */
function computeBaseCursor(): string {
  const { activeTool } = useDeviceUIStore.getState();
  switch (activeTool) {
    case 'eraser':
      return 'url("/cursors/avloEraser.cur") 16 16, auto';
    case 'pan':
      return 'grab';
    case 'select':
      return 'default';
    case 'text':
      return 'text';
    default:
      return 'crosshair';
  }
}

/**
 * Apply the current cursor to the canvas element.
 * Priority: override > tool-based cursor
 */
export function applyCursor(): void {
  const canvas = getCanvasElement();
  if (!canvas) return;
  const override = useDeviceUIStore.getState().cursorOverride;
  canvas.style.cursor = override ?? computeBaseCursor();
}

/**
 * Set a cursor override that takes priority over tool-based cursor.
 * Pass null to clear override.
 */
export function setCursorOverride(cursor: string | null): void {
  useDeviceUIStore.getState().setCursorOverride(cursor);
}

/**
 * Self-subscription for tool changes.
 * When activeTool changes and canvas is available, apply the new cursor.
 * This subscription is set up once at module initialization and lives
 * for the lifetime of the app.
 */
useDeviceUIStore.subscribe((state, prevState) => {
  if (state.activeTool !== prevState.activeTool) {
    applyCursor();
  }
});

// ============================================
// SELECTORS
// ============================================
export const selectTextColor = (s: DeviceUIState) => s.textColor;
export const selectTextAlign = (s: DeviceUIState) => s.textAlign;
export const selectTextSize = (s: DeviceUIState) => s.textSize;
export const selectTextIsBold = (s: DeviceUIState) => s.textIsBold;
export const selectTextIsItalic = (s: DeviceUIState) => s.textIsItalic;
