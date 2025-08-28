import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { ViewTransform } from '@avlo/shared';
import { PERFORMANCE_CONFIG } from '@avlo/shared';

// Transform state
interface ViewState {
  scale: number; // 1.0 = 100% zoom
  pan: { x: number; y: number }; // World offset (in world units)
}

// Context interface
interface ViewTransformContextValue {
  viewState: ViewState;
  transform: ViewTransform;
  setScale: (scale: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetView: () => void;
}

// Default view state
const DEFAULT_VIEW: ViewState = {
  scale: 1,
  pan: { x: 0, y: 0 },
};

const ViewTransformContext = createContext<ViewTransformContextValue | null>(null);

export function ViewTransformProvider({ children }: { children: React.ReactNode }) {
  const [viewState, setViewState] = useState<ViewState>(DEFAULT_VIEW);

  // Create ViewTransform object with proper world units handling
  const transform = useMemo<ViewTransform>(
    () => ({
      worldToCanvas: (x: number, y: number): [number, number] => {
        // Transform from world to canvas: subtract pan (world offset) then scale
        return [(x - viewState.pan.x) * viewState.scale, (y - viewState.pan.y) * viewState.scale];
      },
      canvasToWorld: (x: number, y: number): [number, number] => {
        // Inverse: divide by scale then add pan (world offset)
        // Guard against zero scale
        const s = Math.max(1e-6, viewState.scale);
        return [x / s + viewState.pan.x, y / s + viewState.pan.y];
      },
      scale: viewState.scale,
      pan: viewState.pan,
    }),
    [viewState.scale, viewState.pan],
  );

  const setScale = useCallback((scale: number) => {
    const clampedScale = Math.max(
      PERFORMANCE_CONFIG.MIN_ZOOM,
      Math.min(PERFORMANCE_CONFIG.MAX_ZOOM, scale),
    );
    setViewState((prev) => ({ ...prev, scale: clampedScale }));
  }, []);

  const setPan = useCallback((pan: { x: number; y: number }) => {
    setViewState((prev) => ({ ...prev, pan }));
  }, []);

  const resetView = useCallback(() => {
    setViewState(DEFAULT_VIEW);
  }, []);

  const value = useMemo(
    () => ({
      viewState,
      transform,
      setScale,
      setPan,
      resetView,
    }),
    [viewState, transform, setScale, setPan, resetView],
  );

  return <ViewTransformContext.Provider value={value}>{children}</ViewTransformContext.Provider>;
}

export function useViewTransform() {
  const context = useContext(ViewTransformContext);
  if (!context) {
    throw new Error('useViewTransform must be used within ViewTransformProvider');
  }
  return context;
}
