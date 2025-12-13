import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Canvas } from '../Canvas';
import { RoomDocRegistryProvider } from '../../lib/room-doc-registry-context';
import { createTestManager } from '../../lib/__tests__/test-helpers';
import { useCameraStore } from '@/stores/camera-store';

describe('Canvas with Transforms', () => {
  let testContext: ReturnType<typeof createTestManager>;

  beforeEach(() => {
    testContext = createTestManager('test-room');

    // Reset camera store to initial state before each test
    useCameraStore.setState({
      scale: 1,
      pan: { x: 0, y: 0 },
      cssWidth: 800,
      cssHeight: 600,
      dpr: 1,
    });

    // Mock ResizeObserver
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

  it('renders canvas elements', () => {
    const { container } = render(
      <RoomDocRegistryProvider registry={testContext.registry}>
        <Canvas roomId="test-room" />
      </RoomDocRegistryProvider>,
    );

    // Should have two canvas elements (base + overlay)
    const canvases = container.querySelectorAll('canvas');
    expect(canvases.length).toBe(2);
  });

  it('renders editor host div', () => {
    const { container } = render(
      <RoomDocRegistryProvider registry={testContext.registry}>
        <Canvas roomId="test-room" />
      </RoomDocRegistryProvider>,
    );

    const editorHost = container.querySelector('.dom-overlay-root');
    expect(editorHost).toBeTruthy();
  });

  it('maintains identity transform initially in snapshot', () => {
    // The snapshot from RoomDocManager should have identity transform
    const snapshot = testContext.manager.currentSnapshot;
    expect(snapshot.view.scale).toBe(1);
    expect(snapshot.view.pan).toEqual({ x: 0, y: 0 });

    // Test the transform functions
    const [x, y] = snapshot.view.worldToCanvas(100, 200);
    expect(x).toBe(100);
    expect(y).toBe(200);
  });

  it('camera store has correct initial state', () => {
    const state = useCameraStore.getState();
    expect(state.scale).toBe(1);
    expect(state.pan).toEqual({ x: 0, y: 0 });
    expect(state.cssWidth).toBe(800);
    expect(state.cssHeight).toBe(600);
  });
});
