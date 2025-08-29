import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef, useEffect } from 'react';
import { CanvasStage, type CanvasStageHandle } from '../CanvasStage';

describe('CanvasStage', () => {
  // Mock ResizeObserver locally (not globally)
  beforeEach(() => {
    // Mock matchMedia for DPR change listener
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    global.ResizeObserver = vi.fn().mockImplementation((callback) => ({
      observe: vi.fn((element) => {
        // Simulate a resize immediately
        callback([
          {
            target: element,
            contentRect: { width: 800, height: 600 },
          },
        ]);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    // Mock canvas getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      imageSmoothingEnabled: true,
      lineCap: 'round',
      lineJoin: 'round',
    });
  });

  it('creates canvas element and gets 2D context', () => {
    const { container } = render(<CanvasStage />);
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', {
      willReadFrequently: false,
    });
  });

  it('exposes clear and withContext methods through ref', () => {
    // Create a wrapper component to test the ref
    const TestWrapper = () => {
      const ref = useRef<CanvasStageHandle>(null);

      // Check ref after mount
      useEffect(() => {
        expect(ref.current).toBeTruthy();
        expect(ref.current?.clear).toBeDefined();
        expect(ref.current?.withContext).toBeDefined();
      }, []);

      return <CanvasStage ref={ref} />;
    };

    const { container } = render(<TestWrapper />);
    expect(container.querySelector('canvas')).toBeTruthy();
  });

  it('cleans up on unmount', () => {
    const { unmount } = render(<CanvasStage />);

    // Get the ResizeObserver instance
    const resizeObserverInstance = (ResizeObserver as any).mock.results[0].value;
    const mockDisconnect = vi.fn();
    resizeObserverInstance.disconnect = mockDisconnect;

    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('calls onResize callback when resizing', () => {
    const onResizeSpy = vi.fn();

    // Override ResizeObserver for this test
    global.ResizeObserver = vi.fn().mockImplementation((callback) => ({
      observe: vi.fn((element) => {
        // Simulate a resize
        callback([
          {
            target: element,
            contentRect: { width: 1024, height: 768 },
          },
        ]);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    render(<CanvasStage onResize={onResizeSpy} />);

    expect(onResizeSpy).toHaveBeenCalledWith({
      cssWidth: 1024,
      cssHeight: 768,
      dpr: 1, // jsdom defaults to 1
      pixelWidth: 1024,
      pixelHeight: 768,
    });
  });
});
