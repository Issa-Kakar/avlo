import { useState, useRef, useEffect } from 'react';
import { CONTEXT_MENU_COLORS } from './color-palette';
import { MenuButton } from './MenuButton';
import { TextColorIcon } from './icons';

interface TextColorPopoverProps {
  color: string;
  onSelect?: (color: string) => void;
}

export function TextColorPopover({ color, onSelect }: TextColorPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
        <TextColorIcon barColor={color} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu" style={{ minWidth: 'auto', padding: 0 }}>
          <div className="ctx-color-grid">
            {CONTEXT_MENU_COLORS.map((c, i) => {
              const isPastel = i >= 9;
              const isSelected = color === c;
              return (
                <button
                  key={c}
                  className={`ctx-color-swatch${isPastel ? ' pastel' : ''}${isSelected ? ' selected' : ''}`}
                  style={{ background: c }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect?.(c);
                    setOpen(false);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
