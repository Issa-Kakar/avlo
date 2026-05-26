import { HistoryButtons } from './HistoryButtons';
import { AvloLogo } from './icons/AvloLogo';
import { SidebarIcon } from './icons/SidebarIcon';
import { MainMenuTrigger } from './MainMenuTrigger';
import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar top-bar-left">
      <button className="top-bar-sidebar" aria-label="Toggle sidebar" tabIndex={-1}>
        <SidebarIcon className="top-bar-sidebar-icon" />
      </button>
      <AvloLogo className="top-bar-logo" height={34} />
      <div className="top-bar-divider" />
      <span className="top-bar-name">Untitled</span>
      <MainMenuTrigger />
      <div className="top-bar-divider top-bar-divider-history" />
      <HistoryButtons />
    </div>
  );
}
