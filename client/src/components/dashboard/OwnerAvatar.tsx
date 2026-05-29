import { initials, tintFor } from './data';

// 25×25 initials circle, tinted deterministically by owner name.
export function OwnerAvatar({ name }: { name: string }) {
  return (
    <span className="dash-avatar" style={{ background: tintFor(name) }}>
      {initials(name)}
    </span>
  );
}
