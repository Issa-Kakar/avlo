import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionStore } from '@/stores/selection-store';
import { setSelectedCodeLanguage } from '@/tools/selection/selection-actions';
import type { CodeLanguage } from '@/core/accessors';
import { MenuButton } from './MenuButton';
import { IconChevronDown, IconCheck } from './icons';
import { useDropdown } from './useDropdown';

const selectCodeLanguage = (s: SelectionStore) => s.selectedStyles.codeLanguage;

const LANGUAGES: { key: CodeLanguage; label: string }[] = [
  { key: 'javascript', label: 'JavaScript' },
  { key: 'typescript', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
];

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
};

export function LanguageDropdown() {
  const language = useSelectionStore(selectCodeLanguage);
  const { open, containerRef, toggle, close } = useDropdown();
  const current = language ?? 'javascript';

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <MenuButton className="ctx-btn-filter" onMouseDown={toggle} aria-expanded={open}>
        <svg width={74} height={26} viewBox="0 0 74 26" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <text
            x="0"
            y="9"
            fill="#6B7280"
            fontSize="10"
            fontWeight="500"
            letterSpacing="0.03em"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
          >
            LANGUAGE
          </text>
          <text
            x="0"
            y="24"
            fill="#1F2937"
            fontSize="13"
            fontWeight="600"
            fontFamily="var(--font-stack)"
            textRendering="geometricPrecision"
          >
            {LANGUAGE_LABELS[current]}
          </text>
        </svg>
        <IconChevronDown width={10} height={10} />
      </MenuButton>

      {open && (
        <div className="ctx-submenu ctx-submenu-lang">
          {LANGUAGES.map(({ key, label }) => (
            <button
              key={key}
              className={`ctx-submenu-item ctx-type-item${key === current ? ' ctx-submenu-item-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setSelectedCodeLanguage(key);
                close();
              }}
            >
              <span>{label}</span>
              {key === current && <IconCheck width={14} height={14} className="ctx-type-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
