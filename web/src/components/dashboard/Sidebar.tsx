import type { ReactNode } from 'react';
import { AvloLogo } from '@/components/topbar/icons/AvloLogo';
import type { DashboardView } from './Dashboard';
import { HomeIcon } from './icons/HomeIcon';
import { RecentIcon } from './icons/RecentIcon';
import { StarIcon } from './icons/StarIcon';

const NAV: readonly { view: DashboardView; label: string; icon: ReactNode }[] = [
  { view: 'home', label: 'Home', icon: <HomeIcon width={22} height={22} /> },
  { view: 'recent', label: 'Recent', icon: <RecentIcon width={22} height={22} /> },
  { view: 'starred', label: 'Starred', icon: <StarIcon width={22} height={22} filled /> },
];

interface SidebarProps {
  view: DashboardView;
  onSelect: (view: DashboardView) => void;
}

export function Sidebar({ view, onSelect }: SidebarProps) {
  return (
    <aside className="dash-sidebar">
      <div className="dash-logo">
        <AvloLogo height={48} />
      </div>

      <nav className="dash-nav">
        {NAV.map((item) => {
          const active = item.view === view;
          return (
            <button
              key={item.view}
              type="button"
              className={active ? 'dash-nav-item dash-nav-active' : 'dash-nav-item'}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(item.view)}
            >
              <span className="dash-nav-icon">{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
