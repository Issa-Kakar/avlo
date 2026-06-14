import type React from 'react';
import { IconStickyNote } from '@/components/toolbar/icons/IconStickyNote';
import { IconText } from '@/components/toolbar/icons/IconText';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { convertSelectionTo, convertSelectionToShape, setSelectedShapeType } from '@/tools/selection/selection-actions';
import {
  IconSwitchType,
  IconSwitchTypeCircle,
  IconSwitchTypeDiamond,
  IconSwitchTypeRect,
  IconSwitchTypeRoundedRect,
  IconSwitchTypeTriangle,
} from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

const selectShapeType = (s: SelectionStore) => s.selectedStyles.shapeType;

// Grid flow: 4 columns × 2 rows, one trailing empty cell.
//   [Sticky] [Text]    [Rect]   [Circle]
//   [Diamond][Triangle][Rounded][ ]
interface TypeItem {
  key: string;
  label: string;
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
}

const ITEMS: readonly TypeItem[] = [
  { key: 'note', label: 'Sticky note', Icon: IconStickyNote },
  { key: 'text', label: 'Text', Icon: IconText },
  { key: 'rect', label: 'Rectangle', Icon: IconSwitchTypeRect },
  { key: 'ellipse', label: 'Circle', Icon: IconSwitchTypeCircle },
  { key: 'diamond', label: 'Diamond', Icon: IconSwitchTypeDiamond },
  { key: 'triangle', label: 'Triangle', Icon: IconSwitchTypeTriangle },
  { key: 'roundedRect', label: 'Rounded', Icon: IconSwitchTypeRoundedRect },
];

interface ShapeTypeDropdownProps {
  mode: 'shapes' | 'text' | 'note';
}

/**
 * Type-switch dropdown — rightmost button on the shape/text/note bars.
 * Trigger is the Mural `switchType` glyph (engaged-dark fill flip on open);
 * popout is an icon-only 4×2 grid. Active cell fills `--ctx-engaged` with a
 * white icon — no checkmark, the active state is the button itself.
 *
 * Active resolution: text bar → `text` row; note bar → `note` row; shape
 * bar → live `shapeType` row (null = mixed → no active row).
 */
export function ShapeTypeDropdown({ mode }: ShapeTypeDropdownProps) {
  const { open, containerRef, toggle, close } = useDropdown();
  const shapeType = useSelectionStore(selectShapeType);

  const activeKey = mode === 'shapes' ? shapeType : mode === 'text' ? 'text' : 'note';

  return (
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-sq ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open} aria-label="Switch type">
        <IconSwitchType />
      </MenuButton>

      {open && (
        <div className="ctx-submenu left-auto right-0 translate-x-0 min-w-0 p-2 grid grid-cols-[repeat(4,36px)] auto-rows-[36px] gap-1">
          {ITEMS.map(({ key, label, Icon }) => {
            const active = activeKey === key;
            return (
              <button
                key={key}
                type="button"
                className={`size-9 inline-flex items-center justify-center border-0 rounded-lg cursor-pointer p-0 outline-none ${
                  active
                    ? 'bg-[var(--ctx-engaged)] text-white hover:bg-[var(--ctx-engaged)]'
                    : 'bg-transparent text-[var(--ctx-engaged)] hover:bg-[var(--ctx-hover)]'
                }`}
                aria-label={label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (key === 'note' || key === 'text') {
                    if (key !== activeKey) convertSelectionTo(key);
                  } else if (mode === 'shapes') {
                    setSelectedShapeType(key);
                  } else {
                    convertSelectionToShape(key);
                  }
                  close();
                }}
              >
                <Icon width={24} height={24} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
