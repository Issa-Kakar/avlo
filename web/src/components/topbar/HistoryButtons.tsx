import { type MouseEvent, memo } from 'react';
import { redo, undo } from '@/runtime/room-runtime';
import { selectCanRedo, selectCanUndo, useHistoryStore } from '@/stores/history-store';
import { RedoIcon } from './icons/RedoIcon';
import { UndoIcon } from './icons/UndoIcon';

const preventFocus = (e: MouseEvent) => e.preventDefault();
const handleUndo = () => undo();
const handleRedo = () => redo();

export const HistoryButtons = memo(function HistoryButtons() {
  const canUndo = useHistoryStore(selectCanUndo);
  const canRedo = useHistoryStore(selectCanRedo);
  return (
    <>
      <button
        className="top-bar-history-btn"
        disabled={!canUndo}
        tabIndex={-1}
        aria-label="Undo"
        onMouseDown={preventFocus}
        onClick={handleUndo}
      >
        <UndoIcon className="top-bar-history-icon" />
      </button>
      <button
        className="top-bar-history-btn"
        disabled={!canRedo}
        tabIndex={-1}
        aria-label="Redo"
        onMouseDown={preventFocus}
        onClick={handleRedo}
      >
        <RedoIcon className="top-bar-history-icon" />
      </button>
    </>
  );
});
