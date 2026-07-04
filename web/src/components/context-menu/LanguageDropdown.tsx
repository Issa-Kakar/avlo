import type { CodeLanguage } from '@/core/accessors';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedCodeLanguage } from '@/tools/selection/selection-actions';
import { IconCheck, IconChevronDown } from './icons';
import { MenuButton } from './MenuButton';
import { useDropdown } from './useDropdown';

const selectCodeLanguage = (s: SelectionStore) => s.selectedStyles.codeLanguage;

const LANGUAGES: { key: CodeLanguage; label: string }[] = [
  { key: 'javascript', label: 'JavaScript' },
  { key: 'typescript', label: 'TypeScript' },
  { key: 'python', label: 'Python' },
  { key: 'html', label: 'HTML' },
  { key: 'css', label: 'CSS' },
  { key: 'json', label: 'JSON' },
  { key: 'sql', label: 'SQL' },
];

const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  sql: 'SQL',
};

export function LanguageDropdown() {
  const language = useSelectionStore(selectCodeLanguage);
  const { open, containerRef, toggle, close } = useDropdown();
  const current = language ?? 'javascript';

  return (
    <div ref={containerRef} className="relative">
      <MenuButton className="ctx-btn-lang" onMouseDown={toggle} aria-expanded={open}>
        <svg width={74} height={26} viewBox="0 0 74 26" fill="none" aria-hidden="true" className="shrink-0">
          <text className="ctx-lang-trigger-label" x="0" y="9">
            LANGUAGE
          </text>
          <text className="ctx-lang-trigger-value" x="0" y="24">
            {LANGUAGE_LABELS[current]}
          </text>
        </svg>
        <IconChevronDown width={10} height={10} />
      </MenuButton>

      {open && (
        <div className="ctx-submenu left-0 translate-x-0 min-w-[150px]">
          {LANGUAGES.map(({ key, label }) => (
            <button
              key={key}
              className={`ctx-submenu-item ctx-type-item font-bold${key === current ? ' ctx-submenu-item-active' : ''}`}
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
