import type React from 'react';

type SvgProps = React.SVGProps<SVGSVGElement>;

// Mural connectorStraightToolbar — diagonal pill with end dots, 24-viewBox.
export const IconConnectorStraight = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M23 5a3 3 0 0 1-3.93 2.853.556.556 0 0 0-.541.096L7.118 17.933a.557.557 0 0 0-.167.523 3 3 0 1 1-2.02-2.309c.186.06.393.033.54-.096l11.411-9.984a.557.557 0 0 0 .167-.523A3 3 0 1 1 23 5Z" />
  </svg>
);

// Mural connectorCornersToolbar — orthogonal step with end dots, 24-viewBox.
export const IconConnectorOrthogonal = (props: SvgProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M23 5a3 3 0 0 1-5.579 1.534.557.557 0 0 0-.47-.284H13.75a.5.5 0 0 0-.5.5V19c0 .69-.56 1.25-1.25 1.25H7.049a.557.557 0 0 0-.47.284 3 3 0 1 1 0-3.067c.1.167.274.283.47.283h3.201a.5.5 0 0 0 .5-.5V5c0-.69.56-1.25 1.25-1.25h4.951c.196 0 .37-.116.47-.284A3 3 0 0 1 23 5Z" />
  </svg>
);
