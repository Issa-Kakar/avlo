import type React from 'react';

/**
 * Invite glyph for the Share button — a community shape with a person head
 * and a "+" badge. Filled paths, currentColor (inherits the button text).
 */
export const ShareIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M15.663 13.465c.351.191.678.423.973.688A2.987 2.987 0 0 0 16 16a3 3 0 0 0-1.538 5.576c-.94.276-1.933.424-2.962.424C5.701 22 1 17.299 1 11.5S5.701 1 11.5 1 22 5.701 22 11.5c0 1.029-.148 2.023-.424 2.962a3.007 3.007 0 0 0-1.73-1.341 8.5 8.5 0 1 0-15.039 3.62 5.142 5.142 0 0 1 2.53-3.276c.61-.333 1.331-.119 1.947.203a4.77 4.77 0 0 0 2.216.543c.8 0 1.553-.197 2.216-.543.616-.322 1.337-.536 1.947-.203Z" />
    <path d="M15 19a1 1 0 0 1 1-1h2v-2a1 1 0 1 1 2 0v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 0 1-1-1Zm-3.5-7.158A3.421 3.421 0 1 0 11.5 5a3.421 3.421 0 0 0 0 6.842Z" />
  </svg>
);
