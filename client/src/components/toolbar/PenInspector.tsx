import { IconInspectorHighlighter, IconInspectorPen } from '@/components/icons';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import * as A from './actions';
import { ColorPopover } from './ColorPopover';
import { ColorSwatch } from './ColorSwatch';
import { FIXED_COLORS, isFixedColor, SIZE_PRESETS, WEIGHT_ICONS } from './constants';
import './PenInspector.css';

const clickPen = () => A.selectTool('pen');
const clickHighlighter = () => A.selectTool('highlighter');

export function PenInspector() {
  const activeTool = useDeviceUIStore((s) => s.activeTool);
  const currentSize = useDeviceUIStore((s) => s.drawingSettings.size);
  const currentColor = useDeviceUIStore((s) => s.drawingSettings.color);
  const isColorPopoverOpen = useDeviceUIStore((s) => s.isColorPopoverOpen);

  return (
    <div className="pen-inspector">
      <button className={`inspector-tool-btn ${activeTool === 'pen' ? 'active' : ''}`} onClick={clickPen} aria-label="Pen">
        <IconInspectorPen className="inspector-icon" />
      </button>
      <button
        className={`inspector-tool-btn ${activeTool === 'highlighter' ? 'active' : ''}`}
        onClick={clickHighlighter}
        aria-label="Highlighter"
      >
        <IconInspectorHighlighter className="inspector-icon" />
      </button>

      <div className="inspector-divider" />

      {SIZE_PRESETS.map((size, i) => {
        const Icon = WEIGHT_ICONS[i];
        return (
          <button
            key={size}
            className={`inspector-weight-btn ${currentSize === size ? 'active' : ''}`}
            onClick={() => A.setStrokeSize(size)}
            aria-label={`Stroke width ${size}`}
          >
            <Icon className="weight-icon" />
          </button>
        );
      })}

      <div className="inspector-divider" />

      <div className="inspector-colors">
        <button
          className="inspector-swatch inspector-swatch-plus"
          onClick={A.toggleColorPopover}
          aria-haspopup="dialog"
          aria-expanded={isColorPopoverOpen}
          aria-label="More colors"
        >
          {!isFixedColor(currentColor) && <div className="custom-color-dot" style={{ backgroundColor: currentColor }} />}
        </button>

        {FIXED_COLORS.map((c) => (
          <ColorSwatch key={c} color={c} isActive={currentColor === c} onSelect={A.setColor} />
        ))}

        {isColorPopoverOpen && <ColorPopover currentColor={currentColor} />}
      </div>
    </div>
  );
}
