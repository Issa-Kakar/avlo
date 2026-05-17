import { HistoryButtons } from './HistoryButtons';
import { AvloLogo } from './icons/AvloLogo';
import { KebabIcon } from './icons/KebabIcon';
import { SidebarIcon } from './icons/SidebarIcon';
import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar">
      <button className="top-bar-sidebar" aria-label="Toggle sidebar" tabIndex={-1}>
        <SidebarIcon className="top-bar-sidebar-icon" />
      </button>
      <AvloLogo className="top-bar-logo" height={34} />
      <div className="top-bar-divider" />
      <span className="top-bar-name">Untitled</span>
      <button className="top-bar-settings" aria-label="Board settings" tabIndex={-1}>
        <KebabIcon />
      </button>
      <div className="top-bar-divider top-bar-divider-history" />
      <HistoryButtons />
    </div>
  );
}
