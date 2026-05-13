import { useCallback, useState } from 'react';
import { IconInspectorHighlighter, IconInspectorPen } from '@/components/icons';
import {
  type SlotIndex,
  selectActiveTool,
  selectStrokeWidth,
  setActiveTool,
  setHighlighterActiveSlot,
  setHighlighterSlotColor,
  setPenActiveSlot,
  setPenSlotColor,
  setStrokeWidth,
  useDeviceUIStore,
} from '@/stores/device-ui-store';
import { ColorSlots } from '../color/ColorSlots';
import { STROKE_WEIGHTS, type StrokeWeightOption, type StrokeWidthPreset } from '../weights';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const clickPen = () => setActiveTool('pen');
const clickHighlighter = () => setActiveTool('highlighter');

export function PenInspector() {
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const activeTool = useDeviceUIStore(selectActiveTool);
  const currentWidth = useDeviceUIStore(selectStrokeWidth);

  // Pull the right cluster based on active tool. Each tool has its own
  // independent active slot pointer; switching tool replays that tool's
  // slot column. The cluster ref only changes when its own fields change.
  const isPen = activeTool === 'pen';
  const tool = useDeviceUIStore((s) => (isPen ? s.pen : s.highlighter));

  const handleSelectSlot = useCallback(
    (slot: number) => {
      if (isPen) setPenActiveSlot(slot as SlotIndex);
      else setHighlighterActiveSlot(slot as SlotIndex);
      setIsPickerOpen(false);
    },
    [isPen],
  );
  const handlePick = useCallback(
    (color: string) => {
      if (isPen) setPenSlotColor(color);
      else setHighlighterSlotColor(color);
      setIsPickerOpen(false);
    },
    [isPen],
  );
  const handleToggle = useCallback(() => setIsPickerOpen((v) => !v), []);
  const handleClose = useCallback(() => setIsPickerOpen(false), []);

  return (
    <div className="inspector inspector-pen">
      <InspectorButton isActive={activeTool === 'pen'} ariaLabel="Pen" onClick={clickPen}>
        <IconInspectorPen className="insp-icon" />
      </InspectorButton>
      <InspectorButton isActive={activeTool === 'highlighter'} ariaLabel="Highlighter" onClick={clickHighlighter}>
        <IconInspectorHighlighter className="insp-icon" />
      </InspectorButton>

      <div className="inspector-divider" />

      {STROKE_WEIGHTS.map(({ width, Icon }) => (
        <WeightOption key={width} width={width} isActive={currentWidth === width} Icon={Icon} />
      ))}

      <div className="inspector-divider" />

      <ColorSlots
        colors={tool.slots}
        activeIndex={tool.activeSlot}
        isPickerOpen={isPickerOpen}
        onSelectSlot={handleSelectSlot}
        onTogglePicker={handleToggle}
        onPickColor={handlePick}
        onClosePicker={handleClose}
      />
    </div>
  );
}

interface WeightOptionProps {
  width: StrokeWidthPreset;
  isActive: boolean;
  Icon: StrokeWeightOption['Icon'];
}

function WeightOption({ width, isActive, Icon }: WeightOptionProps) {
  // Per-button stable click via lookup so InspectorButton's memo holds.
  return (
    <InspectorButton isActive={isActive} ariaLabel={`Stroke width ${width}`} onClick={WEIGHT_HANDLERS[width]}>
      <Icon className="insp-icon" />
    </InspectorButton>
  );
}

// Module-level handler table — keeps every WeightOption click reference
// constant across renders, so InspectorButton's memo isn't defeated.
const WEIGHT_HANDLERS: Record<StrokeWidthPreset, () => void> = {
  4: () => setStrokeWidth(4),
  7: () => setStrokeWidth(7),
  10: () => setStrokeWidth(10),
  13: () => setStrokeWidth(13),
};
