import type React from 'react';

// Shape inspector variant icons. One filled silhouette per `ShapeVariant`,
// drawn inside a 20-unit viewBox so the SVG box matches the inspector's
// 20px CSS render size (and the connector variants' icon box). The
// silhouettes are 19×19, centered with a 0.5-unit inset on each side —
// filled shapes carry more visual weight per pixel than the main toolbar
// icons (which have built-in negative space), so this trim keeps them
// from out-shouting the dock without changing the icon footprint.
//
// Same family as ConnectorVariantIcons: fill-only (no strokes); the
// silhouette itself carries the variant, not the outline.

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Sharp rectangle. rx=0 is what distinguishes it from `IconShapeRoundedRect`. */
export const IconShapeRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="0.5" y="0.5" width="19" height="19" />
  </svg>
);

/** Circle at r=9.5, centered. */
export const IconShapeEllipse: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <circle cx="10" cy="10" r="9.5" />
  </svg>
);

/** Rotated square, same 19-unit span as the rectangle. */
export const IconShapeDiamond: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M10 0.5L19.5 10L10 19.5L0.5 10Z" />
  </svg>
);

/** Isoceles triangle, apex up. Base spans the trimmed 19-unit bottom edge
 *  (ink coverage ≈ 50% of the rect by geometry — unavoidable for any
 *  triangle in a square box). */
export const IconShapeTriangle: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M10 0.5L19.5 19.5L0.5 19.5Z" />
  </svg>
);

/** Rounded square. rx=6 ≈ 32% of the 19-unit side — strong enough to clearly
 *  read as a rounded variant without collapsing the silhouette toward a circle. */
export const IconShapeRoundedRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect x="0.5" y="0.5" width="19" height="19" rx="6" />
  </svg>
);
