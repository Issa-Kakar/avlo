import type { FontFamily } from '@/core/accessors';
import { FONT_FAMILIES } from '@/core/text/text-system';
import { selectTextFontFamily, useDeviceUIStore } from '@/stores/device-ui-store';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedFontFamily } from '@/tools/selection/selection-actions';
import { IconCheck, IconChevronDownFilled } from './icons/UtilityIcons';
import { MenuButton } from './MenuButton';
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
  const fallbackFamily = useDeviceUIStore(selectTextFontFamily);
  const effective = fontFamily ?? fallbackFamily;

  const current = FONT_ITEMS.find((f) => f.family === effective) ?? FONT_ITEMS[0];
  const cssFallback = FONT_FAMILIES[current.family].fallback;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-font" onMouseDown={toggle} aria-expanded={open}>
        <svg width={40} height={16} viewBox="0 0 40 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <text x="0" y="13" fill="#282e34" fontSize="15" fontWeight="500" fontFamily={cssFallback} textRendering="geometricPrecision">
            {current.display}
          </text>
        </svg>
        <IconChevronDownFilled className="ctx-font-chevron" />
      </MenuButton>

      {open && (
        <div className="ctx-submenu ctx-submenu-font">
          {FONT_ITEMS.map(({ family, display }) => {
            const active = effective === family;
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
