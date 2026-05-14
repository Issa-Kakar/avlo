import { useCallback, useState } from 'react';
import { IconInspectorHighlighter, IconInspectorPen } from '@/components/icons';
import {
  type SlotIndex,
  type StrokeTool,
  selectStrokeWidth,
  setActiveTool,
  setStrokeActiveSlot,
  setStrokeSlotColor,
  setStrokeWidth,
  useDeviceUIStore,
} from '@/stores/device-ui-store';
import { ColorSlots } from '../color/ColorSlots';
import { InspectorButton } from './InspectorButton';
import { WeightSelector } from './WeightSelector';
import './Inspector.css';

const clickPen = () => setActiveTool('pen');
const clickHighlighter = () => setActiveTool('highlighter');

export function PenInspector({ tool }: { tool: StrokeTool }) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const currentWidth = useDeviceUIStore(selectStrokeWidth);

  // Each stroke tool has its own independent slot column + active-slot pointer;
  // the cluster ref only changes when its own fields change.
  const cluster = useDeviceUIStore((s) => s.strokeTools[tool]);

  const handleSelectSlot = useCallback(
    (slot: SlotIndex) => {
      setStrokeActiveSlot(tool, slot);
      setIsPickerOpen(false);
    },
    [tool],
  );
  const handlePick = useCallback(
    (color: string) => {
      setStrokeSlotColor(tool, color);
      setIsPickerOpen(false);
    },
    [tool],
  );
  const handleToggle = useCallback(() => setIsPickerOpen((v) => !v), []);
  const handleClose = useCallback(() => setIsPickerOpen(false), []);

  return (
    <div className="inspector inspector-pen">
      <InspectorButton isActive={tool === 'pen'} ariaLabel="Pen" onClick={clickPen}>
        <IconInspectorPen className="insp-icon" />
      </InspectorButton>
      <InspectorButton isActive={tool === 'highlighter'} ariaLabel="Highlighter" onClick={clickHighlighter}>
        <IconInspectorHighlighter className="insp-icon" />
      </InspectorButton>

      <div className="inspector-divider" />

      <WeightSelector value={currentWidth} onChange={setStrokeWidth} />

      <div className="inspector-divider" />

      <ColorSlots
        slots={cluster.slots}
        activeSlot={cluster.activeSlot}
        isPickerOpen={isPickerOpen}
        onSelectSlot={handleSelectSlot}
        onTogglePicker={handleToggle}
        onPickColor={handlePick}
        onClosePicker={handleClose}
      />
    </div>
  );
}
