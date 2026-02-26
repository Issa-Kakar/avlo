import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons/MenuIcons';

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
    <svg
      width={52}
      height={16}
      viewBox="0 0 52 16"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <text
        x="0"
        y="13"
        fill="#374151"
        fontSize="14"
        fontWeight="500"
        fontFamily={fontFamily}
        textRendering="geometricPrecision"
      >
        {name}
      </text>
    </svg>
    <IconChevronDown width={10} height={10} />
  </MenuButton>
);
