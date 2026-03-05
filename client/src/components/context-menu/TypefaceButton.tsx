import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionStore } from '@/stores/selection-store';
import { setSelectedFontFamily } from '@/lib/utils/selection-actions';
import type { FontFamily } from '@avlo/shared';
import { FONT_FAMILIES } from '@/lib/text/text-system';
import { MenuButton } from './MenuButton';
import { IconChevronDown, IconCheck } from './icons/UtilityIcons';
import { useDropdown } from './useDropdown';

const selectFontFamily = (s: SelectionStore) => s.selectedStyles.fontFamily;

const FONT_ITEMS: { family: FontFamily; display: string }[] = [
  { family: 'Grandstander', display: 'Draw' },
  { family: 'Inter', display: 'Inter' },
  { family: 'Lora', display: 'Lora' },
  { family: 'JetBrains Mono', display: 'Mono' },
];

export function TypefaceButton() {
  const { open, containerRef, toggle, close } = useDropdown();
  const fontFamily = useSelectionStore(selectFontFamily);

  const current = FONT_ITEMS.find((f) => f.family === fontFamily) ?? FONT_ITEMS[0];
  const cssFallback = FONT_FAMILIES[current.family].fallback;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-font" onMouseDown={toggle} aria-expanded={open}>
        <svg
          width={52}
          height={16}
          viewBox="0 0 52 16"
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <text
            x="0"
            y="13"
            fill="#374151"
            fontSize="14"
            fontWeight="500"
            fontFamily={cssFallback}
            textRendering="geometricPrecision"
          >
            {current.display}
          </text>
        </svg>
        <IconChevronDown className="ctx-dd-arrow" />
      </MenuButton>

      {open && (
        <div className="ctx-submenu ctx-submenu-font">
          {FONT_ITEMS.map(({ family, display }) => {
            const active = fontFamily === family;
            return (
              <button
                key={family}
                className={`ctx-submenu-item ctx-type-item${active ? ' ctx-submenu-item-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSelectedFontFamily(family);
                  close();
                }}
              >
                <span style={{ fontFamily: FONT_FAMILIES[family].fallback }}>{display}</span>
                {active && <IconCheck width={16} height={16} className="ctx-type-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
