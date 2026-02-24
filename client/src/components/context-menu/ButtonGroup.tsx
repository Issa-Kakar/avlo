import type React from 'react';

interface ButtonGroupProps {
  children: React.ReactNode;
  className?: string;
}

export const ButtonGroup = ({ children, className }: ButtonGroupProps) => (
  <div className={`ctx-group${className ? ` ${className}` : ''}`}>{children}</div>
);
