import { HistoryButtons } from './HistoryButtons';
import { AvloLogo } from './icons/AvloLogo';
import { MainMenuTrigger } from './MainMenuTrigger';
import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar top-bar-left">
      <AvloLogo className="top-bar-logo" height={34} />
      <span className="top-bar-name">Untitled</span>
      <MainMenuTrigger />
      <div className="top-bar-divider top-bar-divider-history" />
      <HistoryButtons />
    </div>
  );
}
