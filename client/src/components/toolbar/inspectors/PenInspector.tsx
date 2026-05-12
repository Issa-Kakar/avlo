import { useCallback, useState } from 'react';
import { IconInspectorHighlighter, IconInspectorPen } from '@/components/icons';
import {
  type SlotIndex,
  setActiveTool,
  setHighlighterActiveSlot,
  setHighlighterSlotColor,
  setPenActiveSlot,
  setPenSlotColor,
  setStrokeWidth,
  useDeviceUIStore,
} from '@/stores/device-ui-store';
import { ColorSlots } from '../color/ColorSlots';
import { SIZE_PRESETS, WEIGHT_ICONS } from '../weights';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const clickPen = () => setActiveTool('pen');
const clickHighlighter = () => setActiveTool('highlighter');

export function PenInspector() {
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const activeTool = useDeviceUIStore((s) => s.activeTool);
  const currentWidth = useDeviceUIStore((s) => s.strokeWidth);

  // Pull the right slot column based on active tool. Each tool has its own
  // independent active slot pointer; switching active tool replays that
  // tool's slot column.
  const isPen = activeTool === 'pen';
  const colors = useDeviceUIStore((s) => (isPen ? s.penSlots : s.highlighterSlots));
  const activeSlot = useDeviceUIStore((s) => (isPen ? s.penActiveSlot : s.highlighterActiveSlot));

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

      {SIZE_PRESETS.map((size, i) => {
        const Icon = WEIGHT_ICONS[i];
        return <WeightOption key={size} size={size} isActive={currentWidth === size} Icon={Icon} />;
      })}

      <div className="inspector-divider" />

      <ColorSlots
        colors={colors}
        activeIndex={activeSlot}
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
  size: 4 | 7 | 10 | 13;
  isActive: boolean;
  Icon: (typeof WEIGHT_ICONS)[number];
}

function WeightOption({ size, isActive, Icon }: WeightOptionProps) {
  // Per-button stable click via lookup so InspectorButton's memo holds.
  return (
    <InspectorButton isActive={isActive} ariaLabel={`Stroke width ${size}`} onClick={WEIGHT_HANDLERS[size]}>
      <Icon className="insp-icon" />
    </InspectorButton>
  );
}

// Module-level handler table — keeps every WeightOption click reference
// constant across renders, so InspectorButton's memo isn't defeated.
const WEIGHT_HANDLERS: Record<4 | 7 | 10 | 13, () => void> = {
  4: () => setStrokeWidth(4),
  7: () => setStrokeWidth(7),
  10: () => setStrokeWidth(10),
  13: () => setStrokeWidth(13),
};
