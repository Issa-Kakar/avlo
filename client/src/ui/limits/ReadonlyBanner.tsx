export interface ReadonlyBannerProps {
  isVisible: boolean;
  onCreateRoom?: () => void;
  className?: string;
}

/**
 * Inline banner shown when room reaches 10 MB hard cap.
 *
 * Per Phase 8 requirements:
 * - Single inline banner: "Board is read-only — size limit reached."
 * - Optional CTA "Create room" that opens standard create-room flow
 * - Respect server rate-limit → 429 toast
 */
export function ReadonlyBanner({ isVisible, onCreateRoom, className = '' }: ReadonlyBannerProps) {
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className={`readonly-banner ${className}`}
      role="alert"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        backgroundColor: 'var(--warning-surface)',
        border: '1px solid var(--warning-border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--warning-text)',
        fontSize: '14px',
        fontWeight: '500',
        margin: 'var(--space-2) 0',
      }}
    >
      <div className="readonly-banner-message">Board is read-only — size limit reached.</div>

      {onCreateRoom && (
        <button
          onClick={onCreateRoom}
          className="readonly-banner-cta"
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: '13px',
            fontWeight: '600',
            color: 'var(--warning-text)',
            backgroundColor: 'transparent',
            border: '1px solid var(--warning-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            transition: 'all var(--base) var(--ease-out)',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--warning-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          Create room
        </button>
      )}
    </div>
  );
}

/**
 * Compact version for inline placement
 */
export function ReadonlyBannerCompact({
  isVisible,
  className = '',
}: Omit<ReadonlyBannerProps, 'onCreateRoom'>) {
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className={`readonly-banner-compact ${className}`}
      role="status"
      aria-label="Board is read-only"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 'var(--space-1) var(--space-2)',
        fontSize: '12px',
        fontWeight: '500',
        color: 'var(--warning-text)',
        backgroundColor: 'var(--warning-surface)',
        border: '1px solid var(--warning-border)',
        borderRadius: 'var(--radius-sm)',
        whiteSpace: 'nowrap',
      }}
    >
      Board is read-only
    </div>
  );
}
