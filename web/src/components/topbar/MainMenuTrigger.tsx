import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from './icons/ChevronDownIcon';
import { MainMenu } from './MainMenu';

/**
 * Main-menu trigger — the chevron-down button that replaces the kebab to
 * the right of the board name. Owns the open/close state for the dropdown
 * and the outside-click dismiss; the engaged-dark fill on `[aria-expanded]`
 * lives in TopBar.css.
 */
export function MainMenuTrigger() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Outside-click dismiss. `pointerdown` (not `mousedown`) mirrors
  // ZoomControls: pointer events fire BEFORE the canvas's `preventDefault`
  // can suppress the synthesized mousedown, so clicks on the canvas itself
  // also close the menu.
  useEffect(() => {
    if (!open) return;
    const handle = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [open]);

  const toggle = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setOpen((v) => !v);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div ref={containerRef} className="main-menu-anchor">
      <button
        type="button"
        className="top-bar-menu-trigger"
        aria-label="Board menu"
        aria-expanded={open}
        aria-haspopup="menu"
        tabIndex={-1}
        onMouseDown={toggle}
      >
        <ChevronDownIcon className="top-bar-menu-trigger-icon" />
      </button>
      {open && <MainMenu onClose={close} />}
    </div>
  );
}
