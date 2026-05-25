import type React from 'react';
import { IconArrow } from '@/components/toolbar/icons/IconArrow';
import { IconCode } from '@/components/toolbar/icons/IconCode';
import { IconImage } from '@/components/toolbar/icons/IconImage';
import { IconLink } from '@/components/toolbar/icons/IconLink';
import { IconPen } from '@/components/toolbar/icons/IconPen';
import { IconShapes } from '@/components/toolbar/icons/IconShapes';
import { IconStickyNote } from '@/components/toolbar/icons/IconStickyNote';
import { IconText } from '@/components/toolbar/icons/IconText';
import type { ObjectKind } from '@/core/types/objects';
import type { KindCounts } from '@/tools/selection/types';
import { IconChevronDown } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

// Keys are ObjectKind (singular), matching KindCounts / SelectionKind exactly.
const KIND_CONFIG: {
  key: ObjectKind;
  label: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
}[] = [
  { key: 'stroke', label: 'Stroke', Icon: IconPen },
  { key: 'shape', label: 'Shape', Icon: IconShapes },
  { key: 'text', label: 'Text', Icon: IconText },
  { key: 'connector', label: 'Connector', Icon: IconArrow },
  { key: 'code', label: 'Code Block', Icon: IconCode },
  { key: 'note', label: 'Sticky Note', Icon: IconStickyNote },
  { key: 'image', label: 'Image', Icon: IconImage },
  { key: 'bookmark', label: 'Link', Icon: IconLink },
];

interface FilterObjectsDropdownProps {
  kindCounts: KindCounts;
  onFilterByKind: (kind: ObjectKind) => void;
}

export function FilterObjectsDropdown({ kindCounts, onFilterByKind }: FilterObjectsDropdownProps) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-filter" onMouseDown={toggle} aria-expanded={open}>
        <svg width={74} height={26} viewBox="0 0 74 26" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <text className="ctx-filter-trigger-label" x="0" y="9">
            FILTER
          </text>
          <text className="ctx-filter-trigger-total" x="0" y="24">
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
                  close();
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
