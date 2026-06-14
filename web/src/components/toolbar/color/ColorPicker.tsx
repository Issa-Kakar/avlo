import { memo, useState } from 'react';
import { CheckIcon } from './CheckIcon';
import { colorButtonStyle } from './ColorButton';
import { checkmarkColorFor, colorsEqual, isNearBlack, PALETTE, PALETTE_COLS } from './palette';

interface Props {
  /** The currently-selected color (gets the checkmark in the grid). */
  currentColor: string;
  onPickColor: (color: string) => void;
}

interface SwatchProps {
  color: string;
  isActive: boolean;
  onPickColor: (color: string) => void;
}

const Swatch = memo(function Swatch({ color, isActive, onPickColor }: SwatchProps) {
  return (
    <button
      className={`picker-swatch ${isActive ? 'is-active' : ''}`}
      data-near-black={isNearBlack(color) || undefined}
      style={colorButtonStyle(color, isActive)}
      aria-label={`Color ${color}`}
      tabIndex={-1}
      onClick={() => onPickColor(color)}
    >
      {/* Active swatch: checkmark + the active slot's tinted offset ring (ColorPicker.css). */}
      {isActive && <CheckIcon color={checkmarkColorFor(color)} size={13} />}
    </button>
  );
});

/** 23-color grid + custom-hex entry. Purely presentational — the owning ColorSlots /
 * ColorField wrapper handles outside-click dismissal via usePickerDismiss. */
export const ColorPicker = memo(function ColorPicker({ currentColor, onPickColor }: Props) {
  const [hexDraft, setHexDraft] = useState('');
  const [showHex, setShowHex] = useState(false);

  const submitHex = () => {
    const v = hexDraft.trim();
    const normalized = v.startsWith('#') ? v : `#${v}`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) {
      onPickColor(normalized);
      setHexDraft('');
      setShowHex(false);
    }
  };

  return (
    <div className="color-picker" role="dialog" aria-label="Pick a color">
      <div className="picker-grid" style={{ gridTemplateColumns: `repeat(${PALETTE_COLS}, 1fr)` }}>
        {PALETTE.map((c) => (
          <Swatch key={c} color={c} isActive={colorsEqual(c, currentColor)} onPickColor={onPickColor} />
        ))}
      </div>

      <div className="picker-actions">
        <button
          className="picker-action-btn"
          aria-label="Custom hex"
          aria-pressed={showHex}
          tabIndex={-1}
          onClick={() => setShowHex((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className="picker-action-btn" aria-label="Eyedropper" tabIndex={-1} disabled>
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
          <button className="picker-hex-apply" aria-label="Apply hex" tabIndex={-1} onClick={submitHex}>
            ↵
          </button>
        </div>
      )}
    </div>
  );
});
