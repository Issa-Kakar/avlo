import { MenuButton } from './MenuButton';
import { IconMinus, IconPlus } from './icons/UtilityIcons';

interface FontSizeStepperProps {
  value: number;
  onDecrement?: () => void;
  onIncrement?: () => void;
  onValueClick?: () => void;
}

export const FontSizeStepper = ({ value, onDecrement, onIncrement, onValueClick }: FontSizeStepperProps) => (
  <div className="ctx-size-group">
    <MenuButton className="ctx-size-btn" onClick={onDecrement}>
      <IconMinus width={12} height={12} />
    </MenuButton>
    <button
      className="ctx-size-value"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onValueClick}
    >
      <svg width={26} height={16} viewBox="0 0 26 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
        <text
          x="13" y="12"
          fill="#374151"
          fontSize="13" fontWeight="600"
          fontFamily="var(--font-stack)"
          textRendering="geometricPrecision"
          textAnchor="middle"
        >
          {value}
        </text>
      </svg>
    </button>
    <MenuButton className="ctx-size-btn" onClick={onIncrement}>
      <IconPlus width={12} height={12} />
    </MenuButton>
  </div>
);
