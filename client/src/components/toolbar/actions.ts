import { openImageFilePicker } from '@/core/image/image-actions';
import { getActiveRoomDoc, hasActiveRoom } from '@/runtime/room-runtime';
import { type ShapeVariant, type SizePreset, type Tool, useDeviceUIStore } from '@/stores/device-ui-store';

export const selectTool = (tool: Tool) => useDeviceUIStore.getState().setActiveTool(tool);

export const selectShape = (variant: ShapeVariant) => {
  const s = useDeviceUIStore.getState();
  s.setActiveTool('shape');
  s.setShapeVariant(variant);
};

export const pickImage = () => openImageFilePicker();

export const undo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().undo();
};

export const redo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().redo();
};

export const setStrokeSize = (size: SizePreset) => useDeviceUIStore.getState().setDrawingSize(size);

export const setColor = (color: string) => useDeviceUIStore.getState().setDrawingColor(color);

export const pickCustomColor = (color: string) => {
  const s = useDeviceUIStore.getState();
  s.setDrawingColor(color);
  s.addRecentColor(color);
  if (s.isColorPopoverOpen) s.setColorPopoverOpen(false);
};

export const toggleColorPopover = () => {
  const s = useDeviceUIStore.getState();
  s.setColorPopoverOpen(!s.isColorPopoverOpen);
};

export const closeColorPopover = () => useDeviceUIStore.getState().setColorPopoverOpen(false);
