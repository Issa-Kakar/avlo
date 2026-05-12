import { ulid } from 'ulid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FontFamily, TextAlignV } from '@/core/accessors';
import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';
import { generateUserProfile } from '@/utils/generate-user-profile';
import { getCanvasElement } from './camera-store';
import { useSelectionStore } from './selection-store';

// 'image' is intentionally absent — image is a fire-and-forget toolbar action,
// not a sustained mode (see Toolbar.tsx + keyboard-manager.ts).
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'code' | 'connector' | 'note';
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'triangle';

// Stroke widths cover pen / highlighter / shape.
export type StrokeWidth = 4 | 7 | 10 | 13;
export type ConnectorWidth = 2 | 4 | 6 | 8;

// Unified font size presets (used by context menu + store)
export const TEXT_FONT_SIZE_PRESETS: readonly number[] = [10, 12, 14, 18, 24, 36, 48, 64, 80, 144];

// Text alignment type
export type TextAlign = 'left' | 'center' | 'right';

// Font family options
export type { FontFamily } from '@/core/accessors';
export const TEXT_FONT_FAMILIES: readonly FontFamily[] = ['Grandstander', 'Inter', 'Lora', 'JetBrains Mono'];

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

// Slot-based color storage — pen and highlighter each persist 3 colors
// and an "active slot" pointer. The active slot's color is read at gesture
// begin (no shared mirror field).
export type ColorSlots = readonly [string, string, string];
export type SlotIndex = 0 | 1 | 2;

// Connector variant id — derived from (type, startCap, endCap) at render time;
// not stored. See `components/toolbar/connector-variants.ts`.
export type ConnectorVariantId = 'line' | 'arrow' | 'doubleArrow' | 'elbow';

interface DeviceUIState {
  // User identity (persisted)
  userId: string;
  userName: string;
  userColor: string;

  // Tool
  activeTool: Tool;
  cursorOverride: string | null;

  // Pen — slots only; tool reads slots[active] at begin().
  penSlots: ColorSlots;
  penActiveSlot: SlotIndex;

  // Highlighter — slots + own opacity. Width is shared with pen via strokeWidth.
  highlighterSlots: ColorSlots;
  highlighterActiveSlot: SlotIndex;
  highlighterOpacity: number;

  // Shared between pen + highlighter.
  strokeWidth: StrokeWidth;

  // Shape — own color/fill/width (not shared with stroke).
  shapeVariant: ShapeVariant;
  shapeColor: string;
  shapeFillColor: string;
  shapeWidth: StrokeWidth;
  shapeAlign: TextAlign;
  shapeAlignV: TextAlignV;

  // Connector — own everything; variant derived from (type, startCap, endCap).
  connectorColor: string;
  connectorWidth: ConnectorWidth;
  connectorType: ConnectorType;
  connectorStartCap: ConnectorCap;
  connectorEndCap: ConnectorCap;

  // Text
  textColor: string;
  textAlign: TextAlign;
  textSize: number;
  textFontFamily: FontFamily;
  textHighlightColor: string | null;
  textFillColor: string | null;

  // Note
  noteAlign: TextAlign;
  noteAlignV: TextAlignV;
  noteFontFamily: FontFamily;

  // Code
  codeLineNumbers: boolean;
  codeHeaderVisible: boolean;

  // Actions
  setActiveTool: (tool: Tool) => void;
  setCursorOverride: (cursor: string | null) => void;

  setPenActiveSlot: (slot: SlotIndex) => void;
  setPenSlotColor: (color: string) => void;
  setHighlighterActiveSlot: (slot: SlotIndex) => void;
  setHighlighterSlotColor: (color: string) => void;
  setHighlighterOpacity: (opacity: number) => void;

  setStrokeWidth: (width: StrokeWidth) => void;

  setShapeMode: (variant: ShapeVariant) => void;
  setShapeVariant: (variant: ShapeVariant) => void;
  setShapeColor: (color: string) => void;
  setShapeFillColor: (color: string) => void;
  setShapeWidth: (width: StrokeWidth) => void;
  setShapeAlign: (align: TextAlign) => void;
  setShapeAlignV: (alignV: TextAlignV) => void;

  setConnectorColor: (color: string) => void;
  setConnectorWidth: (width: ConnectorWidth) => void;
  setConnectorType: (type: ConnectorType) => void;
  setConnectorStartCap: (cap: ConnectorCap) => void;
  setConnectorEndCap: (cap: ConnectorCap) => void;
  setConnectorMode: (variant: ConnectorVariantId) => void;

  setTextColor: (color: string) => void;
  setTextAlign: (align: TextAlign) => void;
  setTextSize: (size: number) => void;
  setTextFontFamily: (family: FontFamily) => void;
  setTextHighlightColor: (color: string | null) => void;
  setTextFillColor: (color: string | null) => void;

  setNoteAlign: (align: TextAlign) => void;
  setNoteAlignV: (alignV: TextAlignV) => void;
  setNoteFontFamily: (family: FontFamily) => void;

  setCodeLineNumbers: (v: boolean) => void;
  setCodeHeaderVisible: (v: boolean) => void;
}

export const useDeviceUIStore = create<DeviceUIState>()(
  persist(
    (set, get) => ({
      userId: '',
      userName: '',
      userColor: '',

      activeTool: 'pen',
      cursorOverride: null,

      penSlots: ['#131619', '#2196F3', '#F44336'] as const,
      penActiveSlot: 0,
      highlighterSlots: ['#FFC73B', '#FF8FB1', '#B5D9F2'] as const,
      highlighterActiveSlot: 0,
      highlighterOpacity: 0.45,

      strokeWidth: 4,

      shapeVariant: 'rectangle',
      shapeColor: '#131619',
      shapeFillColor: '#BFDBFE',
      shapeWidth: 4,
      shapeAlign: 'center' as TextAlign,
      shapeAlignV: 'middle' as TextAlignV,

      connectorColor: '#131619',
      connectorWidth: 4,
      connectorType: 'elbow' as ConnectorType,
      connectorStartCap: 'none' as ConnectorCap,
      connectorEndCap: 'arrow' as ConnectorCap,

      textColor: '#262626',
      textAlign: 'left' as TextAlign,
      textSize: 24,
      textFontFamily: 'Grandstander' as FontFamily,
      textHighlightColor: null,
      textFillColor: null,

      noteAlign: 'center' as TextAlign,
      noteAlignV: 'middle' as TextAlignV,
      noteFontFamily: 'Grandstander' as FontFamily,

      codeLineNumbers: true,
      codeHeaderVisible: true,

      setActiveTool: (tool) => set({ activeTool: tool }),
      setCursorOverride: (cursor) => {
        // Idempotent: bail if value unchanged. Eliminates per-frame state churn
        // from callers that re-emit the same cursor.
        if (get().cursorOverride === cursor) return;
        set({ cursorOverride: cursor });
        applyCursor();
      },

      setPenActiveSlot: (slot) => set({ penActiveSlot: slot }),
      setPenSlotColor: (color) => {
        const s = get();
        const next = [...s.penSlots] as unknown as [string, string, string];
        next[s.penActiveSlot] = color;
        set({ penSlots: next as ColorSlots });
      },
      setHighlighterActiveSlot: (slot) => set({ highlighterActiveSlot: slot }),
      setHighlighterSlotColor: (color) => {
        const s = get();
        const next = [...s.highlighterSlots] as unknown as [string, string, string];
        next[s.highlighterActiveSlot] = color;
        set({ highlighterSlots: next as ColorSlots });
      },
      setHighlighterOpacity: (opacity) => set({ highlighterOpacity: opacity }),

      setStrokeWidth: (width) => set({ strokeWidth: width }),

      setShapeMode: (variant) => set({ activeTool: 'shape', shapeVariant: variant }),
      setShapeVariant: (variant) => set({ shapeVariant: variant }),
      setShapeColor: (color) => set({ shapeColor: color }),
      setShapeFillColor: (color) => set({ shapeFillColor: color }),
      setShapeWidth: (width) => set({ shapeWidth: width }),
      setShapeAlign: (align) => set({ shapeAlign: align }),
      setShapeAlignV: (alignV) => set({ shapeAlignV: alignV }),

      setConnectorColor: (color) => set({ connectorColor: color }),
      setConnectorWidth: (width) => set({ connectorWidth: width }),
      setConnectorType: (type) => set({ connectorType: type }),
      setConnectorStartCap: (cap) => set({ connectorStartCap: cap }),
      setConnectorEndCap: (cap) => set({ connectorEndCap: cap }),
      setConnectorMode: (variant) => {
        // Atomic — single set() per click, one subscriber notification.
        // Elbow preserves caps by design (only the type flips).
        switch (variant) {
          case 'line':
            return set({ connectorType: 'straight', connectorStartCap: 'none', connectorEndCap: 'none' });
          case 'arrow':
            return set({ connectorType: 'straight', connectorStartCap: 'none', connectorEndCap: 'arrow' });
          case 'doubleArrow':
            return set({ connectorType: 'straight', connectorStartCap: 'arrow', connectorEndCap: 'arrow' });
          case 'elbow':
            return set({ connectorType: 'elbow' });
        }
      },

      setTextColor: (color) => set({ textColor: color }),
      setTextAlign: (align) => set({ textAlign: align }),
      setTextSize: (size) => set({ textSize: size }),
      setTextFontFamily: (family) => set({ textFontFamily: family }),
      setTextHighlightColor: (color) => set({ textHighlightColor: color }),
      setTextFillColor: (color) => set({ textFillColor: color }),

      setNoteAlign: (align) => set({ noteAlign: align }),
      setNoteAlignV: (alignV) => set({ noteAlignV: alignV }),
      setNoteFontFamily: (family) => set({ noteFontFamily: family }),

      setCodeLineNumbers: (v) => set({ codeLineNumbers: v }),
      setCodeHeaderVisible: (v) => set({ codeHeaderVisible: v }),
    }),
    {
      name: 'avlo.toolbar.v6',
      version: 4,
    },
  ),
);

// Stable action handler exports — Zustand actions are defined once inside
// create(), so destructuring them here yields references that never change.
// Import these directly in JSX so memoized children retain prop equality.
export const {
  setActiveTool,
  setPenActiveSlot,
  setPenSlotColor,
  setHighlighterActiveSlot,
  setHighlighterSlotColor,
  setHighlighterOpacity,
  setStrokeWidth,
  setShapeMode,
  setShapeVariant,
  setShapeColor,
  setShapeFillColor,
  setShapeWidth,
  setShapeAlign,
  setShapeAlignV,
  setConnectorColor,
  setConnectorWidth,
  setConnectorType,
  setConnectorStartCap,
  setConnectorEndCap,
  setConnectorMode,
  setTextColor,
  setTextAlign,
  setTextSize,
  setTextFontFamily,
  setTextHighlightColor,
  setTextFillColor,
  setNoteAlign,
  setNoteAlignV,
  setNoteFontFamily,
  setCodeLineNumbers,
  setCodeHeaderVisible,
} = useDeviceUIStore.getState();

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

// Self-subscription for tool changes: apply cursor, clear selection on leaving select.
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
export const selectTextHighlightColor = (s: DeviceUIState) => s.textHighlightColor;
