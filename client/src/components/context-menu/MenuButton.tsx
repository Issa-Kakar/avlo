import React from 'react';

interface MenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const MenuButton = React.forwardRef<HTMLButtonElement, MenuButtonProps>(
  ({ active, className, onMouseDown, children, ...rest }, ref) => (
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
  ),
);
