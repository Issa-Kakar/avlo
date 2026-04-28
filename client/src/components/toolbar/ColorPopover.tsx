import { useEffect, useState } from 'react';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import * as A from './actions';
import { ColorSwatch } from './ColorSwatch';
import { HEX_REGEX, MORE_COLORS } from './constants';
import './ColorPopover.css';

interface Props {
  currentColor: string;
}

export function ColorPopover({ currentColor }: Props) {
  const recentColors = useDeviceUIStore((s) => s.recentColors);
  const [hex, setHex] = useState('#');

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.inspector-colors')) A.closeColorPopover();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  const submit = () => {
    const v = hex.trim();
    if (HEX_REGEX.test(v)) {
      A.pickCustomColor(v);
      setHex('#');
    }
  };

  return (
    <div className="inspector-color-popover" role="dialog" aria-modal="true">
      {recentColors.length > 0 && (
        <section className="popover-section">
          <h6>Recent</h6>
          <div className="swatch-grid">
            {recentColors.map((c, i) => (
              <ColorSwatch
                key={`r-${i}`}
                color={c}
                isActive={currentColor === c}
                onSelect={A.pickCustomColor}
                ariaLabel={`Recent color ${c}`}
              />
            ))}
          </div>
        </section>
      )}

      <section className="popover-section">
        <h6>More</h6>
        <div className="swatch-grid">
          {MORE_COLORS.map((c) => (
            <ColorSwatch key={c} color={c} isActive={currentColor === c} onSelect={A.pickCustomColor} />
          ))}
        </div>
      </section>

      <section className="popover-section">
        <h6>Hex</h6>
        <div className="hex-row">
          <input
            type="text"
            value={hex}
            onChange={(e) => {
              const v = e.target.value;
              setHex(v.startsWith('#') ? v : `#${v}`);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="#"
            aria-label="Hex code"
          />
          <button className="hex-apply" onClick={submit} aria-label="Apply hex">
            ↵
          </button>
        </div>
      </section>
    </div>
  );
}
