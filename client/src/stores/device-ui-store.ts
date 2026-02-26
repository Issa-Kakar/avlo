import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getCanvasElement } from './camera-store';
import { useSelectionStore } from './selection-store';

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

// Size types
export type SizePreset = 6 | 10 | 14 | 18;
export type ConnectorSizePreset = 2 | 4 | 6 | 8;

// Unified font size presets (used by context menu + store)
export const TEXT_FONT_SIZE_PRESETS: readonly number[] = [10, 12, 14, 18, 24, 36, 48, 64, 80, 144];

// Text alignment type
export type TextAlign = 'left' | 'center' | 'right';

// Color palettes (module-level constants, not persisted)
export const TEXT_COLOR_PALETTE: readonly string[] = [
  '#262626', '#EF4444', '#F97316', '#EAB308',
  '#22C55E', '#3B82F6', '#8B5CF6', '#6B7280',
  '#FFFFFF', '#EC4899', '#06B6D4', '#84CC16',
];

export const HIGHLIGHT_COLORS: readonly (string | null)[] = [
  null, '#ffd43b', '#ffc078', '#ffa8a8', '#8ce99a', '#99e9f2', '#74c0fc', '#b197fc',
];

// Global drawing settings that all tools share
export interface DrawingSettings {
  size: SizePreset;
  color: string;
  opacity: number;
  fill: boolean;
}

interface DeviceUIState {
  // Tool state
  activeTool: Tool;

  // UNIFIED drawing settings
  drawingSettings: DrawingSettings;

  // Tool-specific settings
  highlighterOpacity: number;
  textSize: number;
  connectorSize: ConnectorSizePreset;
  shapeVariant: ShapeVariant;

  // Text-specific settings
  textColor: string;
  textAlign: TextAlign;
  textFontFamily: string;
  textIsBold: boolean;
  textIsItalic: boolean;
  highlightColor: string | null;

  // Fill color (separate from fill toggle)
  fillColor: string;

  // Placeholder tools
  image: { enabled: boolean };

  // UI state
  isTextEditing: boolean;

  // Color system
  recentColors: string[];
  isColorPopoverOpen: boolean;

  // Cursor override
  cursorOverride: string | null;

  // Actions
  setActiveTool: (tool: Tool) => void;
  setCursorOverride: (cursor: string | null) => void;

  setDrawingSettings: (settings: Partial<DrawingSettings>) => void;
  setDrawingSize: (size: SizePreset) => void;
  setDrawingColor: (color: string) => void;
  setDrawingOpacity: (opacity: number) => void;
  setFillEnabled: (enabled: boolean) => void;

  setHighlighterOpacity: (opacity: number) => void;
  setTextSize: (size: number) => void;
  setConnectorSize: (size: ConnectorSizePreset) => void;
  setShapeVariant: (variant: ShapeVariant) => void;

  setTextColor: (color: string) => void;
  setTextAlign: (align: TextAlign) => void;
  setTextFontFamily: (family: string) => void;
  setTextIsBold: (bold: boolean) => void;
  setTextIsItalic: (italic: boolean) => void;
  setHighlightColor: (color: string | null) => void;
  setFillColor: (color: string) => void;
  setIsTextEditing: (editing: boolean) => void;

  getCurrentToolSettings: () => { size: number; color: string; opacity: number; fill?: boolean };

  addRecentColor: (hex: string) => void;
  setColorPopoverOpen: (open: boolean) => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set, get) => ({
      activeTool: 'pen',

      drawingSettings: {
        size: 6,
        color: '#262626',
        opacity: 1.0,
        fill: false,
      },

      highlighterOpacity: 0.45,
      textSize: 24,
      connectorSize: 4,
      shapeVariant: 'rectangle',
      fillColor: '#BFDBFE',

      textColor: '#262626',
      textAlign: 'left',
      textFontFamily: 'Grandstander',
      textIsBold: false,
      textIsItalic: false,
      highlightColor: null,

      image: { enabled: false },

      isTextEditing: false,

      recentColors: [],
      isColorPopoverOpen: false,

      cursorOverride: null,

      // Actions
      setActiveTool: (tool) => set({ activeTool: tool }),
      setCursorOverride: (cursor) => {
        set({ cursorOverride: cursor });
        applyCursor();
      },

      setDrawingSettings: (settings) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, ...settings },
        })),

      setDrawingSize: (size) =>
        set((state) => ({
          drawingSettings: { ...state.drawingSettings, size },
        })),

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

      setHighlighterOpacity: (opacity) => set({ highlighterOpacity: opacity }),
      setTextSize: (size) => set({ textSize: size }),
      setConnectorSize: (size) => set({ connectorSize: size }),
      setShapeVariant: (variant) => set({ shapeVariant: variant }),

      setTextColor: (color) => set({ textColor: color }),
      setTextAlign: (align) => set({ textAlign: align }),
      setTextFontFamily: (family) => set({ textFontFamily: family }),
      setTextIsBold: (bold) => set({ textIsBold: bold }),
      setTextIsItalic: (italic) => set({ textIsItalic: italic }),
      setHighlightColor: (color) => set({ highlightColor: color }),
      setFillColor: (color) => set({ fillColor: color }),

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

      addRecentColor: (hex) =>
        set((state) => {
          const h = hex.trim().toLowerCase();
          if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(h)) return {};
          const fixed = new Set(TEXT_COLOR_PALETTE.map((c) => c.toLowerCase()));
          if (fixed.has(h)) return {};
          const next = [h, ...state.recentColors.filter((c) => c.toLowerCase() !== h)].slice(0, 5);
          return { recentColors: next };
        }),

      setColorPopoverOpen: (open) => set({ isColorPopoverOpen: open }),
    }),
    {
      name: 'avlo.toolbar.v4',
      version: 2,
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
    if (prevState.activeTool === 'select') {
      useSelectionStore.getState().clearSelection();
    }
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
export const selectHighlightColor = (s: DeviceUIState) => s.highlightColor;
