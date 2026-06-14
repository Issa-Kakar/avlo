import type React from 'react';

// 3-layer colored pen from Mural's drawStrokeFine.
export const IconInspectorPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path fill="#B8C1CC" d="M16.597 12.163H7.403l-2.508 7.331a2 2 0 0 0 1.892 2.648h10.426a2 2 0 0 0 1.892-2.648l-2.508-7.331Z" />
    <path fill="#48525B" d="M13.42 2.872c-.463-1.352-2.377-1.352-2.84 0l-3.177 9.291h9.194l-3.178-9.29Z" />
    <path
      fill="#DCE1E5"
      d="m14.365 2.549 5.686 16.622a3 3 0 0 1-2.838 3.97H6.787a3 3 0 0 1-2.838-3.97L9.634 2.549c.772-2.255 3.96-2.255 4.731 0Zm-.946.323c-.463-1.352-2.376-1.352-2.838 0L4.895 19.494a2 2 0 0 0 1.892 2.648h10.426a2 2 0 0 0 1.892-2.648L13.419 2.872Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
