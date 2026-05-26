import type { FontFamily } from '@/core/accessors';
import { FONT_FAMILIES } from '@/core/text/text-system';
import { selectTextFontFamily, useDeviceUIStore } from '@/stores/device-ui-store';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedFontFamily } from '@/tools/selection/selection-actions';
import { IconCheck } from './icons/UtilityIcons';
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
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn min-w-14" onMouseDown={toggle} aria-expanded={open}>
        <svg width={40} height={16} viewBox="0 0 40 16" fill="none" aria-hidden="true" className="shrink-0">
          <text x="0" y="13" fill="#282e34" fontSize="15" fontWeight="500" fontFamily={cssFallback} textRendering="geometricPrecision">
            {current.display}
          </text>
        </svg>
      </MenuButton>

      {open && (
        <div className="ctx-submenu left-0 translate-x-0 min-w-[150px] rounded-xl p-2">
          {FONT_ITEMS.map(({ family, display }) => {
            const active = effective === family;
            return (
              <button
                key={family}
                className={`ctx-submenu-item ctx-type-item h-auto px-2 py-1.5 text-[15px] leading-[1.4]${active ? ' ctx-submenu-item-active' : ''}`}
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
