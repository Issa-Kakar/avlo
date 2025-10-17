import React from 'react';

// All icons use currentColor for automatic color inheritance

export const IconSelect: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    {/* Lasso select icon - exact path from user */}
    <path
      d="M4.495 11.05a8.186 8.186 0 0 0 .695-3.067c.001-.027.006-.052.007-.078l.965.41a9.254 9.254 0 0 1-.648 2.888zm14.087-5.128l-.81.61a12.73 12.73 0 0 1 1.272 1.98l1-.307a13.602 13.602 0 0 0-1.462-2.283zm-4.224-2.13a8.128 8.128 0 0 1 2.02 1.285l.825-.62a9.226 9.226 0 0 0-2.6-1.648zm-4.541-.355a6.581 6.581 0 0 1 1.748-.237 6.919 6.919 0 0 1 .864.063l.245-.985a7.967 7.967 0 0 0-1.109-.078 7.501 7.501 0 0 0-2.023.276zM5.873 18.574a3.676 3.676 0 0 1-2.13-1.012L2.66 17.8a4.49 4.49 0 0 0 3.103 1.776zm-2.861-2.9c-.003-.058-.012-.11-.012-.17 0-.594.314-1.01.917-1.756.168-.208.349-.438.53-.682l-1.13-.169A4.135 4.135 0 0 0 2 15.504c0 .136.012.261.022.389zM6.534 6.3a4.422 4.422 0 0 1 1.458-1.97l-.29-1.016a5.53 5.53 0 0 0-2.078 2.599zm15.084 7.022a16.977 16.977 0 0 0-.788-3.266l-.974.299a16.1 16.1 0 0 1 .587 2.11zM18.757 17l2.189 4.515-2.894 1.456-2.266-4.621L13 22.17V9.51L23.266 17zm-1.597-1h3.038L14 11.478v7.624l1.954-2.68 2.552 5.201 1.11-.559zM11 18.854a8.011 8.011 0 0 0-2.454-.391c-.229 0-.444.011-.651.026l-.111 1.013c.243-.022.493-.039.763-.039a7.2 7.2 0 0 1 2.453.453z"
      //fill="currentColor"
    />
  </svg>
);

export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586"
      //fill="currentColor"
    />
    <rect x="3.5" y="19.25" width="17" height="1.5" rx="0.75" fill="currentColor" />
  </svg>
);

export const IconHighlighter: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="m9 11-6 6v3h9l3-3m10-5-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconEraser: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconText: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M4 7V4h16v3M9 20h6M12 4v16"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconRectangle: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <rect x="5" y="6" width="14" height="12" rx="2"
      stroke="currentColor"
      strokeWidth="2.2"
      fill="none"
    />
  </svg>
);

export const IconEllipse: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <ellipse cx="12" cy="12" rx="8" ry="8"
      stroke="currentColor"
      strokeWidth="2.2"
      fill="none"
    />
  </svg>
);

export const IconArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path d="M4 12h12M12 6l6 6-6 6"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconLine: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <line x1="6" y1="18" x2="18" y2="6"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    />
    <circle cx="6" cy="18" r="2.1" fill="currentColor" />
    <circle cx="18" cy="6" r="2.1" fill="currentColor" />
  </svg>
);

export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" />
    <path d="M7 16l3.2-3.2 3.8 4.8 2.7-3.3L21 18H7z" fill="#2D2D2D" />
    <circle cx="10" cy="9" r="1.6" fill="#2D2D2D" />
  </svg>
);

export const IconPan: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    {...props}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* fingers */}
    <path d="M8 11V7a1.5 1.5 0 0 1 3 0v4" />
    <path d="M11 11V6a1.5 1.5 0 0 1 3 0v5" />
    <path d="M14 11V7a1.5 1.5 0 0 1 3 0v4" />
    {/* palm */}
    <path d="M6 12a2 2 0 0 0-2 2v1a5 5 0 0 0 5 5h4a4 4 0 0 0 4-4v-2" />
  </svg>
);

// Fill icon (paint bucket metaphor)
export const IconFill: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M3 11l6-6 8 8-6 6-8-8Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <path
      d="M15 7l2-2m-2 6c2.5.8 3.8 1.7 3.8 2.7 0 1.1-1.4 2-4.2 2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);