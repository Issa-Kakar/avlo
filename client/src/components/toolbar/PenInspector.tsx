import { IconInspectorHighlighter, IconInspectorPen } from '@/components/icons';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import * as A from './actions';
import { ColorSlots } from './ColorSlots';
import { SIZE_PRESETS, WEIGHT_ICONS } from './constants';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const clickPen = () => A.selectTool('pen');
const clickHighlighter = () => A.selectTool('highlighter');

export function PenInspector() {
  const activeTool = useDeviceUIStore((s) => s.activeTool);
  const currentSize = useDeviceUIStore((s) => s.drawingSettings.size);
  const isPickerOpen = useDeviceUIStore((s) => s.isColorPickerOpen);

  // Pull the right slot column based on active tool. Two narrow selectors
  // each — useDeviceUIStore returns a stable string/number reference,
  // and the tuple is replaced atomically in the store, so React.memo
  // children don't churn.
  const isPen = activeTool === 'pen';
  const colors = useDeviceUIStore((s) => (isPen ? s.penColorSlots : s.highlighterColorSlots));
  const activeSlot = useDeviceUIStore((s) => (isPen ? s.penActiveSlot : s.highlighterActiveSlot));

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
        return <WeightOption key={size} size={size} isActive={currentSize === size} Icon={Icon} />;
      })}

      <div className="inspector-divider" />

      <ColorSlots
        colors={colors}
        activeIndex={activeSlot}
        isPickerOpen={isPickerOpen}
        onSelectSlot={A.selectSlot}
        onTogglePicker={A.toggleColorPicker}
        onPickColor={A.setActiveSlotColor}
        onClosePicker={A.closeColorPicker}
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
  4: () => A.setStrokeSize(4),
  7: () => A.setStrokeSize(7),
  10: () => A.setStrokeSize(10),
  13: () => A.setStrokeSize(13),
};
