import { useState, useRef, useEffect, useCallback } from 'react';

/** Shared dropdown state: open/close, outside-click dismiss, preventDefault toggle. */
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setOpen((v) => !v);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return { open, containerRef, toggle, close } as const;
}
