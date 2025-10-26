import React from 'react';

// All icons use currentColor for automatic color inheritance

export const IconSelect: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M7.92098 2.29951C6.93571 1.5331 5.5 2.23523 5.5 3.48349V20.4923C5.5 21.9145 7.2945 22.5382 8.17661 21.4226L12.3676 16.1224C12.6806 15.7267 13.1574 15.4958 13.6619 15.4958H20.5143C21.9425 15.4958 22.5626 13.6887 21.4353 12.8119L7.92098 2.29951Z" />
  </svg>
);

export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" {...props}>
    <path
      d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" {...props}>
    <line
      x1="5"
      y1="19"
      x2="19"
      y2="5"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);

export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" {...props}>
    <rect
      x="3"
      y="3"
      width="18"
      height="18"
      rx="2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" strokeWidth="2" />
    <path
      d="M21 15l-5-5L5 21"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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