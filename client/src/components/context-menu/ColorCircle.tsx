interface ColorCircleProps {
  color: string;
  size?: number;
  variant?: 'filled' | 'hollow' | 'none';
  /** When set with variant='hollow', renders a diagonal split showing both colors */
  secondColor?: string | null;
  className?: string;
}

export const ColorCircle = ({ color, size = 18, variant = 'filled', secondColor, className }: ColorCircleProps) => {
  const isSplit = variant === 'hollow' && secondColor;

  return (
    <span
      className={`${variant === 'none' ? 'ctx-color-none' : ''}${className ? ` ${className}` : ''}`}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        ...(isSplit
          ? {
              background: `linear-gradient(135deg, ${color} 50%, ${secondColor} 50%)`,
              border: '1px solid rgba(0,0,0,0.08)',
            }
          : variant === 'hollow'
            ? { background: 'transparent', border: `3px solid ${color}` }
            : variant === 'none'
              ? { border: '1px solid rgba(0,0,0,0.08)' }
              : { background: color, border: '1px solid rgba(0,0,0,0.08)' }),
      }}
    />
  );
};
