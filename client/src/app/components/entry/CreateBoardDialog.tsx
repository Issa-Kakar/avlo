import { useState, useEffect, useRef } from 'react';
import { getHttpBase } from '../../utils/url.js';
import { toast } from '../../utils/toast.js';
import './EntryDialogs.css';

interface CreateBoardDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (roomId: string) => void;
}

export default function CreateBoardDialog({ isOpen, onClose, onSuccess }: CreateBoardDialogProps) {
  const [boardName, setBoardName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus management
  useEffect(() => {
    if (isOpen && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isOpen]);

  // Trap focus within dialog
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }

      // Tab trap
      if (e.key === 'Tab' && dialogRef.current) {
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const validateName = (name: string): string | null => {
    if (name.length > 60) {
      return 'Board name must be 60 characters or less';
    }
    return null;
  };

  const handleCreate = async (skipName = false) => {
    const name = skipName ? '' : boardName.trim();

    if (!skipName) {
      const validationError = validateName(name);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`${getHttpBase()}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: name || 'Untitled board' }),
      });

      if (response.status === 429) {
        setError('Too many requests — try again shortly.');
        setIsCreating(false);
        return;
      }

      if (!response.ok) {
        setError("Couldn't create board. Try again.");
        setIsCreating(false);
        return;
      }

      const data = await response.json();
      const roomId = data.roomId;

      // Copy link to clipboard
      try {
        const link = `${window.location.origin}/rooms/${roomId}`;
        await navigator.clipboard.writeText(link);
        toast.success('Board created. Link copied.');
      } catch {
        toast.success('Board created.');
      }

      onSuccess(roomId);
      onClose();
      setBoardName('');
    } catch {
      setError("Couldn't create board. Try again.");
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal entry-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-dialog-title"
        aria-describedby={error ? 'create-dialog-error' : undefined}
      >
        <h2 id="create-dialog-title">Create a new board</h2>

        <div className="form-group">
          <label htmlFor="board-name">Board name (optional)</label>
          <input
            ref={nameInputRef}
            id="board-name"
            type="text"
            value={boardName}
            onChange={(e) => {
              setBoardName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isCreating) {
                handleCreate();
              }
            }}
            placeholder="e.g., Team Sync, Brainstorm Session"
            maxLength={60}
            disabled={isCreating}
            aria-invalid={!!error}
            aria-describedby={error ? 'create-dialog-error' : 'create-dialog-help'}
          />
          <div id="create-dialog-help" className="form-help">
            Name helps you find it later. You can rename inside the board.
          </div>
          {error && (
            <div id="create-dialog-error" className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button
            ref={closeButtonRef}
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isCreating}
          >
            Cancel
          </button>
          <button className="btn btn-link" onClick={() => handleCreate(true)} disabled={isCreating}>
            Skip & create
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handleCreate(false)}
            disabled={isCreating}
            aria-busy={isCreating}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
