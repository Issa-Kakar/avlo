import { useCallback, useEffect, useRef, useState } from 'react';

/** Shared dropdown state: open/close, outside-click dismiss, preventDefault toggle. */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown` (the MainMenuTrigger/ZoomControls pattern): the
    // canvas preventDefault()s pointerdown, which suppresses the synthesized mousedown,
    // and a sibling trigger's stopPropagation'd mousedown never reaches the document —
    // pointerdown fires first and bubbles regardless, so any outside press dismisses.
    // Triggers toggle on mousedown, which fires AFTER this — ordering is preserved.
    const handle = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [open]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setOpen((v) => !v);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return { open, containerRef, toggle, close } as const;
}
