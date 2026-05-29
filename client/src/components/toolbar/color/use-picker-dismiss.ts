import { useEffect, useRef } from 'react';

/** Returns a ref for the picker's root element; while `isOpen`, a mousedown outside that
 * root calls `onClose`. The root MUST wrap both the trigger button(s) and the picker, so
 * clicks on either count as "inside" — that containment is what replaces ColorPicker's
 * old `.closest('.color-slots')` reach. */
export function usePickerDismiss(isOpen: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen, onClose]);
  return rootRef;
}
