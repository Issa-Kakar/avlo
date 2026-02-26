import { MenuButton } from './MenuButton';
import { IconMinus, IconPlus } from './icons/MenuIcons';

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
      {value}
    </button>
    <MenuButton className="ctx-size-btn" onClick={onIncrement}>
      <IconPlus width={12} height={12} />
    </MenuButton>
  </div>
);
