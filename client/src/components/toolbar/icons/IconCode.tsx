import type React from 'react';

// </> brackets + slash — custom 22×21 footprint in 24-unit viewBox. Chevrons 7.77×12 with 45° arms (2.5u perpendicular stroke); slash 2.55 wide × 21 tall at 1:5 slope (2.5u perpendicular). Min chevron-slash clearance ~1.1u at the two diagonal squeeze corners.
export const IconCode: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M12.85,1.5 L15.4,1.5 L11.2,22.5 L8.65,22.5 Z M7,6 L8.77,7.77 L4.54,12 L8.77,16.23 L7,18 L1,12 Z M17,6 L15.23,7.77 L19.46,12 L15.23,16.23 L17,18 L23,12 Z" />
  </svg>
);
