import type React from 'react';

// Shape inspector variant icons. One filled silhouette per `ShapeVariant`,
// drawn at a native 20-unit viewBox so each unit is pixel-aligned at the
// inspector's 20px CSS render size — and the silhouettes extend to the
// viewBox edges so they fill the icon area instead of floating in 15px of
// content inside 20px of negative space.
//
// Same family as ConnectorVariantIcons: fill-only (no strokes); the
// silhouette itself carries the variant, not the outline.

type SvgProps = React.SVGProps<SVGSVGElement>;

/** Sharp rectangle, edge to edge. The radius is what distinguishes it from
 *  `IconShapeRoundedRect`, so this one stays at rx=0. */
export const IconShapeRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect width="20" height="20" />
  </svg>
);

/** Full circle at r=10 — fills the viewBox. */
export const IconShapeEllipse: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <circle cx="10" cy="10" r="10" />
  </svg>
);

/** Rotated square at full extent — same span as the rectangle, rotated 45°. */
export const IconShapeDiamond: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M10 0L20 10L10 20L0 10Z" />
  </svg>
);

/** Isoceles triangle, apex up. Base spans the full bottom edge so the
 *  silhouette fills the bounding box (ink coverage ≈ 50% of the rect by
 *  geometry — unavoidable for any triangle in a square box). */
export const IconShapeTriangle: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <path d="M10 0L20 20L0 20Z" />
  </svg>
);

/** Rounded square. rx=6 = 30% radius — strong enough to clearly read as a
 *  rounded variant at 20px without collapsing the silhouette toward a circle. */
export const IconShapeRoundedRect: React.FC<SvgProps> = (props) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="currentColor" {...props}>
    <rect width="20" height="20" rx="6" />
  </svg>
);
