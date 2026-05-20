import { memo } from 'react';
import { IconMoreDots } from './icons';
import { MenuButton } from './MenuButton';

export const OverflowButton = memo(function OverflowButton() {
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-more">
      <IconMoreDots />
    </MenuButton>
  );
});
