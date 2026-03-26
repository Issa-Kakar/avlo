import React, { useState, useEffect, useRef } from 'react';
import {
  DrawingSettings,
  SizePreset,
  ConnectorSizePreset,
  TEXT_COLOR_PALETTE,
  useDeviceUIStore,
} from '../stores/device-ui-store';
import { getActiveRoomDoc, hasActiveRoom } from '../canvas/room-runtime';
import { openImageFilePicker } from '@/lib/image/image-actions';

import './ToolPanel.css';

// Import icon components from Phase 5
import {
  IconSelect,
  IconPen,
  IconHighlighter,
  IconEraser,
  IconText,
  IconRectangle,
  IconEllipse,
  IconArrow,
  IconDiamond,
  IconCode,
  IconImage,
  IconPan,
  IconStickyNote,
  IconFill,
  IconUndo,
  IconRedo,
} from './icons';

export function ToolPanel() {
  const {
    activeTool,
    drawingSettings,
    setFillEnabled,
    setDrawingSize,
    setConnectorSize,
    shapeVariant,
    recentColors,
    isColorPopoverOpen,
    setActiveTool,
    setDrawingColor,
    addRecentColor,
    setColorPopoverOpen,
    setShapeVariant,
  } = useDeviceUIStore();

  const popoverRef = useRef<HTMLDivElement>(null);

  // Handle size changes based on active tool - route to correct setter
  const handleSizeChange = (size: number) => {
    switch (activeTool) {
      case 'connector':
        setConnectorSize(size as ConnectorSizePreset);
        break;
      default:
        setDrawingSize(size as SizePreset);
    }
  };

  // Determine if inspector should show
  const showInspector = ['pen', 'highlighter', 'text', 'shape', 'connector', 'note'].includes(activeTool);
  const showColors = !['eraser', 'pan', 'image'].includes(activeTool);
  const showSizes = !['pan', 'image'].includes(activeTool);
  const showFillToggle =
    activeTool === 'shape' ||
    activeTool === 'pen' ||
    activeTool === 'highlighter' ||
    activeTool === 'select';

  // Get current settings based on active tool with proper tool-specific overrides
  const getCurrentSettings = () => {
    const store = useDeviceUIStore.getState();
    const base = drawingSettings;

    switch (activeTool) {
      case 'connector':
        return { ...base, size: store.connectorSize };
      case 'highlighter':
        return { ...base, opacity: store.highlighterOpacity };
      default:
        return base;
    }
  };

  const currentSettings = getCurrentSettings();

  // Size presets
  const getSizePresets = () => {
    if (activeTool === 'text' || activeTool === 'note') return []; // Sizes managed in context menu
    if (activeTool === 'connector') return [2, 4, 6, 8];
    return [4, 7, 10, 13];
  };

  const sizePresets = getSizePresets();
  const sizeLabels = ['S', 'M', 'L', 'XL'];

  // Close popover on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setColorPopoverOpen(false);
      }
    };

    if (isColorPopoverOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isColorPopoverOpen, setColorPopoverOpen]);

  return (
    <div className="tool-dock-wrap">
      {/* Main toolbar */}
      <div className="tool-dock">
        {/* Navigation */}
        <ToolButton
          tool="select"
          isActive={activeTool === 'select'}
          onClick={() => setActiveTool('select')}
          tooltip="Select (V)"
        >
          <IconSelect className="icon" />
        </ToolButton>

        <ToolButton
          tool="pan"
          isActive={activeTool === 'pan'}
          onClick={() => setActiveTool('pan')}
          tooltip="Pan (Space)"
        >
          <IconPan className="icon" />
        </ToolButton>

        <div className="tool-divider" />

        <ToolButton
          tool="note"
          isActive={activeTool === 'note'}
          onClick={() => setActiveTool('note')}
          tooltip="Sticky Note (N)"
        >
          <IconStickyNote className="icon" />
        </ToolButton>

        {/* Drawing — no divider, matches Mural compact style */}
        <ToolButton
          tool="pen"
          isActive={activeTool === 'pen'}
          onClick={() => setActiveTool('pen')}
          tooltip="Pen (P)"
        >
          <IconPen className="icon" />
        </ToolButton>

        <ToolButton
          tool="highlighter"
          isActive={activeTool === 'highlighter'}
          onClick={() => setActiveTool('highlighter')}
          tooltip="Highlighter (H)"
        >
          <IconHighlighter className="icon" />
        </ToolButton>

        <ToolButton
          tool="eraser"
          isActive={activeTool === 'eraser'}
          onClick={() => setActiveTool('eraser')}
          tooltip="Eraser (E)"
        >
          <IconEraser className="icon" />
        </ToolButton>

        <ToolButton
          tool="text"
          isActive={activeTool === 'text'}
          onClick={() => setActiveTool('text')}
          tooltip="Text (T)"
        >
          <IconText className="icon" />
        </ToolButton>

        <ToolButton
          tool="connector"
          isActive={activeTool === 'connector'}
          onClick={() => setActiveTool('connector')}
          tooltip="Connector"
        >
          <IconArrow className="icon" />
        </ToolButton>

        <ToolButton
          tool="rectangle"
          isActive={activeTool === 'shape' && shapeVariant === 'rectangle'}
          onClick={() => {
            setActiveTool('shape');
            setShapeVariant('rectangle');
          }}
          tooltip="Rectangle (R)"
        >
          <IconRectangle className="icon" />
        </ToolButton>

        <ToolButton
          tool="diamond"
          isActive={activeTool === 'shape' && shapeVariant === 'diamond'}
          onClick={() => {
            setActiveTool('shape');
            setShapeVariant('diamond');
          }}
          tooltip="Diamond (D)"
        >
          <IconDiamond className="icon" />
        </ToolButton>

        <ToolButton
          tool="ellipse"
          isActive={activeTool === 'shape' && shapeVariant === 'ellipse'}
          onClick={() => {
            setActiveTool('shape');
            setShapeVariant('ellipse');
          }}
          tooltip="Ellipse (O)"
        >
          <IconEllipse className="icon" />
        </ToolButton>

        <ToolButton
          tool="code"
          isActive={activeTool === 'code'}
          onClick={() => setActiveTool('code')}
          tooltip="Code"
        >
          <IconCode className="icon" />
        </ToolButton>

        <ToolButton
          tool="image"
          isActive={false}
          onClick={() => openImageFilePicker()}
          tooltip="Image (I)"
        >
          <IconImage className="icon" />
        </ToolButton>

        {/* Inspector with new color system - moved inside toolbar */}
        {showInspector && (
          <Inspector
            fillEnabled={drawingSettings.fill}
            drawingSettings={drawingSettings}
            showColors={showColors}
            showSizes={showSizes}
            showFillToggle={showFillToggle}
            recentColors={recentColors}
            sizePresets={sizePresets}
            sizeLabels={sizeLabels}
            currentColor={currentSettings.color}
            currentSize={currentSettings.size}
            isColorPopoverOpen={isColorPopoverOpen}
            popoverRef={popoverRef}
            onColorChange={setDrawingColor}
            onSizeChange={handleSizeChange}
            onColorPopoverToggle={() => setColorPopoverOpen(!isColorPopoverOpen)}
            onFillToggle={() => setFillEnabled(!drawingSettings.fill)}
            addRecentColor={(color: string) => addRecentColor(color)}
          />
        )}

        {/* Compact Undo/Redo container - moved inside toolbar */}
        <div className="undo-redo-compact">
          <button
            className="undo-btn"
            aria-label="Undo"
            onClick={() => hasActiveRoom() && getActiveRoomDoc().undo()}
          >
            <IconUndo className="undo-icon" />
          </button>
          <button
            className="redo-btn"
            aria-label="Redo"
            onClick={() => hasActiveRoom() && getActiveRoomDoc().redo()}
          >
            <IconRedo className="redo-icon" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Tool Button Component
interface ToolButtonProps {
  tool: string;
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
}

function ToolButton({ isActive, onClick, tooltip, children }: ToolButtonProps) {
  return (
    <button
      className={`tool-btn ${isActive ? 'active' : ''}`}
      data-tooltip={tooltip}
      onClick={onClick}
      aria-label={tooltip}
    >
      {children}
    </button>
  );
}

// Enhanced Inspector Component with new color system
interface InspectorProps {
  showColors: boolean;
  showSizes: boolean;
  showFillToggle: boolean;
  fillEnabled: DrawingSettings['fill'];
  recentColors: string[];
  sizePresets: number[];
  sizeLabels: string[];
  currentColor: string;
  currentSize: number;
  isColorPopoverOpen: boolean;
  drawingSettings: DrawingSettings;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
  onColorPopoverToggle: () => void;
  onFillToggle: () => void;
  addRecentColor: (color: string) => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
}

function Inspector({
  showColors,
  showSizes,
  showFillToggle,
  fillEnabled,
  recentColors,
  sizePresets,
  sizeLabels,
  currentColor,
  currentSize,
  isColorPopoverOpen,
  onColorChange,
  onSizeChange,
  onColorPopoverToggle,
  onFillToggle,
  addRecentColor,
  popoverRef,
}: InspectorProps) {
  const [hexInput, setHexInput] = useState('#');

  const fixedColors = TEXT_COLOR_PALETTE.slice(0, 8);

  const isCustomColor = (color: string) => {
    return !fixedColors.some((c) => c.toLowerCase() === color?.toLowerCase());
  };

  const handleColorSelect = (color: string, isCustom: boolean) => {
    onColorChange(color);
    if (isCustom) {
      addRecentColor(color);
    }
    onColorPopoverToggle(); // Close popover
  };

  const handleHexSubmit = () => {
    const h = hexInput.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) {
      handleColorSelect(h, true);
      setHexInput('#');
    }
  };

  // More colors for the extended palette
  const moreColors = [
    '#FFFFFF', // White
    '#8B5E3C', // Brown
    '#06B6D4', // Cyan
    '#EC4899', // Pink
    '#84CC16', // Lime
    '#1E3A8A', // Navy
    '#14B8A6', // Teal
    '#0EA5E9', // Sky
    '#A855F7', // Purple
    '#F43F5E', // Rose
    '#F5E7C6', // Sand
    '#374151', // Slate
  ];

  return (
    <div className="inspector">
      {/* REORDERED: Sizes on left, fill in middle, colors on right */}
      {showSizes && sizePresets.length > 1 && (
        <div className="row sizes">
          {sizePresets.map((px, i) => (
            <button
              key={px}
              className={`size-pill ${currentSize === px ? 'active' : ''}`}
              onClick={() => onSizeChange(px)}
              aria-label={`Size ${sizeLabels[i]}`}
            >
              {sizeLabels[i]}
            </button>
          ))}
        </div>
      )}

      {/* Fill toggle button - between sizes and colors */}
      {showFillToggle && (
        <button
          className={`icon-btn ${fillEnabled ? 'on' : ''}`}
          onClick={onFillToggle}
          aria-label="Fill"
          title="Fill"
        >
          <IconFill className="icon" />
        </button>
      )}

      {showColors && (
        <div className="inspector-colors">
          <div className="swatch-row">
            {/* Rainbow circle for more colors - leftmost color, shows custom color dot when selected */}
            <button
              className="swatch swatch-plus"
              onClick={onColorPopoverToggle}
              aria-haspopup="dialog"
              aria-expanded={isColorPopoverOpen}
              aria-label="More colors"
            >
              {/* Show custom color dot overlay when custom color is selected */}
              {isCustomColor(currentColor) && (
                <div className="custom-color-dot" style={{ backgroundColor: currentColor }} />
              )}
            </button>

            {/* Fixed 8 colors - REVERSED ORDER (right to left becomes left to right) */}
            {[...fixedColors].reverse().map((c) => (
              <button
                key={c}
                className={`swatch ${currentColor === c ? 'is-active-fixed' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                onClick={() => onColorChange(c)}
              />
            ))}
          </div>

          {/* Color Popover */}
          {isColorPopoverOpen && (
            <div className="color-popover" role="dialog" aria-modal="true" ref={popoverRef}>
              {/* Recent Colors */}
              {recentColors.length > 0 && (
                <div className="popover-section">
                  <h6>RECENT</h6>
                  <div className="swatch-grid">
                    {recentColors.map((c, i) => (
                      <button
                        key={`recent-${i}`}
                        className="swatch"
                        style={{ backgroundColor: c }}
                        onClick={() => handleColorSelect(c, true)}
                        aria-label={`Recent color ${c}`}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* More Colors */}
              <div className="popover-section">
                <h6>MORE</h6>
                <div className="swatch-grid">
                  {moreColors.map((c) => (
                    <button
                      key={c}
                      className="swatch"
                      style={{ backgroundColor: c }}
                      onClick={() => handleColorSelect(c, true)}
                      aria-label={`Color ${c}`}
                    />
                  ))}
                </div>
              </div>

              {/* Hex Input */}
              <div className="popover-section">
                <h6>HEX CODE</h6>
                <div className="hex-row">
                  <input
                    type="text"
                    value={hexInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHexInput(v.startsWith('#') ? v : '#' + v);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && handleHexSubmit()}
                    placeholder="#"
                    aria-label="Hex code"
                  />
                  <button className="hex-apply" onClick={handleHexSubmit} aria-label="Apply hex">
                    ↵
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
