import { memo } from 'react';
import { useSelectionStore } from '@/stores/selection-store';
import { toggleSelectedLocked } from '@/tools/selection/selection-actions';
import { IconLock } from './icons';
import { MenuButton } from './MenuButton';

// Durable-lock toggle — leftmost on every bar; the ENTIRE bar when the selection is
// locked (ContextMenuBar skips the per-kind menu). `.ctx-btn-fmt` supplies the active
// dark-fill state (buttons.css) — no lock-specific CSS.
export const LockButton = memo(function LockButton() {
  const locked = useSelectionStore((s) => s.selectionLocked);
  return (
    <MenuButton
      className="ctx-btn-sq ctx-btn-fmt ctx-btn-lock"
      aria-label={locked ? 'Unlock' : 'Lock'}
      active={locked}
      onMouseDown={toggleSelectedLocked}
    >
      <IconLock />
    </MenuButton>
  );
});
