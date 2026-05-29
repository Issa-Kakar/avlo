import { memo, type ReactNode } from 'react';

interface Props {
  isActive: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}

/** Square icon button used inside any inspector pill. Memoized to keep
 * children stable across unrelated parent renders (e.g. picker open/close). */
export const InspectorButton = memo(function InspectorButton({ isActive, ariaLabel, onClick, children }: Props) {
  return (
    <button
      className={`insp-btn ${isActive ? 'is-active' : ''}`}
      aria-label={ariaLabel}
      aria-pressed={isActive}
      tabIndex={-1}
      onClick={onClick}
    >
      {children}
    </button>
  );
});
