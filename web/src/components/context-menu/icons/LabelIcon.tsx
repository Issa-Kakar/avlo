import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

// Mural `label` glyph — tag silhouette with stitched accent, 24-viewBox.
export const IconLabel = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path
      d="M12.604 1.304a1 1 0 0 0-1.647.327L8.519 7.755a1 1 0 0 1-.58.567L1.65 10.664a1 1 0 0 0-.369 1.633l9.236 9.528a2 2 0 0 0 1.436.608h8.238a2 2 0 0 0 2-1.95l.205-8.215a2 2 0 0 0-.563-1.442l-9.23-9.522Zm.647 7.68-.867.842a1 1 0 1 1-1.394-1.433L12.215 7.2a1.5 1.5 0 0 1 2.12.03l5.203 5.347a1.5 1.5 0 0 1-.03 2.121l-1.224 1.191a1 1 0 1 1-1.395-1.433l.867-.843-1.555-1.598-4.17 4.056.417.429a1 1 0 1 1-1.433 1.394l-2.23-2.291a1 1 0 1 1 1.434-1.395l.418.43 4.169-4.057-1.555-1.599Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
