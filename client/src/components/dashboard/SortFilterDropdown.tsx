import { IconCheck } from '@/components/context-menu/icons';
import { useDropdown } from '@/components/context-menu/useDropdown';
import { ChevronDownIcon } from '@/components/topbar/icons/ChevronDownIcon';

interface SortFilterDropdownProps<T extends string> {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * The Home-view Filter / Sort dropdown. One generic component, two instances.
 * Visual states (open fill, chevron rotation, row hover/selected) are CSS,
 * keyed off `[aria-expanded]` + `.dash-dd-item-selected` — see Dashboard.css.
 */
export function SortFilterDropdown<T extends string>({ label, options, value, onChange }: SortFilterDropdownProps<T>) {
  const { open, containerRef, toggle, close } = useDropdown();

  return (
    <div className="dash-dd" ref={containerRef}>
      <button type="button" className="dash-dd-trigger" aria-expanded={open} onMouseDown={toggle}>
        <span>
          {label}: {value}
        </span>
        <span className="dash-dd-chevron">
          <ChevronDownIcon width={20} height={20} />
        </span>
      </button>

      {open && (
        <div className="dash-dd-menu" role="listbox">
          {options.map((opt) => {
            const selected = opt === value;
            return (
              <button
                key={opt}
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? 'dash-dd-item dash-dd-item-selected' : 'dash-dd-item'}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(opt);
                  close();
                }}
              >
                <span className="dash-dd-item-label">{opt}</span>
                {selected && (
                  <span className="dash-dd-check">
                    <IconCheck width={16} height={16} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
