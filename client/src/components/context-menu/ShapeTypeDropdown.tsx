import type React from 'react';
import { useState, useRef, useEffect } from 'react';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionStore } from '@/stores/selection-store';
import { setSelectedShapeType } from '@/lib/utils/selection-actions';
import { MenuButton } from './MenuButton';
import { IconChevronDown, IconCheck } from './icons/MenuIcons';
import { IconShapes, IconTextType } from './icons/FilterIcons';
import {
  IconRectType,
  IconCircleType,
  IconDiamondType,
  IconRoundedRectType,
} from './icons/ShapeTypeIcons';

const selectShapeType = (s: SelectionStore) => s.selectedStyles.shapeType;

const SHAPE_ICON: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  rect: IconRectType,
  ellipse: IconCircleType,
  diamond: IconDiamondType,
  roundedRect: IconRoundedRectType,
};

const TYPE_ITEMS: { key: string; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }[] =
  [
    { key: 'rect', label: 'Rectangle', Icon: IconRectType },
    { key: 'ellipse', label: 'Circle', Icon: IconCircleType },
    { key: 'diamond', label: 'Diamond', Icon: IconDiamondType },
    { key: 'roundedRect', label: 'Rounded', Icon: IconRoundedRectType },
    { key: 'text', label: 'Text', Icon: IconTextType },
  ];

interface ShapeTypeDropdownProps {
  mode: 'shapes' | 'text';
}

export function ShapeTypeDropdown({ mode }: ShapeTypeDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const shapeType = useSelectionStore(selectShapeType);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Trigger icon: text mode always shows T, shapes mode shows current type or composite
  const TriggerIcon =
    mode === 'text'
      ? IconTextType
      : shapeType
        ? (SHAPE_ICON[shapeType] ?? IconRectType)
        : IconShapes;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton
        className="ctx-btn-type"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <TriggerIcon width={16} height={16} />
        <IconChevronDown className="ctx-dd-arrow" />
      </MenuButton>

      {open && (
        <div className="ctx-submenu ctx-submenu-type">
          {TYPE_ITEMS.map(({ key, label, Icon }) => {
            const active = shapeType === key;
            return (
              <button
                key={key}
                className={`ctx-submenu-item ctx-type-item${active ? ' ctx-submenu-item-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (mode === 'shapes' && key !== 'text') {
                    setSelectedShapeType(key);
                  }
                  // text→shape and shape→text conversions: future
                  setOpen(false);
                }}
              >
                <Icon width={22} height={22} />
                <span>{label}</span>
                {active && <IconCheck width={16} height={16} className="ctx-type-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
