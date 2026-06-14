import type React from 'react';

// 3-layer colored marker from Mural's drawStrokeHighlighter.
export const IconInspectorHighlighter: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      fill="#48525B"
      d="M21.035 12H3.125l.72-5.6c.182-1.2 1.17-2.166 2.463-2.404l10.598-1.95c1.478-.272 2.893.673 3.072 2.05L21.035 12Z"
    />
    <path fill="#B8C1CC" d="M3.123 12 2.02 19.723C1.848 20.926 2.809 22 4.057 22h15.886c1.232 0 2.188-1.047 2.042-2.236L21.035 12H3.123Z" />
    <path
      fill="#DCE1E5"
      d="m22.028 11.878.95 7.764c.222 1.817-1.235 3.357-3.035 3.357H4.057c-1.824 0-3.29-1.58-3.027-3.416l1.122-7.86.703-5.461.001-.012C3.11 4.584 4.46 3.32 6.127 3.013l10.598-1.95c1.96-.36 3.98.88 4.244 2.902v.001l1.059 7.912Zm-5.122-9.832L6.308 3.996C5.015 4.234 4.027 5.2 3.845 6.4l-.72 5.6h-.002L2.02 19.723C1.848 20.926 2.809 22 4.057 22h15.886c1.232 0 2.188-1.046 2.042-2.236L21.035 12l-1.057-7.904c-.179-1.377-1.594-2.32-3.072-2.049Z"
      fillRule="evenodd"
      clipRule="evenodd"
    />
  </svg>
);
