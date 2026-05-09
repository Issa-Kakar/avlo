import { ulid } from 'ulid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FontFamily, TextAlignV } from '@/core/accessors';
import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';
import { generateUserProfile } from '@/utils/generate-user-profile';
import { getCanvasElement } from './camera-store';
import { useSelectionStore } from './selection-store';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'image' | 'code' | 'connector' | 'note';
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'triangle';

// Size types
export type SizePreset = 4 | 7 | 10 | 13;
export type ConnectorSizePreset = 2 | 4 | 6 | 8;

// Unified font size presets (used by context menu + store)
export const TEXT_FONT_SIZE_PRESETS: readonly number[] = [10, 12, 14, 18, 24, 36, 48, 64, 80, 144];

// Text alignment type
export type TextAlign = 'left' | 'center' | 'right';

// Font family options
export type { FontFamily } from '@/core/accessors';
export const TEXT_FONT_FAMILIES: readonly FontFamily[] = ['Grandstander', 'Inter', 'Lora', 'JetBrains Mono'];

// Color palettes (module-level constants, not persisted)
export const TEXT_COLOR_PALETTE: readonly string[] = [
  '#262626',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#3B82F6',
  '#8B5CF6',
  '#6B7280',
  '#FFFFFF',
  '#EC4899',
  '#06B6D4',
  '#84CC16',
];

export const HIGHLIGHT_COLORS: readonly (string | null)[] = [
  null,
  '#ffd43b',
  '#ffc078',
  '#ffa8a8',
  '#8ce99a',
  '#99e9f2',
  '#74c0fc',
  '#b197fc',
];

// Global drawing settings that all tools share
export interface DrawingSettings {
  size: SizePreset;
  color: string;
  opacity: number;
  fill: boolean;
}

// Slot-based color storage — pen and highlighter each persist 3 colors
// and an "active slot" pointer; the active slot's color flows into
// drawingSettings.color whenever the active tool / slot changes.
export type ColorSlots = readonly [string, string, string];
export type SlotIndex = 0 | 1 | 2;

// Connector variant = (type, startCap, endCap) preset triple
export type ConnectorVariant = 'straight' | 'doubleArrow' | 'elbow';

interface DeviceUIState {
  // User identity (persisted)
  userId: string;
  userName: string;
  userColor: string;

  // Tool state
  activeTool: Tool;

  // UNIFIED drawing settings
  drawingSettings: DrawingSettings;

  // Per-tool color slots (3 each) — selected slot flows into drawingSettings.color
  penColorSlots: ColorSlots;
  penActiveSlot: SlotIndex;
  highlighterColorSlots: ColorSlots;
  highlighterActiveSlot: SlotIndex;

  // Connector inspector state
  connectorColor: string;
  connectorVariant: ConnectorVariant;

  // Inspector picker visibility (single-flag — only one picker open at a time)
  isColorPickerOpen: boolean;

  // Tool-specific settings
  highlighterOpacity: number;
  textSize: number;
  connectorSize: ConnectorSizePreset;
  shapeVariant: ShapeVariant;

  // Text-specific settings
  textColor: string;
  textAlign: TextAlign;
  textFontFamily: FontFamily;
  highlightColor: string | null;
  textFillColor: string | null;

  // Note-specific settings
  noteAlign: TextAlign;
  noteAlignV: TextAlignV;
  noteFontFamily: FontFamily;

  // Code-specific settings
  codeLineNumbers: boolean;
  codeHeaderVisible: boolean;

  // Connector cap/type settings
  connectorStartCap: ConnectorCap;
  connectorEndCap: ConnectorCap;
  connectorType: ConnectorType;

  // Shape alignment
  shapeAlign: TextAlign;
  shapeAlignV: TextAlignV;

  // Fill color (separate from fill toggle)
  fillColor: string;

  // Placeholder tools
  image: { enabled: boolean };

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

  // Slot actions — picker visibility + per-slot setters
  setColorPickerOpen: (open: boolean) => void;
  toggleColorPicker: () => void;
  setActiveSlot: (slot: SlotIndex) => void;
  setActiveSlotColor: (color: string) => void;
  setConnectorColor: (color: string) => void;
  setConnectorVariant: (variant: ConnectorVariant) => void;

  setHighlighterOpacity: (opacity: number) => void;
  setTextSize: (size: number) => void;
  setCodeLineNumbers: (v: boolean) => void;
  setCodeHeaderVisible: (v: boolean) => void;
  setConnectorSize: (size: ConnectorSizePreset) => void;
  setConnectorStartCap: (cap: ConnectorCap) => void;
  setConnectorEndCap: (cap: ConnectorCap) => void;
  setConnectorType: (type: ConnectorType) => void;
  setShapeVariant: (variant: ShapeVariant) => void;

  setTextColor: (color: string) => void;
  setTextAlign: (align: TextAlign) => void;
  setFontFamily: (family: FontFamily) => void;
  setHighlightColor: (color: string | null) => void;
  setTextFillColor: (color: string | null) => void;
  setNoteAlign: (align: TextAlign) => void;
  setNoteAlignV: (alignV: TextAlignV) => void;
  setNoteFontFamily: (family: FontFamily) => void;
  setShapeAlign: (align: TextAlign) => void;
  setShapeAlignV: (alignV: TextAlignV) => void;
  setFillColor: (color: string) => void;

  getCurrentToolSettings: () => { size: number; color: string; opacity: number; fill?: boolean };
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set, get) => ({
      userId: '',
      userName: '',
      userColor: '',

      activeTool: 'pen',

      drawingSettings: {
        size: 4,
        color: '#131619',
        opacity: 1.0,
        fill: false,
      },

      penColorSlots: ['#131619', '#2196F3', '#F44336'] as const,
      penActiveSlot: 0,
      highlighterColorSlots: ['#FFC73B', '#FF8FB1', '#B5D9F2'] as const,
      highlighterActiveSlot: 0,

      connectorColor: '#131619',
      connectorVariant: 'elbow' as ConnectorVariant,

      isColorPickerOpen: false,

      highlighterOpacity: 0.45,
      textSize: 24,
      connectorSize: 4,
      codeLineNumbers: true,
      codeHeaderVisible: true,
      connectorStartCap: 'none' as ConnectorCap,
      connectorEndCap: 'arrow' as ConnectorCap,
      connectorType: 'elbow' as ConnectorType,
      shapeVariant: 'rectangle',
      shapeAlign: 'center' as TextAlign,
      shapeAlignV: 'middle' as TextAlignV,
      fillColor: '#BFDBFE',

      textColor: '#262626',
      textAlign: 'left' as TextAlign,
      textFontFamily: 'Grandstander' as FontFamily,
      highlightColor: null,
      textFillColor: null,

      noteAlign: 'center' as TextAlign,
      noteAlignV: 'middle' as TextAlignV,
      noteFontFamily: 'Grandstander' as FontFamily,

      image: { enabled: false },

      cursorOverride: null,

      // Actions — when activeTool flips between pen/highlighter, push the
      // new tool's active-slot color into drawingSettings.color so that
      // DrawingTool (which freezes settings.color at begin()) picks it up.
      setActiveTool: (tool) => {
        const s = get();
        if (tool === 'pen' && s.activeTool !== 'pen') {
          set({
            activeTool: tool,
            drawingSettings: { ...s.drawingSettings, color: s.penColorSlots[s.penActiveSlot] },
            isColorPickerOpen: false,
          });
        } else if (tool === 'highlighter' && s.activeTool !== 'highlighter') {
          set({
            activeTool: tool,
            drawingSettings: { ...s.drawingSettings, color: s.highlighterColorSlots[s.highlighterActiveSlot] },
            isColorPickerOpen: false,
          });
        } else {
          set({ activeTool: tool, isColorPickerOpen: false });
        }
      },
      setCursorOverride: (cursor) => {
        // Idempotent: bail if value unchanged. Eliminates per-frame state churn
        // from callers that re-emit the same cursor (e.g., SelectTool's hover
        // gate writing `null` every pointermove while not over a handle).
        if (get().cursorOverride === cursor) return;
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
      setCodeLineNumbers: (v) => set({ codeLineNumbers: v }),
      setCodeHeaderVisible: (v) => set({ codeHeaderVisible: v }),
      setConnectorSize: (size) => set({ connectorSize: size }),
      setConnectorStartCap: (cap) => set({ connectorStartCap: cap }),
      setConnectorEndCap: (cap) => set({ connectorEndCap: cap }),
      setConnectorType: (type) => set({ connectorType: type }),
      setShapeVariant: (variant) => set({ shapeVariant: variant }),

      setTextColor: (color) => set({ textColor: color }),
      setTextAlign: (align) => set({ textAlign: align }),
      setFontFamily: (family) => set({ textFontFamily: family }),
      setHighlightColor: (color) => set({ highlightColor: color }),
      setTextFillColor: (color) => set({ textFillColor: color }),
      setNoteAlign: (align) => set({ noteAlign: align }),
      setNoteAlignV: (alignV) => set({ noteAlignV: alignV }),
      setNoteFontFamily: (family) => set({ noteFontFamily: family }),
      setShapeAlign: (align) => set({ shapeAlign: align }),
      setShapeAlignV: (alignV) => set({ shapeAlignV: alignV }),
      setFillColor: (color) => set({ fillColor: color }),

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

      setColorPickerOpen: (open) => set({ isColorPickerOpen: open }),
      toggleColorPicker: () => set((s) => ({ isColorPickerOpen: !s.isColorPickerOpen })),

      setActiveSlot: (slot) => {
        const s = get();
        if (s.activeTool === 'pen') {
          if (s.penActiveSlot === slot) return;
          set({
            penActiveSlot: slot,
            drawingSettings: { ...s.drawingSettings, color: s.penColorSlots[slot] },
            isColorPickerOpen: false,
          });
        } else if (s.activeTool === 'highlighter') {
          if (s.highlighterActiveSlot === slot) return;
          set({
            highlighterActiveSlot: slot,
            drawingSettings: { ...s.drawingSettings, color: s.highlighterColorSlots[slot] },
            isColorPickerOpen: false,
          });
        }
      },

      setActiveSlotColor: (color) => {
        const s = get();
        if (s.activeTool === 'pen') {
          const next = [...s.penColorSlots] as unknown as [string, string, string];
          next[s.penActiveSlot] = color;
          set({
            penColorSlots: next as ColorSlots,
            drawingSettings: { ...s.drawingSettings, color },
          });
        } else if (s.activeTool === 'highlighter') {
          const next = [...s.highlighterColorSlots] as unknown as [string, string, string];
          next[s.highlighterActiveSlot] = color;
          set({
            highlighterColorSlots: next as ColorSlots,
            drawingSettings: { ...s.drawingSettings, color },
          });
        }
      },

      setConnectorColor: (color) => set({ connectorColor: color }),
      setConnectorVariant: (variant) => {
        // Variant is the source of truth; (type, startCap, endCap) are derived.
        const preset = CONNECTOR_VARIANT_PRESETS[variant];
        set({
          connectorVariant: variant,
          connectorType: preset.type,
          connectorStartCap: preset.startCap,
          connectorEndCap: preset.endCap,
        });
      },
    }),
    {
      name: 'avlo.toolbar.v5',
      version: 3,
    },
  ),
);

// Connector variant → (type, caps) preset table.
// Keep this co-located with the store so setConnectorVariant stays a one-liner.
const CONNECTOR_VARIANT_PRESETS: Record<ConnectorVariant, { type: ConnectorType; startCap: ConnectorCap; endCap: ConnectorCap }> = {
  straight: { type: 'straight', startCap: 'none', endCap: 'none' },
  doubleArrow: { type: 'straight', startCap: 'arrow', endCap: 'arrow' },
  elbow: { type: 'elbow', startCap: 'none', endCap: 'arrow' },
};

// ============================================
// USER IDENTITY INITIALIZATION
// ============================================

if (!useDeviceUIStore.getState().userId) {
  const profile = generateUserProfile();
  useDeviceUIStore.setState({
    userId: ulid(),
    userName: profile.name,
    userColor: profile.color,
  });
}

/** Imperative getter — returns the stable user ID string. */
export function getUserId(): string {
  return useDeviceUIStore.getState().userId;
}

/** Imperative getter — returns the full user profile for presence. */
export function getUserProfile(): { userId: string; name: string; color: string } {
  const s = useDeviceUIStore.getState();
  return { userId: s.userId, name: s.userName, color: s.userColor };
}

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
    case 'note':
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
export const selectHighlightColor = (s: DeviceUIState) => s.highlightColor;
