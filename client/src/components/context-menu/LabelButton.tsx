import { memo } from 'react';
import { IconLabel } from './icons';
import { MenuButton } from './MenuButton';

// No-op placeholder — future "add connector label" entry-point. Icon ink lives
// at the menu's --ctx-engaged tone via `.ctx-btn-label`, matching the lock
// button's role as a primary visual element on the bar.
export const LabelButton = memo(function LabelButton() {
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-label" aria-label="Add label">
      <IconLabel />
    </MenuButton>
  );
});
