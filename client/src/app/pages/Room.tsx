// Phase 2 shell: no drawing/editor execution; advanced controls are presentational only.
import { useParams } from 'react-router-dom';

export default function Room() {
  const { id } = useParams<{ id: string }>();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'var(--font-ui)',
        color: 'var(--ink)',
        background: 'var(--bg)',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1>Room: {id}</h1>
        <p>Room implementation will be completed in remaining Phase 2 work.</p>
      </div>
    </div>
  );
}
