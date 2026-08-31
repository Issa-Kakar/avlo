import type { SVGProps } from 'react';

/** Four-point spark + companion star — the AI affordance. Follows the icon
 *  convention: currentColor fills, size from CSS/props, aria-hidden. */
export function AiIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" {...props}>
      <path
        fill="currentColor"
        d="M9.5 3.5c.2-.6 1-.6 1.2 0l1.55 4.46a3 3 0 0 0 1.84 1.84l4.46 1.55c.6.2.6 1 0 1.2l-4.46 1.55a3 3 0 0 0-1.84 1.84L10.7 20.4c-.2.6-1 .6-1.2 0l-1.55-4.46a3 3 0 0 0-1.84-1.84L1.65 12.55c-.6-.2-.6-1 0-1.2l4.46-1.55a3 3 0 0 0 1.84-1.84L9.5 3.5Z"
      />
      <path
        fill="currentColor"
        d="M18.6 2.6c.12-.36.63-.36.75 0l.57 1.71c.1.3.33.53.63.63l1.71.57c.36.12.36.63 0 .75l-1.71.57c-.3.1-.53.33-.63.63l-.57 1.71c-.12.36-.63.36-.75 0l-.57-1.71a1 1 0 0 0-.63-.63l-1.71-.57c-.36-.12-.36-.63 0-.75l1.71-.57a1 1 0 0 0 .63-.63l.57-1.71Z"
      />
    </svg>
  );
}
