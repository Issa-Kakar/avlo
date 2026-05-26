import { TEXT_FONT_SIZE_PRESETS } from '@/stores/device-ui-store';
import { IconStepDown, IconStepUp } from './icons/UtilityIcons';
import { useDropdown } from './useDropdown';

interface FontSizeStepperProps {
  value: number;
  onDecrement?: () => void;
  onIncrement?: () => void;
  onSelectSize?: (size: number) => void;
}

const VALUE_BTN =
  'size-8 inline-flex items-center justify-center bg-transparent border-0 p-0 text-[var(--ctx-engaged)] font-ui text-[13px] font-medium tabular-nums cursor-pointer outline-none hover:bg-[var(--ctx-hover)] hover:rounded focus-visible:outline-2 focus-visible:outline-[var(--ctx-accent)] focus-visible:-outline-offset-1 focus-visible:rounded';

const ARROW_BTN =
  'w-[18px] h-3 inline-flex items-center justify-center bg-transparent border-0 p-0 text-[var(--ctx-engaged)] cursor-pointer outline-none rounded-[3px] transition-colors duration-150 hover:bg-[var(--ctx-hover)] active:bg-[var(--ctx-black-a12)] focus-visible:outline-2 focus-visible:outline-[var(--ctx-accent)] focus-visible:-outline-offset-1 [&_svg]:w-[11px] [&_svg]:h-[6.5px]';

export const FontSizeStepper = ({ value, onDecrement, onIncrement, onSelectSize }: FontSizeStepperProps) => {
  const { open, containerRef, toggle, close } = useDropdown();
  const display = Math.min(999, Math.max(1, Math.round(value)));

  return (
    <div className="flex items-center gap-1 mx-[5px]">
      <div ref={containerRef} className="relative">
        <button className={VALUE_BTN} onMouseDown={toggle}>
          <svg width={30} height={16} viewBox="0 0 30 16" fill="none" aria-hidden className="shrink-0">
            <text
              x="15"
              y="12"
              fill="currentColor"
              fontSize="15"
              fontWeight="550"
              fontFamily="var(--font-ui)"
              textRendering="geometricPrecision"
              textAnchor="middle"
            >
              {display}
            </text>
          </svg>
        </button>
        {open && (
          <div className="ctx-submenu min-w-0 p-2.5 [&_.ctx-submenu-item]:w-8 [&_.ctx-submenu-item]:justify-center [&_.ctx-submenu-item]:px-0">
            {TEXT_FONT_SIZE_PRESETS.map((preset) => {
              const isActive = preset === display;
              return (
                <button
                  key={preset}
                  className={`ctx-submenu-item${isActive ? ' ctx-submenu-item-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectSize?.(preset);
                    close();
                  }}
                >
                  <span className="font-[550] text-[15px] min-w-6">{preset}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-col w-[18px] gap-px">
        <button
          className={ARROW_BTN}
          onMouseDown={(e) => {
            e.preventDefault();
            onIncrement?.();
          }}
        >
          <IconStepUp />
        </button>
        <button
          className={ARROW_BTN}
          onMouseDown={(e) => {
            e.preventDefault();
            onDecrement?.();
          }}
        >
          <IconStepDown />
        </button>
      </div>
    </div>
  );
};
