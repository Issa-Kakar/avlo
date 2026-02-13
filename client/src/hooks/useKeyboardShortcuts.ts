import { useEffect, useCallback } from 'react';
import { useDeviceUIStore } from '../stores/device-ui-store';

interface KeyboardShortcutsOptions {
  onClear?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onToast?: (message: string) => void;
}

export function useKeyboardShortcuts({
  onClear,
  onUndo,
  onRedo,
  onToast,
}: KeyboardShortcutsOptions) {
  const { setActiveTool, setShapeVariant } = useDeviceUIStore();
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement)?.contentEditable === 'true'
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const { metaKey, ctrlKey, shiftKey } = event;
      const cmdOrCtrl = metaKey || ctrlKey;

      // Tool shortcuts
      switch (key) {
        case 'p':
          event.preventDefault();
          setActiveTool('pen');
          onToast?.('Pen selected');
          break;

        case 'h':
          event.preventDefault();
          setActiveTool('highlighter');
          onToast?.('Highlighter selected');
          break;

        case 'e':
          event.preventDefault();
          setActiveTool('eraser');
          onToast?.('Eraser selected');
          break;

        case 't':
          event.preventDefault();
          setActiveTool('text');
          onToast?.('Text selected');
          break;

        case 'v':
          event.preventDefault();
          setActiveTool('select');
          onToast?.('Select selected');
          break;

        case ' ':
          event.preventDefault();
          setActiveTool('pan');
          onToast?.('Pan selected');
          break;
        case 'c':
          event.preventDefault();
          setActiveTool('connector');
          onToast?.('Connectors selected');
          break;
        case 'r':
          event.preventDefault();
          setActiveTool('shape');
          setShapeVariant('rectangle');
          onToast?.('Rectangle selected');
          break;
        case 'd':
          event.preventDefault();
          setActiveTool('shape');
          setShapeVariant('diamond');
          onToast?.('Diamond selected');
          break;

      }

      // Command/Ctrl shortcuts
      if (cmdOrCtrl) {
        switch (key) {
          case 'z':
            event.preventDefault();
            if (shiftKey) {
              onRedo?.();
            } else {
              onUndo?.();
            }
            break;

          case 'y':
            event.preventDefault();
            onRedo?.();
            break;

          case 'k':
            event.preventDefault();
            onClear?.();
            break;

          // Zoom shortcuts removed - now handled by ZoomControls component
        }
      }
    },
    [setActiveTool, onClear, onUndo, onRedo, onToast],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
