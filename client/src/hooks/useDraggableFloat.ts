import { useRef, useCallback, useEffect } from 'react';

interface DraggableOptions {
  containerSelector: string;
  onPositionChange?: (position: { x: number; y: number }) => void;
  initialPosition?: { x: number; y: number };
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

interface DraggableState {
  isDragging: boolean;
  startPos: { x: number; y: number };
  nodePos: { x: number; y: number };
}

/**
 * High-performance draggable hook using transform3d and RAF throttling
 * Prevents React re-renders during drag for smooth 60fps movement
 */
export function useDraggableFloat({
  containerSelector,
  onPositionChange,
  initialPosition = { x: 24, y: 24 },
  bounds,
}: DraggableOptions) {
  const nodeRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLElement>(null);
  const stateRef = useRef<DraggableState>({
    isDragging: false,
    startPos: { x: 0, y: 0 },
    nodePos: initialPosition,
  });
  const rafRef = useRef<number | null>(null);

  // Apply transform without triggering React renders
  const applyTransform = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;

    const { x, y } = stateRef.current.nodePos;
    node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }, []);

  // Get container bounds for movement constraints
  const getContainerBounds = useCallback(() => {
    if (bounds) return bounds;

    const container = document.querySelector(containerSelector) as HTMLElement;
    const node = nodeRef.current;
    if (!container || !node) return null;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();

    // Calculate bounds relative to the container's coordinate space
    // The toolbar should stay within the canvas with proper margins
    const margin = 20;

    return {
      minX: margin,
      minY: margin,
      maxX: containerRect.width - nodeRect.width - margin,
      maxY: containerRect.height - nodeRect.height - margin,
    };
  }, [containerSelector, bounds]);

  // Initialize position
  useEffect(() => {
    stateRef.current.nodePos = initialPosition;
    applyTransform();
  }, [initialPosition, applyTransform]);

  // Constrain position to bounds
  const constrainPosition = useCallback(
    (pos: { x: number; y: number }) => {
      const containerBounds = getContainerBounds();
      if (!containerBounds) return pos;

      const constrained = {
        x: Math.max(containerBounds.minX, Math.min(containerBounds.maxX, pos.x)),
        y: Math.max(containerBounds.minY, Math.min(containerBounds.maxY, pos.y)),
      };

      return constrained;
    },
    [getContainerBounds],
  );

  // Handle pointer move with RAF throttling
  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!stateRef.current.isDragging) return;

      event.preventDefault();

      const { startPos, nodePos: initialNodePos } = stateRef.current;

      // Calculate delta in screen coordinates
      const deltaX = event.clientX - startPos.x;
      const deltaY = event.clientY - startPos.y;

      // Apply delta directly to initial position (1:1 movement)
      const newPos = constrainPosition({
        x: initialNodePos.x + deltaX,
        y: initialNodePos.y + deltaY,
      });

      stateRef.current.nodePos = newPos;

      // RAF throttling - only schedule one update per frame
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          applyTransform();
        });
      }
    },
    [constrainPosition, applyTransform],
  );

  // Handle pointer up - commit position
  const handlePointerUp = useCallback(() => {
    stateRef.current.isDragging = false;

    // Clean up event listeners
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);

    // Notify position change for persistence
    onPositionChange?.(stateRef.current.nodePos);

    // Update cursor
    const handle = handleRef.current;
    if (handle) {
      handle.style.cursor = 'grab';
    }
  }, [handlePointerMove, onPositionChange]);

  // Handle pointer down - start drag
  const handlePointerDown = useCallback(
    (event: PointerEvent) => {
      event.preventDefault();

      const handle = handleRef.current;
      const node = nodeRef.current;
      if (!handle || !node || event.target !== handle) return;

      // Set pointer capture for better touch/pen support
      if (handle.setPointerCapture) {
        handle.setPointerCapture(event.pointerId);
      }

      // Get current node position from its bounding rect and container
      const container = document.querySelector(containerSelector) as HTMLElement;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();

      // Calculate current position relative to container
      const currentX = nodeRect.x - containerRect.x;
      const currentY = nodeRect.y - containerRect.y;

      // Initialize drag state with current actual position
      stateRef.current.isDragging = true;
      stateRef.current.startPos = { x: event.clientX, y: event.clientY };
      stateRef.current.nodePos = { x: currentX, y: currentY };

      // Add global event listeners
      window.addEventListener('pointermove', handlePointerMove, { passive: false });
      window.addEventListener('pointerup', handlePointerUp, { once: true });

      // Update cursor
      handle.style.cursor = 'grabbing';
    },
    [handlePointerMove, handlePointerUp, containerSelector],
  );

  // Handle resize - reapply constraints
  const handleResize = useCallback(() => {
    const constrainedPos = constrainPosition(stateRef.current.nodePos);
    stateRef.current.nodePos = constrainedPos;
    applyTransform();
    onPositionChange?.(constrainedPos);
  }, [constrainPosition, applyTransform, onPositionChange]);

  // Set up event listeners
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    handle.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleResize);

    // Set initial cursor
    handle.style.cursor = 'grab';

    return () => {
      handle.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);

      // Cancel any pending RAF
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [handlePointerDown, handleResize, handlePointerMove, handlePointerUp]);

  return {
    nodeRef,
    handleRef,
    isDragging: stateRef.current.isDragging,
  };
}
