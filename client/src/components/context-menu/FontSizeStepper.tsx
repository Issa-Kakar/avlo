import { TEXT_FONT_SIZE_PRESETS } from '@/stores/device-ui-store';
import { IconStepUp, IconStepDown } from './icons/UtilityIcons';
import { useDropdown } from './useDropdown';

interface FontSizeStepperProps {
  value: number;
  onDecrement?: () => void;
  onIncrement?: () => void;
  onSelectSize?: (size: number) => void;
}

export const FontSizeStepper = ({
  value,
  onDecrement,
  onIncrement,
  onSelectSize,
}: FontSizeStepperProps) => {
  const { open, containerRef, toggle, close } = useDropdown();
  const display = Math.min(999, Math.max(1, Math.round(value)));

  return (
    <div ref={containerRef} style={{ position: 'relative' }} className="ctx-fontsize-group">
      <button className="ctx-fontsize-value" onMouseDown={toggle}>
        <svg
          width={30}
          height={16}
          viewBox="0 0 30 16"
          fill="none"
          aria-hidden
          style={{ flexShrink: 0 }}
        >
          <text
            x="15"
            y="12"
            fill="#374151"
            fontSize="15"
            fontWeight="500"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
            textAnchor="middle"
          >
            {display}
          </text>
        </svg>
      </button>
      <div className="ctx-fontsize-arrows">
        <button
          className="ctx-fontsize-arrow"
          onMouseDown={(e) => {
            e.preventDefault();
            onIncrement?.();
          }}
        >
          <IconStepUp />
        </button>
        <button
          className="ctx-fontsize-arrow"
          onMouseDown={(e) => {
            e.preventDefault();
            onDecrement?.();
          }}
        >
          <IconStepDown />
        </button>
      </div>
      {open && (
        <div className="ctx-submenu ctx-submenu-fontsize">
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
                <span className="ctx-size-item-label">{preset}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
