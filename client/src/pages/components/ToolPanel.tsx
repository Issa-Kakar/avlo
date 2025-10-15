import React, { useState, useEffect, useRef } from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';

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
  IconLine,
  IconImage,
  IconPan,
  IconFill,
} from '../icons';

interface ToolPanelProps {
  onToast?: (message: string) => void;
}

export function ToolPanel({ onToast }: ToolPanelProps) {
  const {
    activeTool,
    pen,
    highlighter,
    eraser,
    text,
    shape,
    fixedColors,
    recentColors,
    isColorPopoverOpen,
    fillEnabledUI,
    setActiveTool,
    setShapeSettings,
    setCurrentToolSize,
    setCurrentToolColor,
    addRecentColor,
    setColorPopoverOpen,
    setFillEnabledUI,
  } = useDeviceUIStore();

  const popoverRef = useRef<HTMLDivElement>(null);

  // Determine if inspector should show
  const showInspector = ['pen', 'highlighter', 'text', 'select', 'shape', 'eraser'].includes(
    activeTool,
  );
  const showColors = !['eraser', 'pan', 'image'].includes(activeTool);
  const showSizes = !['pan', 'image'].includes(activeTool);
  const showFillToggle =
    activeTool === 'shape' || activeTool === 'pen' || activeTool === 'highlighter';

  // Get current settings based on active tool
  const getCurrentSettings = () => {
    switch (activeTool) {
      case 'pen':
        return pen;
      case 'highlighter':
        return highlighter;
      case 'eraser':
        return { ...eraser, color: '#000000' }; // Add dummy color for eraser
      case 'text':
        return text;
      case 'shape':
        return shape.settings;
      default:
        return pen;
    }
  };

  const currentSettings = getCurrentSettings();

  // Size presets
  const getSizePresets = () => {
    if (activeTool === 'text') return [20, 30, 40, 50];
    return [10, 14, 18, 22]; // Same for pen, highlighter, eraser, shapes
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
        {/* Tools in order: Select, Pen, Highlighter, Eraser, Text, Rectangle, Ellipse, Arrow, Line, Image, Pan */}
        <ToolButton
          tool="select"
          isActive={activeTool === 'select'}
          onClick={() => setActiveTool('select')}
          tooltip="Select (V)"
        >
          <IconSelect className="icon" />
        </ToolButton>

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

        <div className="tool-divider" />

        {/* Shape tools - CRITICAL: Set both activeTool='shape' AND the variant */}
        <ToolButton
          tool="rectangle"
          isActive={activeTool === 'shape' && shape.variant === 'rectangle'}
          onClick={() => {
            setActiveTool('shape');
            setShapeSettings({ variant: 'rectangle' });
          }}
          tooltip="Rectangle (R)"
        >
          <IconRectangle className="icon" />
        </ToolButton>

        <ToolButton
          tool="ellipse"
          isActive={activeTool === 'shape' && shape.variant === 'ellipse'}
          onClick={() => {
            setActiveTool('shape');
            setShapeSettings({ variant: 'ellipse' });
          }}
          tooltip="Ellipse (O)"
        >
          <IconEllipse className="icon" />
        </ToolButton>

        <ToolButton
          tool="arrow"
          isActive={activeTool === 'shape' && shape.variant === 'arrow'}
          onClick={() => {
            setActiveTool('shape');
            setShapeSettings({ variant: 'arrow' });
          }}
          tooltip="Arrow (A)"
        >
          <IconArrow className="icon" />
        </ToolButton>

        <ToolButton
          tool="line"
          isActive={activeTool === 'shape' && shape.variant === 'line'}
          onClick={() => {
            setActiveTool('shape');
            setShapeSettings({ variant: 'line' });
          }}
          tooltip="Line (L)"
        >
          <IconLine className="icon" />
        </ToolButton>

        <div className="tool-divider" />

        <ToolButton
          tool="image"
          isActive={activeTool === 'image'}
          onClick={() => {
            setActiveTool('image');
            onToast?.('Image tool coming soon!');
          }}
          tooltip="Image (I)"
        >
          <IconImage className="icon" />
        </ToolButton>

        <ToolButton
          tool="pan"
          isActive={activeTool === 'pan'}
          onClick={() => setActiveTool('pan')}
          tooltip="Pan (Space)"
        >
          <IconPan className="icon" />
        </ToolButton>
      </div>

      {/* Inspector with new color system */}
      {showInspector && (
        <Inspector
          showColors={showColors}
          showSizes={showSizes}
          showFillToggle={showFillToggle}
          fixedColors={fixedColors}
          recentColors={recentColors}
          sizePresets={sizePresets}
          sizeLabels={sizeLabels}
          currentColor={currentSettings.color}
          currentSize={currentSettings.size}
          isColorPopoverOpen={isColorPopoverOpen}
          fillEnabledUI={fillEnabledUI}
          onColorChange={setCurrentToolColor}
          onSizeChange={setCurrentToolSize}
          onColorPopoverToggle={() => setColorPopoverOpen(!isColorPopoverOpen)}
          onFillToggle={() => setFillEnabledUI(!fillEnabledUI)}
          addRecentColor={addRecentColor}
          popoverRef={popoverRef}
        />
      )}

      {/* Undo/Redo micro buttons - positioned after inspector */}
      <div className="undo-redo-inline">
        <button className="micro-ghost" aria-label="Undo" onClick={() => onToast?.('UNDO')}>
          <svg viewBox="0 0 24 24" className="micro-icon">
            <path
              d="M9 5l-5 5 5 5M20 12H5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button className="micro-ghost" aria-label="Redo" onClick={() => onToast?.('REDO')}>
          <svg viewBox="0 0 24 24" className="micro-icon">
            <path
              d="M15 5l5 5-5 5M4 12h15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
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
  fixedColors: string[];
  recentColors: string[];
  sizePresets: number[];
  sizeLabels: string[];
  currentColor: string;
  currentSize: number;
  isColorPopoverOpen: boolean;
  fillEnabledUI: boolean;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
  onColorPopoverToggle: () => void;
  onFillToggle: () => void;
  addRecentColor: (color: string) => void;
  popoverRef: React.RefObject<HTMLDivElement>;
}

function Inspector({
  showColors,
  showSizes,
  showFillToggle,
  fixedColors,
  recentColors,
  sizePresets,
  sizeLabels,
  currentColor,
  currentSize,
  isColorPopoverOpen,
  fillEnabledUI,
  onColorChange,
  onSizeChange,
  onColorPopoverToggle,
  onFillToggle,
  addRecentColor,
  popoverRef,
}: InspectorProps) {
  const [hexInput, setHexInput] = useState('#');

  const isCustomColor = (color: string) => {
    return !fixedColors.map((c) => c.toLowerCase()).includes(color?.toLowerCase());
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
      {showColors && (
        <div className="inspector-colors">
          <div className="swatch-row">
            {/* Fixed 8 colors */}
            {fixedColors.map((c) => (
              <button
                key={c}
                className={`swatch ${currentColor === c ? 'is-active-fixed' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                onClick={() => onColorChange(c)}
              />
            ))}

            {/* "+" button for more colors */}
            <button
              className={`swatch swatch-plus ${isCustomColor(currentColor) ? 'custom-outline' : ''}`}
              style={isCustomColor(currentColor) ? { borderColor: currentColor } : {}}
              onClick={onColorPopoverToggle}
              aria-haspopup="dialog"
              aria-expanded={isColorPopoverOpen}
              aria-label="More colors"
            >
              <span>+</span>
            </button>

            {/* Fill toggle button */}
            {showFillToggle && (
              <button
                className={`icon-btn ${fillEnabledUI ? 'on' : ''}`}
                onClick={onFillToggle}
                aria-label="Fill"
                title="Fill"
              >
                <IconFill className="icon" />
              </button>
            )}
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
    </div>
  );
}
