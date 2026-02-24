interface ColorCircleProps {
  color: string;
  size?: number;
  variant?: 'filled' | 'hollow' | 'none';
  className?: string;
}

export const ColorCircle = ({ color, size = 18, variant = 'filled', className }: ColorCircleProps) => (
  <span
    className={`${variant === 'none' ? 'ctx-color-none' : ''}${className ? ` ${className}` : ''}`}
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      flexShrink: 0,
      ...(variant === 'hollow'
        ? { background: 'transparent', border: `2.5px solid ${color}` }
        : variant === 'none'
          ? { border: '1px solid rgba(0,0,0,0.08)' }
          : { background: color, border: '1px solid rgba(0,0,0,0.08)' }),
    }}
  />
);
