import { useState, useRef, useEffect } from 'react';
import { TEXT_FONT_SIZE_PRESETS } from '@/stores/device-ui-store';
import { MenuButton } from './MenuButton';
import { IconMinus, IconPlus, IconCheck } from './icons/UtilityIcons';

interface FontSizeStepperProps {
  value: number;
  onDecrement?: () => void;
  onIncrement?: () => void;
  onSelectSize?: (size: number) => void;
}

export const FontSizeStepper = ({ value, onDecrement, onIncrement, onSelectSize }: FontSizeStepperProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const display = Math.min(999, Math.max(1, Math.round(value)));

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }} className="ctx-size-group">
      <MenuButton className="ctx-size-btn" onClick={onDecrement}>
        <IconMinus width={12} height={12} />
      </MenuButton>
      <button
        className="ctx-size-value"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
      >
        <svg width={26} height={16} viewBox="0 0 26 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
          <text
            x="13" y="12"
            fill="#374151"
            fontSize="13" fontWeight="600"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
            textAnchor="middle"
          >
            {display}
          </text>
        </svg>
      </button>
      <MenuButton className="ctx-size-btn" onClick={onIncrement}>
        <IconPlus width={12} height={12} />
      </MenuButton>
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
                  setOpen(false);
                }}
              >
                {isActive && <IconCheck width={14} height={14} />}
                <span className="ctx-size-item-label">{preset}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
