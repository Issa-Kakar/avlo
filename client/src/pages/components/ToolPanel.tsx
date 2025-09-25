import React, { useRef, useState, useEffect } from 'react';
import { useDeviceUIStore, Tool } from '../../stores/device-ui-store';

interface ToolPanelProps {
  onToast?: (message: string) => void;
}

interface ToolButtonProps {
  tool: Tool;
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
}

function ToolButton({ tool, isActive, onClick, tooltip, children }: ToolButtonProps) {
  return (
    <button
      className={`tool-btn ${isActive ? 'active' : ''}`}
      data-tool={tool}
      data-tooltip={tooltip}
      onClick={onClick}
      aria-label={tooltip}
    >
      {children}
    </button>
  );
}

export function ToolPanel({ onToast }: ToolPanelProps) {
  const {
    activeTool,
    toolbarPos,
    editorCollapsed,
    stamp,
    setActiveTool,
    setToolbarPosition,
    setStampSettings,
  } = useDeviceUIStore();

  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });

  const startDrag = (clientX: number, clientY: number) => {
    setIsDragging(true);
    isDraggingRef.current = true;
    dragStartRef.current = { x: clientX - toolbarPos.x, y: clientY - toolbarPos.y };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  };

  const updatePosition = (clientX: number, clientY: number) => {
    if (!isDraggingRef.current) return;

    const newX = clientX - dragStartRef.current.x;
    const newY = clientY - dragStartRef.current.y;

    // Get dynamic bounds based on actual layout
    const headerHeight = 56; // Header is 56px tall

    // Get actual toolbar dimensions
    const toolbarElement = toolbarRef.current;
    const toolbarWidth = toolbarElement?.offsetWidth || 62;
    const toolbarHeight = toolbarElement?.offsetHeight || 446;

    // Determine right boundary using actual editor panel position
    const editorElement = document.querySelector('.editor-panel') as HTMLElement | null;
    const editorLeft =
      !editorCollapsed && editorElement
        ? editorElement.getBoundingClientRect().left
        : window.innerWidth;

    // Set bounds with proper margins
    const leftMargin = 20;
    const topMargin = headerHeight + 24; // Header + extra margin (slightly more)
    const rightMargin = 20; // Same as left margin
    const bottomMargin = 20;

    // Max X is up to the editor panel's left edge
    const maxX = editorLeft - rightMargin - toolbarWidth;

    const boundedX = Math.max(leftMargin, Math.min(newX, maxX));
    const boundedY = Math.max(
      topMargin,
      Math.min(newY, window.innerHeight - bottomMargin - toolbarHeight),
    );

    setToolbarPosition({ x: boundedX, y: boundedY });
  };

  const endDrag = () => {
    setIsDragging(false);
    isDraggingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target !== dragHandleRef.current) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  };

  const handleMouseMove = (e: MouseEvent) => {
    updatePosition(e.clientX, e.clientY);
  };

  const handleMouseUp = () => {
    endDrag();
  };

  const handlePointerMove = (e: PointerEvent) => {
    updatePosition(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    endDrag();
  };

  // Ensure initial position respects bounds
  useEffect(() => {
    const headerHeight = 56;
    const toolbarWidth = 62;
    const editorElement = document.querySelector('.editor-panel') as HTMLElement | null;
    const editorLeft =
      !editorCollapsed && editorElement
        ? editorElement.getBoundingClientRect().left
        : window.innerWidth;
    const _leftMargin = 20;
    const topMargin = headerHeight + 24;
    const rightMargin = 20;

    const maxX = editorLeft - rightMargin - toolbarWidth;
    const minY = topMargin;

    // Check if current position is out of bounds and adjust if needed
    if (toolbarPos.x > maxX || toolbarPos.y < minY) {
      setToolbarPosition({
        x: Math.min(toolbarPos.x, maxX),
        y: Math.max(toolbarPos.y, minY),
      });
    }
  }, [editorCollapsed, toolbarPos, setToolbarPosition]);

  const handleToolClick = (tool: Tool) => {
    if (tool === 'pen' || tool === 'highlighter') {
      setActiveTool(tool);
    } else if (tool === 'eraser' || tool === 'text' || tool === 'stamp' || tool === 'pan') {
      setActiveTool(tool);
      onToast?.(`${tool.charAt(0).toUpperCase() + tool.slice(1)} selected`);
    }
  };

  const handleUndoRedo = (action: 'undo' | 'redo') => {
    onToast?.(action.toUpperCase());
  };

  return (
    <div
      ref={toolbarRef}
      className="tool-panel"
      style={{
        left: toolbarPos.x,
        top: toolbarPos.y,
        cursor: isDragging ? 'grabbing' : 'default',
      }}
      onMouseDown={handleMouseDown}
    >
      {/* Drag Handle */}
      <div
        ref={dragHandleRef}
        className="drag-handle"
        aria-label="Move toolbar"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      />

      {/* Drawing Tools */}
      <ToolButton
        tool="pen"
        isActive={activeTool === 'pen'}
        onClick={() => handleToolClick('pen')}
        tooltip="Pen (P)"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
          <path d="M2 2l7.586 7.586" />
        </svg>
      </ToolButton>

      <ToolButton
        tool="highlighter"
        isActive={activeTool === 'highlighter'}
        onClick={() => handleToolClick('highlighter')}
        tooltip="Highlighter (H)"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="m9 11-6 6v3h9l3-3" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
        </svg>
      </ToolButton>

      <ToolButton
        tool="eraser"
        isActive={activeTool === 'eraser'}
        onClick={() => handleToolClick('eraser')}
        tooltip="Eraser (E)"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
          <path d="M22 21H7" />
        </svg>
      </ToolButton>

      <ToolButton
        tool="text"
        isActive={activeTool === 'text'}
        onClick={() => handleToolClick('text')}
        tooltip="Text (T)"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M4 7V4h16v3M9 20h6M12 4v16" />
        </svg>
      </ToolButton>

      <div className="tool-divider" />

      {/* Stamps Tools */}
      <ToolButton
        tool="stamp"
        isActive={activeTool === 'stamp'}
        onClick={() => handleToolClick('stamp')}
        tooltip="Stamps (V)"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          className="lucide lucide-shapes-icon lucide-shapes"
        >
          <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <circle cx="17.5" cy="17.5" r="3.5" />
        </svg>
      </ToolButton>

      <ToolButton
        tool="pan"
        isActive={activeTool === 'pan'}
        onClick={() => handleToolClick('pan')}
        tooltip="Pan (Space)"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M3 12h18M12 3v18" />
        </svg>
      </ToolButton>

      <div className="tool-divider" />

      {/* Undo/Redo */}
      <button
        className="tool-btn"
        data-tooltip="Undo (⌘Z)"
        onClick={() => handleUndoRedo('undo')}
        aria-label="Undo"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
        </svg>
      </button>

      <button
        className="tool-btn"
        data-tooltip="Redo (⌘Y)"
        onClick={() => handleUndoRedo('redo')}
        aria-label="Redo"
      >
        <svg className="icon" viewBox="0 0 24 24">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" />
        </svg>
      </button>

      {/* Tool Settings Panels */}

      {activeTool === 'stamp' && (
        <div className="tool-settings">
          <div className="tool-divider" />
          <div className="stamp-picker">
            {['circle', 'square', 'triangle', 'star', 'heart'].map((shape) => (
              <button
                key={shape}
                className={`stamp-btn ${stamp.selected === shape ? 'active' : ''}`}
                onClick={() => setStampSettings({ selected: shape as any })}
                aria-label={`Select ${shape} stamp`}
              >
                {shape === 'circle' && '○'}
                {shape === 'square' && '□'}
                {shape === 'triangle' && '△'}
                {shape === 'star' && '☆'}
                {shape === 'heart' && '♡'}
              </button>
            ))}
          </div>
          <label className="setting-row">
            <span className="setting-label">Size</span>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={stamp.scale}
              onChange={(e) => setStampSettings({ scale: Number(e.target.value) })}
              className="setting-slider"
            />
            <span className="setting-value">{(stamp.scale * 100).toFixed(0)}%</span>
          </label>
        </div>
      )}
    </div>
  );
}
