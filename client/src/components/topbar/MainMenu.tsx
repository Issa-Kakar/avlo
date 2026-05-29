import { BoardIcon } from './icons/BoardIcon';
import { EditIcon } from './icons/EditIcon';
import { ExportIcon } from './icons/ExportIcon';
import { KeyboardIcon } from './icons/KeyboardIcon';
import { PreferencesIcon } from './icons/PreferencesIcon';
import { MainMenuItem } from './MainMenuItem';

interface MainMenuProps {
  onClose: () => void;
}

/**
 * Dropdown popover for the top-bar main menu. Scaffold only — no actions
 * wired yet; Board / Edit / Preferences carry the chevron-right since they
 * will eventually open popouts. Three groups split by hairlines, mirroring
 * the reference: Export · {Board, Edit, Preferences} · Keyboard shortcuts.
 */
export function MainMenu({ onClose }: MainMenuProps) {
  return (
    <div className="main-menu" role="menu">
      <MainMenuItem icon={<ExportIcon />} label="Export" onClick={onClose} />

      <div className="main-menu-divider" />

      <MainMenuItem icon={<BoardIcon />} label="Board" hasChevron onClick={onClose} />
      <MainMenuItem icon={<EditIcon />} label="Edit" hasChevron onClick={onClose} />
      <MainMenuItem icon={<PreferencesIcon />} label="Preferences" hasChevron onClick={onClose} />

      <div className="main-menu-divider" />

      <MainMenuItem icon={<KeyboardIcon />} label="Keyboard shortcuts" onClick={onClose} />
    </div>
  );
}
