interface DividerProps {
  variant?: 'default' | 'light';
}

export const Divider = ({ variant = 'default' }: DividerProps) => (
  <div className={variant === 'light' ? 'ctx-divider-light' : 'ctx-divider'} />
);
