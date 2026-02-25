import { MenuButton } from './MenuButton';
import { IconMinus, IconPlus } from './icons';

interface SizeStepperProps {
  value: number;
  onDecrement?: () => void;
  onIncrement?: () => void;
  onValueClick?: () => void;
}

export const SizeStepper = ({ value, onDecrement, onIncrement, onValueClick }: SizeStepperProps) => (
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
