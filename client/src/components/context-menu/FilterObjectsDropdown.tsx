import { useState } from 'react';
import type { KindCounts } from '@/stores/selection-store';
import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons';
import { IconShapes, IconPenStroke, IconConnectorLine, IconTextType } from './icons';

type FilterKind = 'strokes' | 'shapes' | 'text' | 'connectors';

const KIND_CONFIG: { key: FilterKind; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { key: 'strokes', label: 'Strokes', Icon: IconPenStroke },
  { key: 'shapes', label: 'Shapes', Icon: IconShapes },
  { key: 'text', label: 'Text', Icon: IconTextType },
  { key: 'connectors', label: 'Connectors', Icon: IconConnectorLine },
];

interface FilterObjectsDropdownProps {
  kindCounts: KindCounts;
  onFilterByKind: (kind: FilterKind) => void;
}

export function FilterObjectsDropdown({ kindCounts, onFilterByKind }: FilterObjectsDropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative' }}>
      <MenuButton
        className="ctx-btn-filter"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
        aria-expanded={open}
      >
        <span className="ctx-filter-label">
          <span className="ctx-filter-title">Filter</span>
          <span className="ctx-filter-count">{kindCounts.total} objects</span>
        </span>
        <IconChevronDown width={10} height={10} />
      </MenuButton>

      {open && (
        <div className="ctx-submenu" onMouseLeave={() => setOpen(false)}>
          {KIND_CONFIG.map(({ key, label, Icon }) => {
            const count = kindCounts[key];
            if (count === 0) return null;
            return (
              <button
                key={key}
                className="ctx-submenu-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onFilterByKind(key);
                  setOpen(false);
                }}
              >
                <Icon width={20} height={20} />
                <span>{label}</span>
                <span className="ctx-filter-num">{count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
