import { useState, useRef, useEffect } from 'react';
import { IconChevronDown, IconCheck } from './icons/MenuIcons';

const STROKE_PRESETS: [string, number][] = [['S', 6], ['M', 10], ['L', 14], ['XL', 18]];
const CONNECTOR_PRESETS: [string, number][] = [['S', 2], ['M', 4], ['L', 6], ['XL', 8]];

const STROKE_LABELS: Record<number, string> = { 6: 'S', 10: 'M', 14: 'L', 18: 'XL' };
const CONNECTOR_LABELS: Record<number, string> = { 2: 'S', 4: 'M', 6: 'L', 8: 'XL' };

// Fixed SVG widths per label to prevent layout shift
const LABEL_SVG_W: Record<string, number> = { S: 46, M: 48, L: 44, XL: 54 };
const EMPTY_SVG_W = 30;

interface SizeLabelProps {
  value: number;
  kind: 'stroke' | 'connector';
  onSelect?: (size: number) => void;
}

export function SizeLabel({ value, kind, onSelect }: SizeLabelProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const labels = kind === 'connector' ? CONNECTOR_LABELS : STROKE_LABELS;
  const presets = kind === 'connector' ? CONNECTOR_PRESETS : STROKE_PRESETS;
  const label = labels[value] ?? '';
  const svgW = label ? (LABEL_SVG_W[label] ?? 48) : EMPTY_SVG_W;

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
      <button
        className="ctx-size-label-btn"
        onMouseDown={(e) => { e.preventDefault(); setOpen(!open); }}
      >
        <svg
          width={svgW}
          height={16}
          viewBox={`0 0 ${svgW} 16`}
          fill="none"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <text
            x="0"
            y="12"
            fill="#111827"
            fontSize="13"
            fontWeight="700"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
          >
            Size
          </text>
          {label && (
            <text
              x="33"
              y="12"
              fill="#111827"
              fontSize="13"
              fontWeight="700"
              fontFamily="var(--font-stack)"
              textRendering="geometricPrecision"
            >
              {label}
            </text>
          )}
        </svg>
        <IconChevronDown className="ctx-dd-arrow" />
      </button>
      {open && (
        <div className="ctx-submenu">
          {presets.map(([lbl, size]) => {
            const active = size === value;
            return (
              <button
                key={lbl}
                className={`ctx-submenu-item${active ? ' ctx-submenu-item-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect?.(size);
                  setOpen(false);
                }}
              >
                {active
                  ? <IconCheck width={16} height={16} />
                  : <span style={{ width: 16 }} />}
                <span className="ctx-size-item-label">{lbl}</span>
                <span className="ctx-size-item-value">{size}px</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
