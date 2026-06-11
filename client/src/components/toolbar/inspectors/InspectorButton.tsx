import { memo, type PointerEvent, type ReactNode } from 'react';

interface Props {
  isActive: boolean;
  ariaLabel: string;
  onClick: () => void;
  /** Drag-place entry (toolbar-place.ts). When the drag engages, pointer capture
   * retargets the click away from this button — onClick then only fires on the
   * guard-refused fallback paths. */
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}

/** Square icon button used inside any inspector pill. Memoized to keep
 * children stable across unrelated parent renders (e.g. picker open/close). */
export const InspectorButton = memo(function InspectorButton({ isActive, ariaLabel, onClick, onPointerDown, children }: Props) {
  return (
    <button
      className={`insp-btn ${isActive ? 'is-active' : ''}`}
      aria-label={ariaLabel}
      aria-pressed={isActive}
      tabIndex={-1}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {children}
    </button>
  );
});
