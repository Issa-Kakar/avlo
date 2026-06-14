import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { ChevronRightIcon } from './icons/ChevronRightIcon';

interface MainMenuItemProps {
  icon: ReactNode;
  label: string;
  hasChevron?: boolean;
  onClick?: () => void;
}

const preventFocus = (e: MouseEvent) => e.preventDefault();

/**
 * One row in the main menu — leading 20×20 icon, label, optional trailing
 * chevron-right for popouts. Geometry locked at 32×~186 (the 210-wide menu
 * minus its 12×2 padding); icon + chevron tint via `currentColor` so the row
 * recolors as a unit on hover.
 */
export const MainMenuItem = forwardRef<HTMLButtonElement, MainMenuItemProps>(function MainMenuItem(
  { icon, label, hasChevron = false, onClick },
  ref,
) {
  return (
    <button ref={ref} type="button" className="main-menu-item" tabIndex={-1} onMouseDown={preventFocus} onClick={onClick}>
      <span className="main-menu-item-icon">{icon}</span>
      <span className="main-menu-item-label">{label}</span>
      {hasChevron && (
        <span className="main-menu-item-chevron">
          <ChevronRightIcon />
        </span>
      )}
    </button>
  );
});
