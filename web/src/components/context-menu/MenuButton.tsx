import type React from 'react';

interface MenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

export const MenuButton = ({ active, className, onMouseDown, children, ref, ...rest }: MenuButtonProps) => (
  <button
    ref={ref}
    className={`ctx-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
    onMouseDown={(e) => {
      e.preventDefault();
      onMouseDown?.(e);
    }}
    {...rest}
  >
    {children}
  </button>
);
