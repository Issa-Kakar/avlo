import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons';

interface TypefaceButtonProps {
  name?: string;
  fontFamily?: string;
  onClick?: () => void;
}

export const TypefaceButton = ({
  name = 'Draw',
  fontFamily = 'Grandstander, cursive',
  onClick,
}: TypefaceButtonProps) => (
  <MenuButton className="ctx-btn-font" onClick={onClick}>
    <span className="ctx-font-name" style={{ fontFamily }}>{name}</span>
    <IconChevronDown />
  </MenuButton>
);
