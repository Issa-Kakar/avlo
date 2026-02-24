interface ColorCircleProps {
  color: string;
  size?: number;
  outline?: boolean;
  className?: string;
}

export const ColorCircle = ({ color, size = 18, outline, className }: ColorCircleProps) => (
  <span
    className={className}
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      flexShrink: 0,
      ...(outline
        ? { background: 'transparent', border: `2.5px solid ${color}` }
        : { background: color, border: '1px solid rgba(0,0,0,0.08)' }),
    }}
  />
);
