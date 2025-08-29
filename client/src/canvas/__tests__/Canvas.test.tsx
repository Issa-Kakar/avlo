import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Canvas } from '../Canvas';
import { ViewTransformProvider } from '../ViewTransformContext';
import { RoomDocRegistryProvider } from '../../lib/room-doc-registry-context';
import { createTestManager } from '../../lib/__tests__/test-helpers';

describe('Canvas with Transforms', () => {
  let testContext: ReturnType<typeof createTestManager>;

  beforeEach(() => {
    testContext = createTestManager('test-room');

    // Note: ResizeObserver is mocked locally in CanvasStage tests
    // This is better than global mocking as it provides test isolation
    // If needed here, mock it the same way:
    global.ResizeObserver = vi.fn().mockImplementation((_callback) => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    // Mock matchMedia for DPR handling
    global.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    testContext.cleanup();
  });

  it('renders canvas element with transform context', () => {
    const { container } = render(
      <RoomDocRegistryProvider registry={testContext.registry}>
        <ViewTransformProvider>
          <Canvas roomId="test-room" />
        </ViewTransformProvider>
      </RoomDocRegistryProvider>,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
  });

  it('maintains identity transform initially', () => {
    // The snapshot from RoomDocManager should have identity transform
    const snapshot = testContext.manager.currentSnapshot;
    expect(snapshot.view.scale).toBe(1);
    expect(snapshot.view.pan).toEqual({ x: 0, y: 0 });

    // Test the transform functions
    const [x, y] = snapshot.view.worldToCanvas(100, 200);
    expect(x).toBe(100);
    expect(y).toBe(200);
  });
});
