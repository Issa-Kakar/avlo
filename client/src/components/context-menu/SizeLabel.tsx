const STROKE_LABELS: Record<number, string> = { 6: 'S', 10: 'M', 14: 'L', 18: 'XL' };
const CONNECTOR_LABELS: Record<number, string> = { 2: 'S', 4: 'M', 6: 'L', 8: 'XL' };

interface SizeLabelProps {
  value: number;
  kind: 'stroke' | 'connector';
}

export function SizeLabel({ value, kind }: SizeLabelProps) {
  const label = (kind === 'connector' ? CONNECTOR_LABELS : STROKE_LABELS)[value];
  if (!label) return null;
  return (
    <span className="ctx-size-label">
      <span className="ctx-size-label-prefix">Size </span>{label}
    </span>
  );
}
