import { useState, useRef, useEffect } from 'react';
import { CONTEXT_MENU_COLORS } from './color-palette';
import { MenuButton } from './MenuButton';
import { ColorCircle } from './ColorCircle';

interface ColorPickerPopoverProps {
  color: string;
  variant?: 'filled' | 'hollow' | 'none';
  secondColor?: string | null;
  onSelect?: (color: string) => void;
}

export function ColorPickerPopover({ color, variant = 'filled', secondColor, onSelect }: ColorPickerPopoverProps) {
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
        className="ctx-btn-color"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
      >
        <ColorCircle
          color={color}
          variant={variant}
          secondColor={secondColor}
        />
      </MenuButton>
      {open && (
        <div className="ctx-submenu" style={{ minWidth: 'auto', padding: 0 }}>
          <div className="ctx-color-grid">
            {CONTEXT_MENU_COLORS.map(c => (
              <button
                key={c}
                className="ctx-color-swatch"
                style={{ background: c }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect?.(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
