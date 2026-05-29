import { memo } from 'react';
import { IconLock } from './icons';
import { MenuButton } from './MenuButton';

// No-op placeholder — locking is not yet implemented.
export const LockButton = memo(function LockButton() {
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-lock" aria-label="Lock">
      <IconLock />
    </MenuButton>
  );
});
