import type React from 'react';
import { useState, useRef, useEffect } from 'react';
import type { KindCounts } from '@/stores/selection-store';
import { MenuButton } from './MenuButton';
import { IconChevronDown } from './icons';
import { IconShapes, IconPenStroke, IconConnectorLine, IconTextType } from './icons';

type FilterKind = 'strokes' | 'shapes' | 'text' | 'connectors';

const KIND_CONFIG: {
  key: FilterKind;
  label: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
}[] = [
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
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton
        className="ctx-btn-filter"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <svg
          width={74}
          height={26}
          viewBox="0 0 74 26"
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <text
            x="0"
            y="9"
            fill="#6B7280"
            fontSize="10"
            fontWeight="500"
            letterSpacing="0.03em"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
          >
            FILTER
          </text>
          <text
            x="0"
            y="24"
            fill="#1F2937"
            fontSize="13"
            fontWeight="600"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
          >
            {kindCounts.total} objects
          </text>
        </svg>
        <IconChevronDown width={10} height={10} />
      </MenuButton>

      {open && (
        <div className="ctx-submenu ctx-submenu-filter">
          {KIND_CONFIG.map(({ key, label, Icon }) => {
            const count = kindCounts[key];
            if (count === 0) return null;
            return (
              <button
                key={key}
                className="ctx-submenu-item ctx-filter-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onFilterByKind(key);
                  setOpen(false);
                }}
              >
                <Icon width={22} height={22} />
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
