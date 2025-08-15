export type ConnectionState = 'Online' | 'Reconnecting' | 'Offline' | 'Read-only';

export function ConnectionChip({ state }: { state: ConnectionState }) {
  const getDotColor = () => {
    switch (state) {
      case 'Online':
        return '#10B981';
      case 'Reconnecting':
        return '#FCD34D';
      case 'Offline':
        return '#EF4444';
      case 'Read-only':
        return '#94A3B8';
      default:
        return '#94A3B8';
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-chip"
      style={{
        padding: '6px 10px',
        borderRadius: '999px',
        fontSize: '12px',
        color: 'var(--ink-secondary)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: getDotColor(),
          boxShadow: `0 0 0 2px ${getDotColor()}15`,
        }}
      />
      {state}
    </div>
  );
}
