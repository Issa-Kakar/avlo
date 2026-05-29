import { Link } from '@tanstack/react-router';
import { HistoryButtons } from './HistoryButtons';
import { AvloLogo } from './icons/AvloLogo';
import { MainMenuTrigger } from './MainMenuTrigger';
import './TopBar.css';

export function TopBar() {
  return (
    <div className="top-bar top-bar-left">
      {/* Clickable wordmark → /home dashboard. preload="intent" warms the /home
          route chunk on hover so the nav is instant; safe because /home has no
          beforeLoad/loader (pure chunk fetch, zero side effects). Deliberately
          NOT a router-wide defaultPreload — the /room/$roomId route calls
          connectRoom() in beforeLoad, so intent-preloading a room link would
          spin up a Y.Doc + IndexedDB + WS provider on mere hover. Leaving the
          room unmounts RoomPage → its cleanup runs disconnectRoom() →
          roomDoc.destroy(): the same full teardown as always, no new wiring. */}
      <Link to="/home" preload="intent" className="top-bar-logo-link" aria-label="Home" title="Home">
        <AvloLogo className="top-bar-logo" height={34} />
      </Link>
      <span className="top-bar-name">Untitled</span>
      <MainMenuTrigger />
      <div className="top-bar-divider top-bar-divider-history" />
      <HistoryButtons />
    </div>
  );
}
