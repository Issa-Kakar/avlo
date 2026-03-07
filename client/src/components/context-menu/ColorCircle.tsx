interface ColorCircleProps {
  color: string;
  size?: number;
  variant?: 'filled' | 'hollow' | 'none';
  /** When set, renders a diagonal split showing both colors */
  secondColor?: string | null;
  className?: string;
}

export const ColorCircle = ({
  color,
  size = 18,
  variant = 'filled',
  secondColor,
  className,
}: ColorCircleProps) => {
  if (secondColor) {
    // SVG split: pixel-perfect diagonal, no gradient aliasing
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={className}
        style={{ display: 'inline-block', flexShrink: 0, clipPath: 'circle(50%)' }}
      >
        <rect width={size} height={size} fill={color} />
        <polygon points={`${size},0 ${size},${size} 0,${size}`} fill={secondColor} />
      </svg>
    );
  }

  return (
    <span
      className={`${variant === 'none' ? 'ctx-color-none' : ''}${className ? ` ${className}` : ''}`}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        ...(variant === 'hollow'
          ? {
              background: 'transparent',
              border: `3px solid ${color}`,
              boxSizing: 'border-box' as const,
            }
          : variant === 'none'
            ? { border: '1px solid rgba(0,0,0,0.08)' }
            : { background: color, border: '1px solid rgba(0,0,0,0.08)' }),
      }}
    />
  );
};
