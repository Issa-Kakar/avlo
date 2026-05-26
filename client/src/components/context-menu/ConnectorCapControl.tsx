import type { ConnectorCap } from '@/core/types/objects';
import { IconTipArrow, IconTipNone } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

interface ConnectorCapControlProps {
  /** Which endpoint this control drives — affects arrow direction (start ⇒ left, end ⇒ right). */
  slot: 'start' | 'end';
  /** First connector's cap for this endpoint. `null` only on stale frames between selection mutations.
   *  Mixed caps surface the first connector's value (the trigger has no "mixed" affordance — same
   *  rule as `ConnectorTypeControl`). */
  value: ConnectorCap | null;
  onSelect: (cap: ConnectorCap) => void;
}

const CAPS: readonly { cap: ConnectorCap; label: string }[] = [
  { cap: 'none', label: 'No arrow' },
  { cap: 'arrow', label: 'Arrow' },
];

/**
 * Per-endpoint cap picker — trigger reflects the current cap (`--ctx-engaged`
 * ink at rest, engaged-dark fill on open). Popout is a side-by-side two-cell
 * picker (no-arrow + arrow). Arrow direction mirrors `slot` so the start-side
 * arrow points left and the end-side arrow points right in both trigger
 * and picker.
 */
export function ConnectorCapControl({ slot, value, onSelect }: ConnectorCapControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();
  const direction = slot === 'start' ? 'left' : 'right';
  const current: ConnectorCap = value ?? 'none';
  const TriggerIcon = current === 'arrow' ? <IconTipArrow direction={direction} /> : <IconTipNone />;

  return (
    <div ref={containerRef} className="relative">
      <MenuButton
        className="ctx-btn-sq ctx-btn-engaged"
        onMouseDown={toggle}
        aria-expanded={open}
        aria-label={slot === 'start' ? 'Start cap' : 'End cap'}
      >
        {TriggerIcon}
      </MenuButton>
      {open && (
        <div className="ctx-submenu min-w-0 p-1.5 flex flex-row gap-1">
          {CAPS.map(({ cap, label }) => {
            const active = cap === current;
            return (
              <button
                key={cap}
                type="button"
                className={`size-9 inline-flex items-center justify-center border-0 rounded-md cursor-pointer p-0 outline-none [&_svg]:size-7 ${
                  active
                    ? 'bg-[var(--ctx-engaged)] text-white hover:bg-[var(--ctx-engaged)]'
                    : 'bg-transparent text-[var(--ctx-engaged)] hover:bg-[var(--ctx-hover)]'
                }`}
                aria-label={label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cap);
                  close();
                }}
              >
                {cap === 'arrow' ? <IconTipArrow direction={direction} /> : <IconTipNone />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
