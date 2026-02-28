import { useState, useRef, useEffect } from 'react';
import { HIGHLIGHT_COLORS } from '@/stores/device-ui-store';
import { useSelectionStore, selectInlineHighlightColor } from '@/stores/selection-store';
import { MenuButton } from './MenuButton';
import { HighlightIcon } from './icons';

interface HighlightPickerPopoverProps {
  onSelect?: (color: string | null) => void;
}

export function HighlightPickerPopover({ onSelect }: HighlightPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightColor = useSelectionStore(selectInlineHighlightColor);

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
        <HighlightIcon barColor={highlightColor} width={20} height={20} />
      </MenuButton>
      {open && (
        <div className="ctx-submenu ctx-submenu-highlight">
          <div className="ctx-highlight-grid">
            {HIGHLIGHT_COLORS.map((c, i) => {
              const isSelected = highlightColor === c;
              if (c === null) {
                return (
                  <button
                    key="none"
                    className={`ctx-highlight-swatch ctx-highlight-swatch-none${isSelected ? ' selected' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect?.(null);
                      setOpen(false);
                    }}
                  >
                    <span className="ctx-highlight-slash" />
                  </button>
                );
              }
              return (
                <button
                  key={i}
                  className={`ctx-highlight-swatch${isSelected ? ' selected' : ''}`}
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
