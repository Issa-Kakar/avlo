import { AvloLogo } from './icons/AvloLogo';
import { SidebarIcon } from './icons/SidebarIcon';
import { KebabIcon } from './icons/KebabIcon';
import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar">
      {/* Sidebar toggle — standalone button */}
      <button className="top-bar-sidebar" aria-label="Toggle sidebar">
        <SidebarIcon className="top-bar-sidebar-icon" />
      </button>

      {/* Logo — decorative, not clickable */}
      <AvloLogo className="top-bar-logo" height={34} />

      <div className="top-bar-divider" />

      {/* Board name — cursor: text signals future inline editing */}
      <span className="top-bar-name">Untitled</span>

      {/* Board settings */}
      <button className="top-bar-settings" aria-label="Board settings">
        <KebabIcon />
      </button>
    </div>
  );
}
