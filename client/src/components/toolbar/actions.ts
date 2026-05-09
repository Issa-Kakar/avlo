import { openImageFilePicker } from '@/core/image/image-actions';
import { getActiveRoomDoc, hasActiveRoom } from '@/runtime/room-runtime';
import {
  type ConnectorVariant,
  type ShapeVariant,
  type SizePreset,
  type SlotIndex,
  type Tool,
  useDeviceUIStore,
} from '@/stores/device-ui-store';

// Tool selection ------------------------------------------------------------
export const selectTool = (tool: Tool) => useDeviceUIStore.getState().setActiveTool(tool);

export const selectShape = (variant: ShapeVariant) => {
  const s = useDeviceUIStore.getState();
  s.setActiveTool('shape');
  s.setShapeVariant(variant);
};

export const pickImage = () => openImageFilePicker();

// History -------------------------------------------------------------------
export const undo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().undo();
};

export const redo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().redo();
};

// Pen / highlighter ---------------------------------------------------------
export const setStrokeSize = (size: SizePreset) => useDeviceUIStore.getState().setDrawingSize(size);

export const selectSlot = (slot: number) => useDeviceUIStore.getState().setActiveSlot(slot as SlotIndex);

// Picking a color (slot OR connector) commits the color AND closes the picker.
// Centralized here so every entry point — palette swatch, hex submit — gets
// the close-on-pick behavior without each callsite having to remember it.
export const setActiveSlotColor = (color: string) => {
  const s = useDeviceUIStore.getState();
  s.setActiveSlotColor(color);
  s.setColorPickerOpen(false);
};

// Connector -----------------------------------------------------------------
export const setConnectorVariant = (variant: ConnectorVariant) => useDeviceUIStore.getState().setConnectorVariant(variant);

export const setConnectorColor = (color: string) => {
  const s = useDeviceUIStore.getState();
  s.setConnectorColor(color);
  s.setColorPickerOpen(false);
};

// Color picker visibility ---------------------------------------------------
export const toggleColorPicker = () => useDeviceUIStore.getState().toggleColorPicker();
export const closeColorPicker = () => useDeviceUIStore.getState().setColorPickerOpen(false);
