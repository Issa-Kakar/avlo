import { formatBytes } from '../../state/roomStats';

export interface SizePillProps {
  bytes: number;
  cap: number;
  className?: string;
}

/**
 * Subtle header pill showing room size when at ≥80% capacity.
 * Shows format: "X.Y / 10 MB"
 *
 * Per Phase 8 requirements:
 * - Only shown at ≥80% of cap (8 MB/10 MB)
 * - Quiet styling, right-aligned
 * - No warning toasts below hard cap
 */
export function SizePill({ bytes, cap, className = '' }: SizePillProps) {
  const isVisible = bytes >= 0.8 * cap;

  if (!isVisible) {
    return null;
  }

  const capMB = (cap / (1024 * 1024)).toFixed(0);
  const sizeText = `${formatBytes(bytes)} / ${capMB} MB`;

  return (
    <div
      className={`size-pill ${className}`}
      role="status"
      aria-label={`Room size: ${sizeText}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 8px',
        fontSize: '12px',
        fontWeight: '500',
        color: 'var(--ink-secondary)',
        backgroundColor: 'var(--surface-secondary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        opacity: '0.8',
        transition: 'opacity var(--base) var(--ease-out)',
      }}
    >
      {sizeText}
    </div>
  );
}

/**
 * Container component for positioning the size pill in the header
 */
export function SizePillContainer({ bytes, cap, className = '' }: SizePillProps) {
  return (
    <div
      className={`size-pill-container ${className}`}
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        minHeight: '32px',
      }}
    >
      <SizePill bytes={bytes} cap={cap} />
    </div>
  );
}
