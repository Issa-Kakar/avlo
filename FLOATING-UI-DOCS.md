# compute position file
```typescript

import {computeCoordsFromPlacement} from './computeCoordsFromPlacement';
import {detectOverflow} from './detectOverflow';
import type {ComputePosition, Middleware, MiddlewareData} from './types';

/**
 * Computes the `x` and `y` coordinates that will place the floating element
 * next to a given reference element.
 *
 * This export does not have any `platform` interface logic. You will need to
 * write one for the platform you are using Floating UI with.
 */
export const computePosition: ComputePosition = async (
  reference,
  floating,
  config,
) => {
  const {
    placement = 'bottom',
    strategy = 'absolute',
    middleware = [],
    platform,
  } = config;

  const validMiddleware = middleware.filter(Boolean) as Middleware[];
  const rtl = await platform.isRTL?.(floating);

  let rects = await platform.getElementRects({reference, floating, strategy});
  let {x, y} = computeCoordsFromPlacement(rects, placement, rtl);
  let statefulPlacement = placement;
  let middlewareData: MiddlewareData = {};
  let resetCount = 0;

  for (let i = 0; i < validMiddleware.length; i++) {
    const {name, fn} = validMiddleware[i];

    const {
      x: nextX,
      y: nextY,
      data,
      reset,
    } = await fn({
      x,
      y,
      initialPlacement: placement,
      placement: statefulPlacement,
      strategy,
      middlewareData,
      rects,
      platform: {
        ...platform,
        detectOverflow: platform.detectOverflow ?? detectOverflow,
      },
      elements: {reference, floating},
    });

    x = nextX ?? x;
    y = nextY ?? y;

    middlewareData = {
      ...middlewareData,
      [name]: {
        ...middlewareData[name],
        ...data,
      },
    };

    if (reset && resetCount <= 50) {
      resetCount++;

      if (typeof reset === 'object') {
        if (reset.placement) {
          statefulPlacement = reset.placement;
        }

        if (reset.rects) {
          rects =
            reset.rects === true
              ? await platform.getElementRects({reference, floating, strategy})
              : reset.rects;
        }

        ({x, y} = computeCoordsFromPlacement(rects, statefulPlacement, rtl));
      }

      i = -1;
    }
  }

  return {
    x,
    y,
    placement: statefulPlacement,
    strategy,
    middlewareData,
  };
};
```

# compute coords for placement
```typescript
import type {Coords, ElementRects, Placement} from '@floating-ui/utils';
import {
  getAlignment,
  getAlignmentAxis,
  getAxisLength,
  getSide,
  getSideAxis,
} from '@floating-ui/utils';

export function computeCoordsFromPlacement(
  {reference, floating}: ElementRects,
  placement: Placement,
  rtl?: boolean,
): Coords {
  const sideAxis = getSideAxis(placement);
  const alignmentAxis = getAlignmentAxis(placement);
  const alignLength = getAxisLength(alignmentAxis);
  const side = getSide(placement);
  const isVertical = sideAxis === 'y';

  const commonX = reference.x + reference.width / 2 - floating.width / 2;
  const commonY = reference.y + reference.height / 2 - floating.height / 2;
  const commonAlign = reference[alignLength] / 2 - floating[alignLength] / 2;

  let coords: Coords;
  switch (side) {
    case 'top':
      coords = {x: commonX, y: reference.y - floating.height};
      break;
    case 'bottom':
      coords = {x: commonX, y: reference.y + reference.height};
      break;
    case 'right':
      coords = {x: reference.x + reference.width, y: commonY};
      break;
    case 'left':
      coords = {x: reference.x - floating.width, y: commonY};
      break;
    default:
      coords = {x: reference.x, y: reference.y};
  }

  switch (getAlignment(placement)) {
    case 'start':
      coords[alignmentAxis] -= commonAlign * (rtl && isVertical ? -1 : 1);
      break;
    case 'end':
      coords[alignmentAxis] += commonAlign * (rtl && isVertical ? -1 : 1);
      break;
    default:
  }

  return coords;
}
```
# detect overflow file
```typescript
import type {Padding, SideObject} from '@floating-ui/utils';
import {evaluate, getPaddingObject, rectToClientRect} from '@floating-ui/utils';

import type {
  Boundary,
  Derivable,
  ElementContext,
  MiddlewareState,
  RootBoundary,
} from './types';

export interface DetectOverflowOptions {
  /**
   * The clipping element(s) or area in which overflow will be checked.
   * @default 'clippingAncestors'
   */
  boundary?: Boundary;
  /**
   * The root clipping area in which overflow will be checked.
   * @default 'viewport'
   */
  rootBoundary?: RootBoundary;
  /**
   * The element in which overflow is being checked relative to a boundary.
   * @default 'floating'
   */
  elementContext?: ElementContext;
  /**
   * Whether to check for overflow using the alternate element's boundary
   * (`clippingAncestors` boundary only).
   * @default false
   */
  altBoundary?: boolean;
  /**
   * Virtual padding for the resolved overflow detection offsets.
   * @default 0
   */
  padding?: Padding;
}

/**
 * Resolves with an object of overflow side offsets that determine how much the
 * element is overflowing a given clipping boundary on each side.
 * - positive = overflowing the boundary by that number of pixels
 * - negative = how many pixels left before it will overflow
 * - 0 = lies flush with the boundary
 * @see https://floating-ui.com/docs/detectOverflow
 */
export async function detectOverflow(
  state: MiddlewareState,
  options: DetectOverflowOptions | Derivable<DetectOverflowOptions> = {},
): Promise<SideObject> {
  const {x, y, platform, rects, elements, strategy} = state;

  const {
    boundary = 'clippingAncestors',
    rootBoundary = 'viewport',
    elementContext = 'floating',
    altBoundary = false,
    padding = 0,
  } = evaluate(options, state);

  const paddingObject = getPaddingObject(padding);
  const altContext = elementContext === 'floating' ? 'reference' : 'floating';
  const element = elements[altBoundary ? altContext : elementContext];

  const clippingClientRect = rectToClientRect(
    await platform.getClippingRect({
      element:
        (await platform.isElement?.(element)) ?? true
          ? element
          : element.contextElement ||
            (await platform.getDocumentElement?.(elements.floating)),
      boundary,
      rootBoundary,
      strategy,
    }),
  );

  const rect =
    elementContext === 'floating'
      ? {x, y, width: rects.floating.width, height: rects.floating.height}
      : rects.reference;

  const offsetParent = await platform.getOffsetParent?.(elements.floating);
  const offsetScale = (await platform.isElement?.(offsetParent))
    ? (await platform.getScale?.(offsetParent)) || {x: 1, y: 1}
    : {x: 1, y: 1};

  const elementClientRect = rectToClientRect(
    platform.convertOffsetParentRelativeRectToViewportRelativeRect
      ? await platform.convertOffsetParentRelativeRectToViewportRelativeRect({
          elements,
          rect,
          offsetParent,
          strategy,
        })
      : rect,
  );

  return {
    top:
      (clippingClientRect.top - elementClientRect.top + paddingObject.top) /
      offsetScale.y,
    bottom:
      (elementClientRect.bottom -
        clippingClientRect.bottom +
        paddingObject.bottom) /
      offsetScale.y,
    left:
      (clippingClientRect.left - elementClientRect.left + paddingObject.left) /
      offsetScale.x,
    right:
      (elementClientRect.right -
        clippingClientRect.right +
        paddingObject.right) /
      offsetScale.x,
  };
}
```
# types.ts
```typescript
import type {
  Axis,
  ClientRectObject,
  Coords,
  Dimensions,
  ElementRects,
  Placement,
  Rect,
  SideObject,
  Strategy,
} from '@floating-ui/utils';
import type {detectOverflow} from './detectOverflow';

type Promisable<T> = T | Promise<T>;

/**
 * Function option to derive middleware options from state.
 */
export type Derivable<T> = (state: MiddlewareState) => T;

/**
 * Platform interface methods to work with the current platform.
 * @see https://floating-ui.com/docs/platform
 */
export interface Platform {
  // Required
  getElementRects: (args: {
    reference: ReferenceElement;
    floating: FloatingElement;
    strategy: Strategy;
  }) => Promisable<ElementRects>;
  getClippingRect: (args: {
    element: any;
    boundary: Boundary;
    rootBoundary: RootBoundary;
    strategy: Strategy;
  }) => Promisable<Rect>;
  getDimensions: (element: any) => Promisable<Dimensions>;

  // Optional
  convertOffsetParentRelativeRectToViewportRelativeRect?: (args: {
    elements?: Elements;
    rect: Rect;
    offsetParent: any;
    strategy: Strategy;
  }) => Promisable<Rect>;
  getOffsetParent?: (element: any) => Promisable<any>;
  isElement?: (value: any) => Promisable<boolean>;
  getDocumentElement?: (element: any) => Promisable<any>;
  getClientRects?: (element: any) => Promisable<Array<ClientRectObject>>;
  isRTL?: (element: any) => Promisable<boolean>;
  getScale?: (element: any) => Promisable<{x: number; y: number}>;
  detectOverflow?: typeof detectOverflow;
}

export interface MiddlewareData {
  [key: string]: any;
  arrow?: Partial<Coords> & {
    centerOffset: number;
    alignmentOffset?: number;
  };
  autoPlacement?: {
    index?: number;
    overflows: Array<{
      placement: Placement;
      overflows: Array<number>;
    }>;
  };
  flip?: {
    index?: number;
    overflows: Array<{
      placement: Placement;
      overflows: Array<number>;
    }>;
  };
  hide?: {
    referenceHidden?: boolean;
    escaped?: boolean;
    referenceHiddenOffsets?: SideObject;
    escapedOffsets?: SideObject;
  };
  offset?: Coords & {placement: Placement};
  shift?: Coords & {
    enabled: {[key in Axis]: boolean};
  };
}

export interface ComputePositionConfig {
  /**
   * Object to interface with the current platform.
   */
  platform: Platform;
  /**
   * Where to place the floating element relative to the reference element.
   */
  placement?: Placement;
  /**
   * The strategy to use when positioning the floating element.
   */
  strategy?: Strategy;
  /**
   * Array of middleware objects to modify the positioning or provide data for
   * rendering.
   */
  middleware?: Array<Middleware | null | undefined | false>;
}

export interface ComputePositionReturn extends Coords {
  /**
   * The final chosen placement of the floating element.
   */
  placement: Placement;
  /**
   * The strategy used to position the floating element.
   */
  strategy: Strategy;
  /**
   * Object containing data returned from all middleware, keyed by their name.
   */
  middlewareData: MiddlewareData;
}

export type ComputePosition = (
  reference: unknown,
  floating: unknown,
  config: ComputePositionConfig,
) => Promise<ComputePositionReturn>;

export interface MiddlewareReturn extends Partial<Coords> {
  data?: {
    [key: string]: any;
  };
  reset?:
    | boolean
    | {
        placement?: Placement;
        rects?: boolean | ElementRects;
      };
}

export type Middleware = {
  name: string;
  options?: any;
  fn: (state: MiddlewareState) => Promisable<MiddlewareReturn>;
};

export type ReferenceElement = any;
export type FloatingElement = any;

export interface Elements {
  reference: ReferenceElement;
  floating: FloatingElement;
}

export interface MiddlewareState extends Coords {
  initialPlacement: Placement;
  placement: Placement;
  strategy: Strategy;
  middlewareData: MiddlewareData;
  elements: Elements;
  rects: ElementRects;
  platform: {detectOverflow: typeof detectOverflow} & Platform;
}
/**
 * @deprecated use `MiddlewareState` instead.
 */
export type MiddlewareArguments = MiddlewareState;

export type Boundary = any;
export type RootBoundary = 'viewport' | 'document' | Rect;
export type ElementContext = 'reference' | 'floating';
```
# flip.ts in utils
```typescript
import type {Placement} from '@floating-ui/utils';
import {
  evaluate,
  getAlignmentSides,
  getExpandedPlacements,
  getOppositeAxisPlacements,
  getOppositePlacement,
  getSide,
  getSideAxis,
} from '@floating-ui/utils';

import type {DetectOverflowOptions} from '../detectOverflow';
import type {Derivable, Middleware} from '../types';

export interface FlipOptions extends DetectOverflowOptions {
  /**
   * The axis that runs along the side of the floating element. Determines
   * whether overflow along this axis is checked to perform a flip.
   * @default true
   */
  mainAxis?: boolean;
  /**
   * The axis that runs along the alignment of the floating element. Determines
   * whether overflow along this axis is checked to perform a flip.
   * - `true`: Whether to check cross axis overflow for both side and alignment flipping.
   * - `false`: Whether to disable all cross axis overflow checking.
   * - `'alignment'`: Whether to check cross axis overflow for alignment flipping only.
   * @default true
   */
  crossAxis?: boolean | 'alignment';
  /**
   * Placements to try sequentially if the preferred `placement` does not fit.
   * @default [oppositePlacement] (computed)
   */
  fallbackPlacements?: Array<Placement>;
  /**
   * What strategy to use when no placements fit.
   * @default 'bestFit'
   */
  fallbackStrategy?: 'bestFit' | 'initialPlacement';
  /**
   * Whether to allow fallback to the perpendicular axis of the preferred
   * placement, and if so, which side direction along the axis to prefer.
   * @default 'none' (disallow fallback)
   */
  fallbackAxisSideDirection?: 'none' | 'start' | 'end';
  /**
   * Whether to flip to placements with the opposite alignment if they fit
   * better.
   * @default true
   */
  flipAlignment?: boolean;
}

/**
 * Optimizes the visibility of the floating element by flipping the `placement`
 * in order to keep it in view when the preferred placement(s) will overflow the
 * clipping boundary. Alternative to `autoPlacement`.
 * @see https://floating-ui.com/docs/flip
 */
export const flip = (
  options: FlipOptions | Derivable<FlipOptions> = {},
): Middleware => ({
  name: 'flip',
  options,
  async fn(state) {
    const {
      placement,
      middlewareData,
      rects,
      initialPlacement,
      platform,
      elements,
    } = state;

    const {
      mainAxis: checkMainAxis = true,
      crossAxis: checkCrossAxis = true,
      fallbackPlacements: specifiedFallbackPlacements,
      fallbackStrategy = 'bestFit',
      fallbackAxisSideDirection = 'none',
      flipAlignment = true,
      ...detectOverflowOptions
    } = evaluate(options, state);

    // If a reset by the arrow was caused due to an alignment offset being
    // added, we should skip any logic now since `flip()` has already done its
    // work.
    // https://github.com/floating-ui/floating-ui/issues/2549#issuecomment-1719601643
    if (middlewareData.arrow?.alignmentOffset) {
      return {};
    }

    const side = getSide(placement);
    const initialSideAxis = getSideAxis(initialPlacement);
    const isBasePlacement = getSide(initialPlacement) === initialPlacement;
    const rtl = await platform.isRTL?.(elements.floating);

    const fallbackPlacements =
      specifiedFallbackPlacements ||
      (isBasePlacement || !flipAlignment
        ? [getOppositePlacement(initialPlacement)]
        : getExpandedPlacements(initialPlacement));

    const hasFallbackAxisSideDirection = fallbackAxisSideDirection !== 'none';

    if (!specifiedFallbackPlacements && hasFallbackAxisSideDirection) {
      fallbackPlacements.push(
        ...getOppositeAxisPlacements(
          initialPlacement,
          flipAlignment,
          fallbackAxisSideDirection,
          rtl,
        ),
      );
    }

    const placements = [initialPlacement, ...fallbackPlacements];

    const overflow = await platform.detectOverflow(
      state,
      detectOverflowOptions,
    );

    const overflows = [];
    let overflowsData = middlewareData.flip?.overflows || [];

    if (checkMainAxis) {
      overflows.push(overflow[side]);
    }

    if (checkCrossAxis) {
      const sides = getAlignmentSides(placement, rects, rtl);
      overflows.push(overflow[sides[0]], overflow[sides[1]]);
    }

    overflowsData = [...overflowsData, {placement, overflows}];

    // One or more sides is overflowing.
    if (!overflows.every((side) => side <= 0)) {
      const nextIndex = (middlewareData.flip?.index || 0) + 1;
      const nextPlacement = placements[nextIndex];

      if (nextPlacement) {
        const ignoreCrossAxisOverflow =
          checkCrossAxis === 'alignment'
            ? initialSideAxis !== getSideAxis(nextPlacement)
            : false;

        if (
          !ignoreCrossAxisOverflow ||
          // We leave the current main axis only if every placement on that axis
          // overflows the main axis.
          overflowsData.every((d) =>
            getSideAxis(d.placement) === initialSideAxis
              ? d.overflows[0] > 0
              : true,
          )
        ) {
          // Try next placement and re-run the lifecycle.
          return {
            data: {
              index: nextIndex,
              overflows: overflowsData,
            },
            reset: {
              placement: nextPlacement,
            },
          };
        }
      }

      // First, find the candidates that fit on the mainAxis side of overflow,
      // then find the placement that fits the best on the main crossAxis side.
      let resetPlacement = overflowsData
        .filter((d) => d.overflows[0] <= 0)
        .sort((a, b) => a.overflows[1] - b.overflows[1])[0]?.placement;

      // Otherwise fallback.
      if (!resetPlacement) {
        switch (fallbackStrategy) {
          case 'bestFit': {
            const placement = overflowsData
              .filter((d) => {
                if (hasFallbackAxisSideDirection) {
                  const currentSideAxis = getSideAxis(d.placement);
                  return (
                    currentSideAxis === initialSideAxis ||
                    // Create a bias to the `y` side axis due to horizontal
                    // reading directions favoring greater width.
                    currentSideAxis === 'y'
                  );
                }
                return true;
              })
              .map(
                (d) =>
                  [
                    d.placement,
                    d.overflows
                      .filter((overflow) => overflow > 0)
                      .reduce((acc, overflow) => acc + overflow, 0),
                  ] as const,
              )
              .sort((a, b) => a[1] - b[1])[0]?.[0];
            if (placement) {
              resetPlacement = placement;
            }
            break;
          }
          case 'initialPlacement':
            resetPlacement = initialPlacement;
            break;
          default:
        }
      }

      if (placement !== resetPlacement) {
        return {
          reset: {
            placement: resetPlacement,
          },
        };
      }
    }

    return {};
  },
});
```
# hide.ts
```typescript
import type {Rect, SideObject} from '@floating-ui/utils';
import {evaluate, sides} from '@floating-ui/utils';

import type {DetectOverflowOptions} from '../detectOverflow';
import type {Derivable, Middleware} from '../types';

function getSideOffsets(overflow: SideObject, rect: Rect) {
  return {
    top: overflow.top - rect.height,
    right: overflow.right - rect.width,
    bottom: overflow.bottom - rect.height,
    left: overflow.left - rect.width,
  };
}

function isAnySideFullyClipped(overflow: SideObject) {
  return sides.some((side) => overflow[side] >= 0);
}

export interface HideOptions extends DetectOverflowOptions {
  /**
   * The strategy used to determine when to hide the floating element.
   */
  strategy?: 'referenceHidden' | 'escaped';
}

/**
 * Provides data to hide the floating element in applicable situations, such as
 * when it is not in the same clipping context as the reference element.
 * @see https://floating-ui.com/docs/hide
 */
export const hide = (
  options: HideOptions | Derivable<HideOptions> = {},
): Middleware => ({
  name: 'hide',
  options,
  async fn(state) {
    const {rects, platform} = state;

    const {strategy = 'referenceHidden', ...detectOverflowOptions} = evaluate(
      options,
      state,
    );

    switch (strategy) {
      case 'referenceHidden': {
        const overflow = await platform.detectOverflow(state, {
          ...detectOverflowOptions,
          elementContext: 'reference',
        });
        const offsets = getSideOffsets(overflow, rects.reference);
        return {
          data: {
            referenceHiddenOffsets: offsets,
            referenceHidden: isAnySideFullyClipped(offsets),
          },
        };
      }
      case 'escaped': {
        const overflow = await platform.detectOverflow(state, {
          ...detectOverflowOptions,
          altBoundary: true,
        });
        const offsets = getSideOffsets(overflow, rects.floating);
        return {
          data: {
            escapedOffsets: offsets,
            escaped: isAnySideFullyClipped(offsets),
          },
        };
      }
      default: {
        return {};
      }
    }
  },
});
```
# offset.ts, and shift.ts
```typescript
import {
  type Coords,
  evaluate,
  getAlignment,
  getSide,
  getSideAxis,
} from '@floating-ui/utils';

import {originSides} from '../constants';
import type {Derivable, Middleware, MiddlewareState} from '../types';

type OffsetValue =
  | number
  | {
      /**
       * The axis that runs along the side of the floating element. Represents
       * the distance (gutter or margin) between the reference and floating
       * element.
       * @default 0
       */
      mainAxis?: number;
      /**
       * The axis that runs along the alignment of the floating element.
       * Represents the skidding between the reference and floating element.
       * @default 0
       */
      crossAxis?: number;
      /**
       * The same axis as `crossAxis` but applies only to aligned placements
       * and inverts the `end` alignment. When set to a number, it overrides the
       * `crossAxis` value.
       *
       * A positive number will move the floating element in the direction of
       * the opposite edge to the one that is aligned, while a negative number
       * the reverse.
       * @default null
       */
      alignmentAxis?: number | null;
    };

// For type backwards-compatibility, the `OffsetOptions` type was also
// Derivable.
export type OffsetOptions = OffsetValue | Derivable<OffsetValue>;

export async function convertValueToCoords(
  state: MiddlewareState,
  options: OffsetOptions,
): Promise<Coords> {
  const {placement, platform, elements} = state;
  const rtl = await platform.isRTL?.(elements.floating);

  const side = getSide(placement);
  const alignment = getAlignment(placement);
  const isVertical = getSideAxis(placement) === 'y';
  const mainAxisMulti = originSides.has(side) ? -1 : 1;
  const crossAxisMulti = rtl && isVertical ? -1 : 1;
  const rawValue = evaluate(options, state);

  // eslint-disable-next-line prefer-const
  let {mainAxis, crossAxis, alignmentAxis} =
    typeof rawValue === 'number'
      ? {mainAxis: rawValue, crossAxis: 0, alignmentAxis: null}
      : {
          mainAxis: rawValue.mainAxis || 0,
          crossAxis: rawValue.crossAxis || 0,
          alignmentAxis: rawValue.alignmentAxis,
        };

  if (alignment && typeof alignmentAxis === 'number') {
    crossAxis = alignment === 'end' ? alignmentAxis * -1 : alignmentAxis;
  }

  return isVertical
    ? {x: crossAxis * crossAxisMulti, y: mainAxis * mainAxisMulti}
    : {x: mainAxis * mainAxisMulti, y: crossAxis * crossAxisMulti};
}

/**
 * Modifies the placement by translating the floating element along the
 * specified axes.
 * A number (shorthand for `mainAxis` or distance), or an axes configuration
 * object may be passed.
 * @see https://floating-ui.com/docs/offset
 */
export const offset = (options: OffsetOptions = 0): Middleware => ({
  name: 'offset',
  options,
  async fn(state) {
    const {x, y, placement, middlewareData} = state;
    const diffCoords = await convertValueToCoords(state, options);

    // If the placement is the same and the arrow caused an alignment offset
    // then we don't need to change the positioning coordinates.
    if (
      placement === middlewareData.offset?.placement &&
      middlewareData.arrow?.alignmentOffset
    ) {
      return {};
    }

    return {
      x: x + diffCoords.x,
      y: y + diffCoords.y,
      data: {
        ...diffCoords,
        placement,
      },
    };
  },
});

// shift.ts
import {
  type Coords,
  clamp,
  evaluate,
  getOppositeAxis,
  getSide,
  getSideAxis,
} from '@floating-ui/utils';

import {originSides} from '../constants';
import type {DetectOverflowOptions} from '../detectOverflow';
import type {Derivable, Middleware, MiddlewareState} from '../types';

export interface ShiftOptions extends DetectOverflowOptions {
  /**
   * The axis that runs along the alignment of the floating element. Determines
   * whether overflow along this axis is checked to perform shifting.
   * @default true
   */
  mainAxis?: boolean;
  /**
   * The axis that runs along the side of the floating element. Determines
   * whether overflow along this axis is checked to perform shifting.
   * @default false
   */
  crossAxis?: boolean;
  /**
   * Accepts a function that limits the shifting done in order to prevent
   * detachment.
   */
  limiter?: {
    fn: (state: MiddlewareState) => Coords;
    options?: any;
  };
}

/**
 * Optimizes the visibility of the floating element by shifting it in order to
 * keep it in view when it will overflow the clipping boundary.
 * @see https://floating-ui.com/docs/shift
 */
export const shift = (
  options: ShiftOptions | Derivable<ShiftOptions> = {},
): Middleware => ({
  name: 'shift',
  options,
  async fn(state) {
    const {x, y, placement, platform} = state;

    const {
      mainAxis: checkMainAxis = true,
      crossAxis: checkCrossAxis = false,
      limiter = {fn: ({x, y}: Coords) => ({x, y})},
      ...detectOverflowOptions
    } = evaluate(options, state);

    const coords = {x, y};
    const overflow = await platform.detectOverflow(
      state,
      detectOverflowOptions,
    );
    const crossAxis = getSideAxis(getSide(placement));
    const mainAxis = getOppositeAxis(crossAxis);

    let mainAxisCoord = coords[mainAxis];
    let crossAxisCoord = coords[crossAxis];

    if (checkMainAxis) {
      const minSide = mainAxis === 'y' ? 'top' : 'left';
      const maxSide = mainAxis === 'y' ? 'bottom' : 'right';
      const min = mainAxisCoord + overflow[minSide];
      const max = mainAxisCoord - overflow[maxSide];

      mainAxisCoord = clamp(min, mainAxisCoord, max);
    }

    if (checkCrossAxis) {
      const minSide = crossAxis === 'y' ? 'top' : 'left';
      const maxSide = crossAxis === 'y' ? 'bottom' : 'right';
      const min = crossAxisCoord + overflow[minSide];
      const max = crossAxisCoord - overflow[maxSide];

      crossAxisCoord = clamp(min, crossAxisCoord, max);
    }

    const limitedCoords = limiter.fn({
      ...state,
      [mainAxis]: mainAxisCoord,
      [crossAxis]: crossAxisCoord,
    });

    return {
      ...limitedCoords,
      data: {
        x: limitedCoords.x - x,
        y: limitedCoords.y - y,
        enabled: {
          [mainAxis]: checkMainAxis,
          [crossAxis]: checkCrossAxis,
        },
      },
    };
  },
});

type LimitShiftOffset =
  | number
  | {
      /**
       * Offset the limiting of the axis that runs along the alignment of the
       * floating element.
       */
      mainAxis?: number;
      /**
       * Offset the limiting of the axis that runs along the side of the
       * floating element.
       */
      crossAxis?: number;
    };

export interface LimitShiftOptions {
  /**
   * Offset when limiting starts. `0` will limit when the opposite edges of the
   * reference and floating elements are aligned.
   * - positive = start limiting earlier
   * - negative = start limiting later
   */
  offset?: LimitShiftOffset | Derivable<LimitShiftOffset>;
  /**
   * Whether to limit the axis that runs along the alignment of the floating
   * element.
   */
  mainAxis?: boolean;
  /**
   * Whether to limit the axis that runs along the side of the floating element.
   */
  crossAxis?: boolean;
}

/**
 * Built-in `limiter` that will stop `shift()` at a certain point.
 */
export const limitShift = (
  options: LimitShiftOptions | Derivable<LimitShiftOptions> = {},
): {
  options: any;
  fn: (state: MiddlewareState) => Coords;
} => ({
  options,
  fn(state) {
    const {x, y, placement, rects, middlewareData} = state;

    const {
      offset = 0,
      mainAxis: checkMainAxis = true,
      crossAxis: checkCrossAxis = true,
    } = evaluate(options, state);

    const coords = {x, y};
    const crossAxis = getSideAxis(placement);
    const mainAxis = getOppositeAxis(crossAxis);

    let mainAxisCoord = coords[mainAxis];
    let crossAxisCoord = coords[crossAxis];

    const rawOffset = evaluate(offset, state);
    const computedOffset =
      typeof rawOffset === 'number'
        ? {mainAxis: rawOffset, crossAxis: 0}
        : {mainAxis: 0, crossAxis: 0, ...rawOffset};

    if (checkMainAxis) {
      const len = mainAxis === 'y' ? 'height' : 'width';
      const limitMin =
        rects.reference[mainAxis] -
        rects.floating[len] +
        computedOffset.mainAxis;
      const limitMax =
        rects.reference[mainAxis] +
        rects.reference[len] -
        computedOffset.mainAxis;

      if (mainAxisCoord < limitMin) {
        mainAxisCoord = limitMin;
      } else if (mainAxisCoord > limitMax) {
        mainAxisCoord = limitMax;
      }
    }

    if (checkCrossAxis) {
      const len = mainAxis === 'y' ? 'width' : 'height';
      const isOriginSide = originSides.has(getSide(placement));
      const limitMin =
        rects.reference[crossAxis] -
        rects.floating[len] +
        (isOriginSide ? middlewareData.offset?.[crossAxis] || 0 : 0) +
        (isOriginSide ? 0 : computedOffset.crossAxis);
      const limitMax =
        rects.reference[crossAxis] +
        rects.reference[len] +
        (isOriginSide ? 0 : middlewareData.offset?.[crossAxis] || 0) -
        (isOriginSide ? computedOffset.crossAxis : 0);

      if (crossAxisCoord < limitMin) {
        crossAxisCoord = limitMin;
      } else if (crossAxisCoord > limitMax) {
        crossAxisCoord = limitMax;
      }
    }

    return {
      [mainAxis]: mainAxisCoord,
      [crossAxis]: crossAxisCoord,
    } as Coords;
  },
});

# middleware.ts
import type {
  Coords,
  InlineOptions,
  LimitShiftOptions,
  SideObject,
} from '@floating-ui/core';
import {
  arrow as arrowCore,
  autoPlacement as autoPlacementCore,
  detectOverflow as detectOverflowCore,
  flip as flipCore,
  hide as hideCore,
  inline as inlineCore,
  limitShift as limitShiftCore,
  offset as offsetCore,
  shift as shiftCore,
  size as sizeCore,
} from '@floating-ui/core';

import type {
  ArrowOptions,
  AutoPlacementOptions,
  Derivable,
  DetectOverflowOptions,
  FlipOptions,
  HideOptions,
  Middleware,
  MiddlewareState,
  OffsetOptions,
  ShiftOptions,
  SizeOptions,
} from './types';

/**
 * Resolves with an object of overflow side offsets that determine how much the
 * element is overflowing a given clipping boundary on each side.
 * - positive = overflowing the boundary by that number of pixels
 * - negative = how many pixels left before it will overflow
 * - 0 = lies flush with the boundary
 * @see https://floating-ui.com/docs/detectOverflow
 */
export const detectOverflow: (
  state: MiddlewareState,
  options?: DetectOverflowOptions | Derivable<DetectOverflowOptions>,
) => Promise<SideObject> = detectOverflowCore;

/**
 * Modifies the placement by translating the floating element along the
 * specified axes.
 * A number (shorthand for `mainAxis` or distance), or an axes configuration
 * object may be passed.
 * @see https://floating-ui.com/docs/offset
 */
export const offset: (options?: OffsetOptions) => Middleware = offsetCore;

/**
 * Optimizes the visibility of the floating element by choosing the placement
 * that has the most space available automatically, without needing to specify a
 * preferred placement. Alternative to `flip`.
 * @see https://floating-ui.com/docs/autoPlacement
 */
export const autoPlacement: (
  options?: AutoPlacementOptions | Derivable<AutoPlacementOptions>,
) => Middleware = autoPlacementCore;

/**
 * Optimizes the visibility of the floating element by shifting it in order to
 * keep it in view when it will overflow the clipping boundary.
 * @see https://floating-ui.com/docs/shift
 */
export const shift: (
  options?: ShiftOptions | Derivable<ShiftOptions>,
) => Middleware = shiftCore;

/**
 * Optimizes the visibility of the floating element by flipping the `placement`
 * in order to keep it in view when the preferred placement(s) will overflow the
 * clipping boundary. Alternative to `autoPlacement`.
 * @see https://floating-ui.com/docs/flip
 */
export const flip: (
  options?: FlipOptions | Derivable<FlipOptions>,
) => Middleware = flipCore;

/**
 * Provides data that allows you to change the size of the floating element —
 * for instance, prevent it from overflowing the clipping boundary or match the
 * width of the reference element.
 * @see https://floating-ui.com/docs/size
 */
export const size: (
  options?: SizeOptions | Derivable<SizeOptions>,
) => Middleware = sizeCore;

/**
 * Provides data to hide the floating element in applicable situations, such as
 * when it is not in the same clipping context as the reference element.
 * @see https://floating-ui.com/docs/hide
 */
export const hide: (
  options?: HideOptions | Derivable<HideOptions>,
) => Middleware = hideCore;

/**
 * Provides data to position an inner element of the floating element so that it
 * appears centered to the reference element.
 * @see https://floating-ui.com/docs/arrow
 */
export const arrow: (
  options: ArrowOptions | Derivable<ArrowOptions>,
) => Middleware = arrowCore;

/**
 * Provides improved positioning for inline reference elements that can span
 * over multiple lines, such as hyperlinks or range selections.
 * @see https://floating-ui.com/docs/inline
 */
export const inline: (
  options?: InlineOptions | Derivable<InlineOptions>,
) => Middleware = inlineCore;

/**
 * Built-in `limiter` that will stop `shift()` at a certain point.
 */
export const limitShift: (
  options?: LimitShiftOptions | Derivable<LimitShiftOptions>,
) => {
  options: any;
  fn: (state: MiddlewareState) => Coords;
} = limitShiftCore;