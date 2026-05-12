import { memo, useEffect, useRef, useState } from 'react';
import { CheckIcon } from './CheckIcon';
import { checkmarkColorFor, colorsEqual, isDark, PALETTE, PALETTE_COLS } from './palette';

interface Props {
  /** The currently-selected color (gets the checkmark in the grid). */
  currentColor: string;
  onPick: (color: string) => void;
  onClose: () => void;
}

interface SwatchProps {
  color: string;
  isActive: boolean;
  onPick: (color: string) => void;
}

const Swatch = memo(function Swatch({ color, isActive, onPick }: SwatchProps) {
  return (
    <button
      className={`picker-swatch ${isActive ? 'is-active' : ''}`}
      data-dark={isDark(color) || undefined}
      style={{ backgroundColor: color }}
      aria-label={`Color ${color}`}
      onClick={() => onPick(color)}
    >
      {isActive && <CheckIcon color={checkmarkColorFor(color)} size={13} />}
    </button>
  );
});

/** 24-color grid + custom-hex entry. Closes on outside click. */
export const ColorPicker = memo(function ColorPicker({ currentColor, onPick, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hexDraft, setHexDraft] = useState('');
  const [showHex, setShowHex] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      const target = e.target as Node;
      // Clicks inside the picker OR inside the slots column shouldn't close
      // (the slot's own toggle handler manages those).
      if (rootRef.current.contains(target)) return;
      const slotsRoot = rootRef.current.closest('.color-slots');
      if (slotsRoot && slotsRoot.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onClose]);

  const submitHex = () => {
    const v = hexDraft.trim();
    const normalized = v.startsWith('#') ? v : `#${v}`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) {
      onPick(normalized);
      setHexDraft('');
      setShowHex(false);
    }
  };

  return (
    <div ref={rootRef} className="color-picker" role="dialog" aria-label="Pick a color">
      <div className="picker-grid" style={{ gridTemplateColumns: `repeat(${PALETTE_COLS}, 1fr)` }}>
        {PALETTE.map((c) => (
          <Swatch key={c} color={c} isActive={colorsEqual(c, currentColor)} onPick={onPick} />
        ))}
      </div>

      <div className="picker-actions">
        <button className="picker-action-btn" aria-label="Custom hex" aria-pressed={showHex} onClick={() => setShowHex((v) => !v)}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className="picker-action-btn" aria-label="Eyedropper" disabled>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M11.5 2.5l2 2-1.5 1.5-1-1L7 9.5l-1 0.5-1 1-2 2 1 1 2-2 1-1 0.5-1L12 5.5l-1-1 0.5-2z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {showHex && (
        <div className="picker-hex">
          <input
            type="text"
            value={hexDraft}
            placeholder="#"
            aria-label="Hex code"
            autoFocus
            onChange={(e) => setHexDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitHex();
              if (e.key === 'Escape') {
                setShowHex(false);
                setHexDraft('');
              }
            }}
          />
          <button className="picker-hex-apply" aria-label="Apply hex" onClick={submitHex}>
            ↵
          </button>
        </div>
      )}
    </div>
  );
});
