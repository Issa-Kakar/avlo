import { IconChevronDown } from './icons/MenuIcons';

const STROKE_LABELS: Record<number, string> = { 6: 'S', 10: 'M', 14: 'L', 18: 'XL' };
const CONNECTOR_LABELS: Record<number, string> = { 2: 'S', 4: 'M', 6: 'L', 8: 'XL' };

// Fixed SVG widths per label to prevent layout shift
const LABEL_SVG_W: Record<string, number> = { S: 46, M: 48, L: 44, XL: 54 };
const EMPTY_SVG_W = 30;

interface SizeLabelProps {
  value: number;
  kind: 'stroke' | 'connector';
  onClick?: () => void;
}

export function SizeLabel({ value, kind, onClick }: SizeLabelProps) {
  const label = (kind === 'connector' ? CONNECTOR_LABELS : STROKE_LABELS)[value] ?? '';
  const svgW = label ? (LABEL_SVG_W[label] ?? 48) : EMPTY_SVG_W;

  return (
    <button className="ctx-size-label-btn" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
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
  );
}
