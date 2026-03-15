import React from 'react';

// Mural-style icons: solid filled shapes, viewBox="0 0 24 24", fill="currentColor"
// Design: chunky, bold, paths fill 80-90% of viewBox, detail via evenodd cutouts + compound paths

export const IconSelect: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="m15.533 16.072-2.764 5.243c-.514.974-1.933.895-2.33-.129L5.068 7.264c-.529-1.372.824-2.726 2.196-2.196l13.923 5.372c1.025.396 1.103 1.815.13 2.329l-5.245 2.765c-.23.12-.417.308-.538.538Z" fillRule="evenodd" clipRule="evenodd" />
  </svg>
);

export const IconPan: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M12.362 1c-.866 0-1.568.702-1.568 1.568v1.468c.006.07.009.14.009.211V9a.5.5 0 0 1-1 0v-.481a.503.503 0 0 1-.009-.093V4.082a1.567 1.567 0 0 0-3.124.165v7.955a.5.5 0 1 1-1 0v-1.566a2 2 0 0 0-.103-.634l-.146-.437a1.958 1.958 0 0 0-2.578-1.2h-.001a1.957 1.957 0 0 0-1.14 2.444l2.164 6.472a8.294 8.294 0 0 0 7.293 5.654c.59.04 1.147.065 1.633.065.42 0 .955-.025 1.56-.067a8.43 8.43 0 0 0 7.84-8.406v-5.08l.003-.004v-4.05a1.566 1.566 0 0 0-3.133 0V10a.5.5 0 1 1-1 0V3.208a1.566 1.566 0 1 0-3.132 0v5.597a.5.5 0 0 1-1 0V2.568c0-.866-.702-1.568-1.568-1.568Z" />
  </svg>
);

// Pen: 3 separate filled shapes (nib, body, tip) — pre-computed from Mural's Lottie transforms
export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    {/* Nib (top-right) */}
    <path d="M15.9 2.6C16.7 1.8 17.9 1.8 18.7 2.6L21.4 5.3C22.2 6.1 22.2 7.3 21.4 8.1L20.1 9.4C19.9 9.6 19.6 9.6 19.4 9.4L14.6 4.6C14.4 4.4 14.4 4.1 14.6 3.9L15.9 2.6Z" />
    {/* Body (center diagonal) */}
    <path d="M13.2 6C13 5.8 12.7 5.8 12.5 6L5.2 13.3C4.9 13.6 5 14 5.4 14.1L5.7 14.2L6 14.3C6.2 14.4 6.3 14.5 6.3 14.7L6.4 14.9L6.9 16.6C6.9 16.7 7.1 16.8 7.2 16.9L8.9 17.4L9.1 17.4C9.3 17.5 9.4 17.6 9.5 17.8L9.5 18L9.7 18.7C9.8 19.1 10.3 19.2 10.6 18.9L18 11.5C18.2 11.3 18.2 11 18 10.8L13.2 6Z" />
    {/* Tip (bottom-left) */}
    <path d="M7.5 19C7.7 19.1 7.8 19.2 7.9 19.4L8.1 20.4C8.2 20.6 8.1 20.9 7.8 20.9C7.8 21 7.7 21 7.6 21L2.6 22C2.3 22.1 1.9 21.8 2 21.4L3 16.4C3 16.3 3.1 16.1 3.1 16C3.2 15.8 3.5 15.6 3.7 15.7L4.4 15.9C4.6 16 4.7 16.1 4.7 16.3L5.2 17.9L5.3 18.2C5.3 18.3 5.5 18.4 5.6 18.5L5.9 18.6L7.5 19Z" />
  </svg>
);

export const IconHighlighter: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M14.5 2.5a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L14.3 16.8 7.2 9.7l7.3-7.2Z" />
    <path d="M6.1 10.8l4.1 4.1L7 18H3.5v-3.5l2.6-3.7Z" />
    <rect x="2" y="20" width="12" height="2.5" rx="1.25" />
  </svg>
);

// Eraser: angled block with two cutout grooves creating cap | body | pad sections
export const IconEraser: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="M13.7 1.7a3 3 0 0 1 4.24 0l4.36 4.36a3 3 0 0 1 0 4.24L12.26 20.34H6.9L2.7 16.14a3 3 0 0 1 0-4.24L13.7 1.7ZM8.8 17.24l2.12-2.12-2.83-2.83-2.12 2.12 2.83 2.83Zm8.57-8.57l1.77-1.77-1.41-1.41-1.77 1.77 1.41 1.41Z" />
    <rect x="1.5" y="21" width="21" height="1.5" rx=".75" />
  </svg>
);

// Text: filled rounded rect with T letterform cut out via evenodd
export const IconText: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="M4 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4Zm3.5 4.5a1 1 0 0 0 0 2H11v8a1 1 0 1 0 2 0v-8h3.5a1 1 0 1 0 0-2h-9Z" />
  </svg>
);

export const IconArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M2 10.25h13l-2.5-3.75a1.25 1.25 0 0 1 .25-1.75l.5-.37a1.25 1.25 0 0 1 1.75.25l5 7a1.25 1.25 0 0 1 0 1.5l-5 7a1.25 1.25 0 0 1-1.75.25l-.5-.37a1.25 1.25 0 0 1-.25-1.75L15 14.5H2a2 2 0 0 1 0-4Z" />
  </svg>
);

export const IconLine: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="3" y="10.25" width="18" height="3.5" rx="1.75" transform="rotate(-45 12 12)" />
  </svg>
);

// Rectangle tool — square shape
export const IconRectangle: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" />
  </svg>
);

export const IconEllipse: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <circle cx="12" cy="12" r="9" />
  </svg>
);

export const IconDiamond: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M12 2.5L21.5 12L12 21.5L2.5 12Z" />
  </svg>
);

export const IconCode: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M10 5.8a1.75 1.75 0 0 0-2.55.25l-4.5 5.5a1.75 1.75 0 0 0 0 2.2l4.5 5.5a1.75 1.75 0 0 0 2.75-2L6 12l4.2-5.25A1.75 1.75 0 0 0 10 5.8Z" />
    <path d="M14 5.8a1.75 1.75 0 0 1 2.55.25l4.5 5.5a1.75 1.75 0 0 1 0 2.2l-4.5 5.5A1.75 1.75 0 0 1 13.8 17L18 12l-4.2-5.25A1.75 1.75 0 0 1 14 5.8Z" />
  </svg>
);

// Image: white filled rounded rect with sun + mountain as BLACK cutouts (evenodd)
// Resolved from Mural's mask transforms: translate(12,12)→translate(-2,-2) = translate(10,10)
// Sun: circle at (8,8) radius 2 | Mountain: landscape from y≈10.4 to y=20 | Background: (2,2)→(22,22)
export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="M2 6a4 4 0 0 1 4-4h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6Zm6 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3.7 6.71l2.29-2.3a1.5 1.5 0 0 1 2.12 0L10 15.71l4.59-4.59a1.5 1.5 0 0 1 2.12 0l2.29 2.3c.19.18.3.44.3.7V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-.59c0-.26.11-.52.3-.7Z" />
  </svg>
);

// Fill icon (paint bucket)
export const IconFill: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M9.17 6L12 3.17 14.83 6H9.17ZM7.05 7L12 2.05 16.95 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.05Z" />
    <path d="M20.5 17.5c0 1.38-1.12 2.5-2.5 2.5s-2.5-1.12-2.5-2.5S18 14 18 14s2.5 2.12 2.5 3.5Z" />
  </svg>
);

// Undo — chunky curved arrow left
export const IconUndo: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="M8.5 5.13a.75.75 0 0 0-1.28-.53L3.19 8.63a.75.75 0 0 0 0 1.06l4.03 4.03a.75.75 0 0 0 1.28-.53V11h4a5 5 0 0 1 0 10H10a1.5 1.5 0 0 1 0-3h2.5a2 2 0 0 0 0-4h-4v-2.13a.75.75 0 0 0 0-.24V5.13Z" />
  </svg>
);

// Redo — chunky curved arrow right
export const IconRedo: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="M15.5 5.13a.75.75 0 0 1 1.28-.53l4.03 4.03a.75.75 0 0 1 0 1.06l-4.03 4.03a.75.75 0 0 1-1.28-.53V11h-4a5 5 0 0 0 0 10H14a1.5 1.5 0 0 0 0-3h-2.5a2 2 0 0 1 0-4h4v-2.13a.75.75 0 0 1 0-.24V5.13Z" />
  </svg>
);
