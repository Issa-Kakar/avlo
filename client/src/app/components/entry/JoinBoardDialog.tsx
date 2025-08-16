import { useState, useEffect, useRef } from 'react';
import { parseJoinInput, roomExists, resolveCode } from './parse.js';
import './EntryDialogs.css';

interface JoinBoardDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onJoin: (roomId: string) => void;
  onCreateNew: () => void;
}

export default function JoinBoardDialog({
  isOpen,
  onClose,
  onJoin,
  onCreateNew,
}: JoinBoardDialogProps) {
  const [input, setInput] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [parsedHint, setParsedHint] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setInput('');
      setError(null);
      setNotFound(false);
      setParsedHint(null);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Focus trap and escape key handling
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

  // Update parsed hint when input changes
  useEffect(() => {
    if (!input.trim()) {
      setParsedHint(null);
      return;
    }

    const parsed = parseJoinInput(input);
    switch (parsed.kind) {
      case 'url':
        setParsedHint(`ID: ${parsed.roomId.slice(-6)}`);
        break;
      case 'id':
        setParsedHint('Board ID detected');
        break;
      case 'code':
        setParsedHint('Share code detected');
        break;
      default:
        setParsedHint(null);
    }
  }, [input]);

  const handleJoin = async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      setError('Please enter a board link, ID, or code');
      return;
    }

    setIsChecking(true);
    setError(null);

    const parsed = parseJoinInput(trimmedInput);

    if (parsed.kind === 'invalid') {
      setError("That doesn't look like a board link, ID, or code.");
      setIsChecking(false);
      return;
    }

    let roomId: string | null = null;

    if (parsed.kind === 'code') {
      // Try to resolve the code to a room ID
      roomId = await resolveCode(parsed.code);
      if (!roomId) {
        // Code resolution not supported in MVP
        setError('Share codes are not yet supported. Please use the full link or ID.');
        setIsChecking(false);
        return;
      }
    } else {
      roomId = parsed.roomId;
    }

    // Check if room exists
    const exists = await roomExists(roomId);

    if (!exists) {
      setNotFound(true);
      setIsChecking(false);
      return;
    }

    // Room exists, navigate to it
    onJoin(roomId);
    onClose();
  };

  const handleTryAgain = () => {
    setNotFound(false);
    setInput('');
    setError(null);
    setParsedHint(null);
    inputRef.current?.focus();
  };

  const handleCreateFromNotFound = () => {
    // If user typed something that looks like a name, offer to use it
    const parsed = parseJoinInput(input);
    if (parsed.kind === 'invalid' && input.trim().length > 0) {
      // User probably typed a name - but for now just create new
      // We could pass the name to pre-fill the create dialog
      onCreateNew();
    } else {
      // User typed an ID/URL that doesn't exist
      onCreateNew();
    }
    onClose();
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
        aria-labelledby="join-dialog-title"
        aria-describedby={error ? 'join-dialog-error' : undefined}
      >
        {!notFound ? (
          <>
            <h2 id="join-dialog-title">Join a board</h2>

            <div className="form-group">
              <label htmlFor="join-input">
                Paste a link, enter a board ID, or a 6-character code
              </label>
              <input
                ref={inputRef}
                id="join-input"
                type="text"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isChecking) {
                    handleJoin();
                  }
                }}
                placeholder="e.g., https://app.example.com/rooms/abc123 or ABC123"
                disabled={isChecking}
                aria-invalid={!!error}
                aria-describedby={
                  error ? 'join-dialog-error' : parsedHint ? 'join-dialog-hint' : undefined
                }
              />
              {parsedHint && (
                <div id="join-dialog-hint" className="form-hint">
                  {parsedHint}
                </div>
              )}
              {error && (
                <div id="join-dialog-error" className="form-error" role="alert">
                  {error}
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose} disabled={isChecking}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleJoin}
                disabled={isChecking}
                aria-busy={isChecking}
              >
                {isChecking ? 'Checking...' : 'Join'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="join-dialog-title">Board not found</h2>

            <div className="not-found-content">
              <p>No board matches what you entered.</p>
              {parseJoinInput(input).kind === 'invalid' && input.trim().length > 0 && (
                <p className="form-help">Names are labels; the board will get its own ID.</p>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-link" onClick={handleTryAgain}>
                Try again
              </button>
              <button className="btn btn-primary" onClick={handleCreateFromNotFound}>
                Create a new board
                {parseJoinInput(input).kind === 'invalid' &&
                  input.trim().length > 0 &&
                  ` with this name`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
