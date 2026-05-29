import type React from 'react';

/**
 * Edit glyph — Mural pencil-on-card. Two paths (pencil tip + card body)
 * blend via `currentColor`. 24-viewBox.
 */
export const EditIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
    <path d="M17.735 2.853a2.62 2.62 0 1 1 3.706 3.706l-.88.88a.5.5 0 0 1-.708 0L16.855 4.44a.5.5 0 0 1 0-.707l.88-.88Zm.704 6a.5.5 0 0 1 0 .707l-4.896 4.896a4 4 0 0 1-2.188 1.12l-2.464.4a.5.5 0 0 1-.574-.573l.4-2.465a4 4 0 0 1 1.12-2.187l4.896-4.897a.5.5 0 0 1 .707 0l2.999 3Z" />
    <path d="m8.567 9.192-.014.015-.13.13a6 6 0 0 0-1.68 3.28l-.4 2.465a2.5 2.5 0 0 0 2.868 2.869l2.465-.4a6 6 0 0 0 3.281-1.68l2.342-2.342c.63-.621 1.701-.175 1.701.713V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h5.345c.89 0 1.337 1.077.707 1.707L8.567 9.192Z" />
  </svg>
);
