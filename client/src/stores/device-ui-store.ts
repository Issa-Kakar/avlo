import { ulid } from 'ulid';
import { create } from 'zustand';
import { createJSONStorage, persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { ConnectorVariantId } from '@/components/toolbar/connector-variants';
import { CONNECTOR_VARIANT_SPECS } from '@/components/toolbar/connector-variants';
import type { FontFamily, TextAlignV } from '@/core/accessors';
import type { ConnectorCap, ConnectorType } from '@/core/connectors/types';
import { generateUserProfile } from '@/utils/generate-user-profile';
import { getCanvasElement } from './camera-store';

// 'image' is intentionally absent — image is a fire-and-forget toolbar action,
// not a sustained mode (see Toolbar.tsx + keyboard-manager.ts).
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape' | 'code' | 'connector' | 'note';
export type ShapeVariant = 'diamond' | 'rectangle' | 'ellipse' | 'triangle';

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

// === State Interface ===

export interface DeviceUIState {
  user: { id: string; name: string; color: string };
  tool: { active: Tool; cursorOverride: string | null };

  // Shared by pen + highlighter. Honest top-level scalar — not "owned" by either tool.
  strokeWidth: number;

  pen: { slots: ColorSlots; activeSlot: SlotIndex };
  highlighter: { slots: ColorSlots; activeSlot: SlotIndex; opacity: number };
  shape: { variant: ShapeVariant; color: string; fillColor: string; width: number; align: TextAlign; alignV: TextAlignV };
  connector: { color: string; width: number; type: ConnectorType; startCap: ConnectorCap; endCap: ConnectorCap };
  text: { color: string; align: TextAlign; size: number; fontFamily: FontFamily; highlightColor: string | null; fillColor: string | null };
  note: { align: TextAlign; alignV: TextAlignV; fontFamily: FontFamily };
  code: { lineNumbers: boolean; headerVisible: boolean };
}

// === Actions Interface ===

export interface DeviceUIActions {
  setActiveTool(tool: Tool): void;
  setCursorOverride(cursor: string | null): void;

  setStrokeWidth(width: number): void;

  setPenActiveSlot(slot: SlotIndex): void;
  setPenSlotColor(color: string): void;
  setHighlighterActiveSlot(slot: SlotIndex): void;
  setHighlighterSlotColor(color: string): void;
  setHighlighterOpacity(opacity: number): void;

  setShapeMode(variant: ShapeVariant): void;
  setShapeVariant(variant: ShapeVariant): void;
  setShapeColor(color: string): void;
  setShapeFillColor(color: string): void;
  setShapeWidth(width: number): void;
  setShapeAlign(align: TextAlign): void;
  setShapeAlignV(alignV: TextAlignV): void;

  setConnectorColor(color: string): void;
  setConnectorWidth(width: number): void;
  setConnectorType(type: ConnectorType): void;
  setConnectorStartCap(cap: ConnectorCap): void;
  setConnectorEndCap(cap: ConnectorCap): void;
  setConnectorMode(variant: ConnectorVariantId): void;

  setTextColor(color: string): void;
  setTextAlign(align: TextAlign): void;
  setTextSize(size: number): void;
  setTextFontFamily(family: FontFamily): void;
  setTextHighlightColor(color: string | null): void;
  setTextFillColor(color: string | null): void;

  setNoteAlign(align: TextAlign): void;
  setNoteAlignV(alignV: TextAlignV): void;
  setNoteFontFamily(family: FontFamily): void;

  setCodeLineNumbers(v: boolean): void;
  setCodeHeaderVisible(v: boolean): void;
}

export type DeviceUIStore = DeviceUIState & DeviceUIActions;

export const useDeviceUIStore = create<DeviceUIStore>()(
  subscribeWithSelector(
    persist(
      immer((set, get) => ({
        user: { id: '', name: '', color: '' },
        tool: { active: 'select' as Tool, cursorOverride: null },

        strokeWidth: 4,

        pen: { slots: ['#131619', '#2196F3', '#F44336'] as ColorSlots, activeSlot: 0 as SlotIndex },
        highlighter: {
          slots: ['#FFC73B', '#FF8FB1', '#B5D9F2'] as ColorSlots,
          activeSlot: 0 as SlotIndex,
          opacity: 0.45,
        },

        shape: {
          variant: 'rectangle' as ShapeVariant,
          color: '#131619',
          fillColor: '#BFDBFE',
          width: 4,
          align: 'center' as TextAlign,
          alignV: 'middle' as TextAlignV,
        },

        connector: {
          color: '#131619',
          width: 4,
          type: 'elbow' as ConnectorType,
          startCap: 'none' as ConnectorCap,
          endCap: 'arrow' as ConnectorCap,
        },

        text: {
          color: '#262626',
          align: 'left' as TextAlign,
          size: 24,
          fontFamily: 'Grandstander' as FontFamily,
          highlightColor: null,
          fillColor: null,
        },

        note: {
          align: 'center' as TextAlign,
          alignV: 'middle' as TextAlignV,
          fontFamily: 'Grandstander' as FontFamily,
        },

        code: { lineNumbers: true, headerVisible: true },

        // === Actions ===

        setActiveTool: (tool) =>
          set((state) => {
            state.tool.active = tool;
          }),
        setCursorOverride: (cursor) => {
          if (get().tool.cursorOverride === cursor) return;
          set((state) => {
            state.tool.cursorOverride = cursor;
          });
        },

        setStrokeWidth: (width) =>
          set((state) => {
            state.strokeWidth = width;
          }),

        setPenActiveSlot: (slot) =>
          set((state) => {
            state.pen.activeSlot = slot;
          }),
        setPenSlotColor: (color) =>
          set((state) => {
            state.pen.slots[state.pen.activeSlot] = color;
          }),
        setHighlighterActiveSlot: (slot) =>
          set((state) => {
            state.highlighter.activeSlot = slot;
          }),
        setHighlighterSlotColor: (color) =>
          set((state) => {
            state.highlighter.slots[state.highlighter.activeSlot] = color;
          }),
        setHighlighterOpacity: (opacity) =>
          set((state) => {
            state.highlighter.opacity = opacity;
          }),

        setShapeMode: (variant) =>
          set((state) => {
            state.tool.active = 'shape';
            state.shape.variant = variant;
          }),
        setShapeVariant: (variant) =>
          set((state) => {
            state.shape.variant = variant;
          }),
        setShapeColor: (color) =>
          set((state) => {
            state.shape.color = color;
          }),
        setShapeFillColor: (color) =>
          set((state) => {
            state.shape.fillColor = color;
          }),
        setShapeWidth: (width) =>
          set((state) => {
            state.shape.width = width;
          }),
        setShapeAlign: (align) =>
          set((state) => {
            state.shape.align = align;
          }),
        setShapeAlignV: (alignV) =>
          set((state) => {
            state.shape.alignV = alignV;
          }),

        setConnectorColor: (color) =>
          set((state) => {
            state.connector.color = color;
          }),
        setConnectorWidth: (width) =>
          set((state) => {
            state.connector.width = width;
          }),
        setConnectorType: (type) =>
          set((state) => {
            state.connector.type = type;
          }),
        setConnectorStartCap: (cap) =>
          set((state) => {
            state.connector.startCap = cap;
          }),
        setConnectorEndCap: (cap) =>
          set((state) => {
            state.connector.endCap = cap;
          }),
        setConnectorMode: (variant) =>
          set((state) => {
            const spec = CONNECTOR_VARIANT_SPECS[variant];
            if (spec.type === 'elbow') {
              state.connector.type = 'elbow';
            } else {
              state.connector.type = spec.type;
              state.connector.startCap = spec.startCap;
              state.connector.endCap = spec.endCap;
            }
          }),

        setTextColor: (color) =>
          set((state) => {
            state.text.color = color;
          }),
        setTextAlign: (align) =>
          set((state) => {
            state.text.align = align;
          }),
        setTextSize: (size) =>
          set((state) => {
            state.text.size = size;
          }),
        setTextFontFamily: (family) =>
          set((state) => {
            state.text.fontFamily = family;
          }),
        setTextHighlightColor: (color) =>
          set((state) => {
            state.text.highlightColor = color;
          }),
        setTextFillColor: (color) =>
          set((state) => {
            state.text.fillColor = color;
          }),

        setNoteAlign: (align) =>
          set((state) => {
            state.note.align = align;
          }),
        setNoteAlignV: (alignV) =>
          set((state) => {
            state.note.alignV = alignV;
          }),
        setNoteFontFamily: (family) =>
          set((state) => {
            state.note.fontFamily = family;
          }),

        setCodeLineNumbers: (v) =>
          set((state) => {
            state.code.lineNumbers = v;
          }),
        setCodeHeaderVisible: (v) =>
          set((state) => {
            state.code.headerVisible = v;
          }),
      })),
      {
        name: 'avlo.toolbar.v1',
        version: 1,
        storage: createJSONStorage(() => localStorage),
        partialize: (s) => ({
          user: s.user,
          strokeWidth: s.strokeWidth,
          pen: s.pen,
          highlighter: s.highlighter,
          shape: s.shape,
          connector: s.connector,
          text: s.text,
          note: s.note,
          code: s.code,
          // tool.active + tool.cursorOverride intentionally excluded.
        }),
      },
    ),
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

if (!useDeviceUIStore.getState().user.id) {
  const profile = generateUserProfile();
  useDeviceUIStore.setState({
    user: { id: ulid(), name: profile.name, color: profile.color },
  });
}

/** Imperative getter — returns the stable user ID string. */
export function getUserId(): string {
  return useDeviceUIStore.getState().user.id;
}

/** Imperative getter — returns the full user profile for presence. */
export function getUserProfile(): { userId: string; name: string; color: string } {
  const s = useDeviceUIStore.getState().user;
  return { userId: s.id, name: s.name, color: s.color };
}

// ============================================
// CURSOR MANAGEMENT
// ============================================

function computeBaseCursor(): string {
  const active = useDeviceUIStore.getState().tool.active;
  switch (active) {
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
  const override = useDeviceUIStore.getState().tool.cursorOverride;
  canvas.style.cursor = override ?? computeBaseCursor();
}

/**
 * Set a cursor override that takes priority over tool-based cursor.
 * Pass null to clear override.
 */
export function setCursorOverride(cursor: string | null): void {
  useDeviceUIStore.getState().setCursorOverride(cursor);
}

// Apply cursor whenever tool.active or tool.cursorOverride changes.
// Side-effect lives where the change is observed, not where it's set.
useDeviceUIStore.subscribe((s) => s.tool.active, applyCursor);
useDeviceUIStore.subscribe((s) => s.tool.cursorOverride, applyCursor);

// ============================================
// SELECTORS
// ============================================

// Scalar selectors — Object.is suffices, no shallow.
export const selectActiveTool = (s: DeviceUIState) => s.tool.active;
export const selectStrokeWidth = (s: DeviceUIState) => s.strokeWidth;
export const selectTextColor = (s: DeviceUIState) => s.text.color;
export const selectTextAlign = (s: DeviceUIState) => s.text.align;
export const selectTextSize = (s: DeviceUIState) => s.text.size;
export const selectTextHighlightColor = (s: DeviceUIState) => s.text.highlightColor;
export const selectTextFontFamily = (s: DeviceUIState) => s.text.fontFamily;

// Cluster selectors — return existing object references; consumers can use these
// directly because unrelated updates don't change the cluster's identity.
export const selectPen = (s: DeviceUIState) => s.pen;
export const selectHighlighter = (s: DeviceUIState) => s.highlighter;
export const selectShape = (s: DeviceUIState) => s.shape;
export const selectConnector = (s: DeviceUIState) => s.connector;
export const selectText = (s: DeviceUIState) => s.text;
export const selectNote = (s: DeviceUIState) => s.note;
export const selectCode = (s: DeviceUIState) => s.code;
export const selectUser = (s: DeviceUIState) => s.user;
