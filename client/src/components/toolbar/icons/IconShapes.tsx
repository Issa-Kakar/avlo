import type React from 'react';

// Composite "shapes" glyph for the toolbar's single shape entry-point. A
// circle + soft triangle + connector-arrow trio in the 24x24 grid; coords are
// the Lottie source transformed 1:1 — do not "tidy" — the shaft cap and
// chevron vertex are tangent at x=21.960 by construction.
//
// Clicking the dock button activates the shape tool with the persisted
// variant; the inspector exposes per-variant icons via `ShapeVariantIcons`.
export const IconShapes: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M18.972 11.004L21.96 8.016L18.972 5.028"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.992"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M14.988 8.016L20.964 8.016" fill="none" stroke="currentColor" strokeWidth="1.992" strokeLinecap="round" />
    <circle cx="6.522" cy="9.51" r="5.478" fill="currentColor" />
    <path
      fill="currentColor"
      d="M13.024 13.387C14.083 11.554 15.801 11.554 16.859 13.387L19.925 18.697C20.983 20.530 20.124 22.018 18.008 22.018L11.876 22.018C9.759 22.018 8.900 20.530 9.958 18.697Z"
    />
  </svg>
);
