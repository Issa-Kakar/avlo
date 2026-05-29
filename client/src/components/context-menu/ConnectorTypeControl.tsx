import type { ConnectorType } from '@/core/types/objects';
import { IconCheck, IconConnectorOrthogonal, IconConnectorStraight } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

// Row order mirrors the toolbar — straight first, orthogonal second. The label
// is "Orthogonal" (UI prose), the stored ConnectorType is `'elbow'`.
const ROWS: readonly { type: ConnectorType; label: string; Icon: typeof IconConnectorStraight }[] = [
  { type: 'straight', label: 'Straight', Icon: IconConnectorStraight },
  { type: 'elbow', label: 'Orthogonal', Icon: IconConnectorOrthogonal },
];

interface ConnectorTypeControlProps {
  /** First connector's routing type. `null` only on stale frames between selection mutations. */
  value: ConnectorType | null;
  /** No-op today — switching connector types needs route/endpoint adjustments wired separately. */
  onSelect: (type: ConnectorType) => void;
}

/**
 * Connector routing-type picker — trigger reflects the current type
 * (`#1b1f22` ink at rest, engaged-dark fill when open), opening the same
 * tier-menu layout as `StrokeWidthControl` (icon · label · inline check
 * on the active row, row fill `#282e34` when selected).
 */
export function ConnectorTypeControl({ value, onSelect }: ConnectorTypeControlProps) {
  const { open, containerRef, toggle, close } = useDropdown();
  const TriggerIcon = (ROWS.find((r) => r.type === value) ?? ROWS[1]).Icon;

  return (
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-sq ctx-btn-engaged" onMouseDown={toggle} aria-expanded={open} aria-label="Connector type">
        <TriggerIcon />
      </MenuButton>
      {open && (
        <div className="ctx-submenu min-w-[160px] p-2 flex flex-col gap-[3px]">
          {ROWS.map(({ type, label, Icon }) => {
            const active = type === value;
            return (
              <button
                key={type}
                type="button"
                className={`ctx-submenu-item h-9 gap-2.5 px-2.5 text-xs font-bold text-[var(--ctx-text)] whitespace-nowrap [&_svg]:shrink-0${active ? ' ctx-submenu-item-active bg-[var(--ctx-engaged-tier)] !text-white hover:bg-[var(--ctx-engaged-tier)]' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(type);
                  close();
                }}
              >
                <Icon width={20} height={20} />
                <span>{label}</span>
                {active && <IconCheck width={18} height={18} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
