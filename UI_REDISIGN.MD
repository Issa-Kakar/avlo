# AVLO UI Redesign Implementation Guide

## CRITICAL FIXES APPLIED (2025-10-15)

### Issues Fixed:

1. **Eraser Size System**: Fixed to use SizePreset (10, 14, 18, 22px) instead of fixed 10px
2. **TypeScript Imports**: Removed unused `Tool` and `ShapeVariant` imports from ToolPanel
3. **CSS Conflicts**: Commented out old `.tool-dock` styles that conflicted with new toolbar
4. **Inspector Spacing**: Added 8px margin to separate from toolbar
5. **Undo/Redo Positioning**: Changed from fixed overlay to inline flow (right of inspector)

### Key Changes:

- Eraser now has selectable sizes like other tools
- ToolPanel simplified imports, no longer exports types
- CSS properly isolates old vs new toolbar styles
- Undo/redo buttons flow inline with `.undo-redo-inline` class

## Overview

Complete UI overhaul focusing on:

- **No header** - Remove the entire Header component
- **48px fixed top toolbar** with Inspector extension (increased from 30px for better usability)
- **New color scheme** - Charcoal (#2D2D2D) Toolbar background, Matcha (#74A12E) selection state
- **Updated ink palette** - Soft black (#262626), Yellow (#EAB308), Green (#22C55E), Gray (#6B7280)
- **8 fixed colors + "+" popover** - Fixed palette with Recent/More/Hex color picker in single panel
- **Fill toggle** - UI-only control for shapes (lighter shade of stroke color)
- **Simplified size system** - S/M/L/XL instead of sliders
- **Top-left micro cluster** - Kebab, trash, users, invite (12px offset)
- **Tool reorganization** - Specific order: Select, Pen, Highlighter, Eraser, Text, Rectangle, Ellipse, Arrow, Line, Image, Pan
- **Editor Panel** - Removed from UI but state kept dormant in Zustand for future code editor

## Phase 1: Zustand Store Updates

### 1.1 Update Tool Settings (Keep existing Tool type and shape mechanism)

**File:** `/client/src/stores/device-ui-store.ts`

**IMPORTANT**: Keep the existing `Tool` type and `shape` object with variants as they are. The shape tool implementation is already perfect. We're only updating the size system and adding helper methods.

```typescript
// KEEP EXISTING:
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'pan' | 'select' | 'shape';
export type ShapeVariant = 'line' | 'rectangle' | 'ellipse' | 'arrow';

interface DeviceUIState {
  activeTool: Tool;

  // Update size values to use new system (but keep structure)
  pen: { size: 10 | 14 | 18 | 22; color: string; opacity?: number; };
  highlighter: { size: 10 | 14 | 18 | 22; color: string; opacity?: number; };
  eraser: { size: 10 | 14 | 18 | 22; }; // Now uses SizePreset like other tools
  text: { size: 20 | 30 | 40 | 50; color: string; };

  // KEEP THE SHAPE OBJECT WITH VARIANT - DON'T CHANGE THIS
  shape: {
    variant: ShapeVariant;
    settings: { size: 10 | 14 | 18 | 22; color: string; opacity?: number; };
  };

  select: { enabled: boolean; };

  // Add placeholder for image tool (UI only)
  image: { enabled: boolean; };

  // Keep editor state for future code editor (dormant for now)
  editorCollapsed: boolean;

  // Remove toolbarPos - toolbar is fixed now

  // New color system fields
  fixedColors: string[];        // 8 fixed palette colors
  recentColors: string[];       // last 5 custom colors, excludes fixed
  isColorPopoverOpen: boolean;  // "+" popover state

  // Fill UI state (shapes only)
  fillEnabledUI: boolean;       // UI-only toggle state

  // Keep existing actions
  setActiveTool: (tool: Tool) => void;
  toggleEditor: () => void; // Keep for future code editor
  setPenSettings: (settings: Partial<ToolSettings>) => void;
  setHighlighterSettings: (settings: Partial<ToolSettings>) => void;
  setEraserSize: (size: number) => void;
  setTextSettings: (settings: Partial<{ size: number; color: string }>) => void;
  setShapeSettings: (settings: Partial<{ variant: ShapeVariant } & ToolSettings>) => void;
  setSelectSettings: (settings: Partial<DeviceUIState['select']>) => void;

  // Add generic helpers for inspector
  setCurrentToolSize: (size: number | string) => void;
  setCurrentToolColor: (color: string) => void;

  // New color system actions
  addRecentColor: (hex: string) => void;
  setColorPopoverOpen: (open: boolean) => void;
  setFillEnabledUI: (enabled: boolean) => void;
}

// Default values - update with new palette
activeTool: 'pen',
pen: { size: 10, color: '#262626' }, // Updated ink color
highlighter: { size: 14, color: '#EAB308', opacity: 0.45 }, // Updated to yellow, M size default
eraser: { size: 14 }, // M size default
text: { size: 30, color: '#262626' }, // Updated ink color
shape: {
  variant: 'rectangle',
  settings: { size: 10, color: '#262626' } // Updated ink color
},
select: { enabled: false },
image: { enabled: false }, // New placeholder
editorCollapsed: false, // Keep for future code editor

// New color system defaults
fixedColors: [
  '#262626', // Soft black (ink)
  '#EF4444', // Red
  '#F97316', // Orange
  '#EAB308', // Yellow
  '#22C55E', // Green
  '#3B82F6', // Blue
  '#8B5CF6', // Violet
  '#6B7280', // Gray
],
recentColors: [],
isColorPopoverOpen: false,
fillEnabledUI: false,
```

### 1.2 Add Current Tool Helper Methods and Color System Actions

Add these helper methods to the store for the Inspector to use:

```typescript
setCurrentToolSize: (size) => set((state) => {
  const t = state.activeTool;

  // Convert S/M/L/XL to pixel values
  let mappedSize = size;
  if (typeof size === 'string') {
    const sizeMap: Record<string, number> = {
      'S': t === 'text' ? 20 : 10,
      'M': t === 'text' ? 30 : 14,
      'L': t === 'text' ? 40 : 18,
      'XL': t === 'text' ? 50 : 22,
    };
    mappedSize = sizeMap[size] || size;
  }

  if (t === 'pen') return { pen: { ...state.pen, size: mappedSize } };
  if (t === 'highlighter') return { highlighter: { ...state.highlighter, size: mappedSize } };
  if (t === 'text') return { text: { ...state.text, size: mappedSize } };
  if (t === 'shape') return {
    shape: { ...state.shape, settings: { ...state.shape.settings, size: mappedSize } }
  };
  return {};
}),

setCurrentToolColor: (color) => set((state) => {
  const t = state.activeTool;
  if (t === 'eraser' || t === 'pan' || t === 'select' || t === 'image') return {};

  if (t === 'pen') return { pen: { ...state.pen, color } };
  if (t === 'highlighter') return { highlighter: { ...state.highlighter, color } };
  if (t === 'text') return { text: { ...state.text, color } };
  if (t === 'shape') return {
    shape: { ...state.shape, settings: { ...state.shape.settings, color } }
  };
  return {};
}),

// New color system actions
addRecentColor: (hex) => set((state) => {
  const fixed = new Set(state.fixedColors.map(c => c.toLowerCase()));
  const h = hex.trim().toLowerCase();

  // Validate hex format
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(h)) return {};

  // Don't add fixed colors to recents
  if (fixed.has(h)) return {};

  // Add to front, remove duplicates, keep max 5
  const next = [h, ...state.recentColors.filter(c => c.toLowerCase() !== h)].slice(0, 5);
  return { recentColors: next };
}),

setColorPopoverOpen: (open) => set({ isColorPopoverOpen: open }),

setFillEnabledUI: (enabled) => set({ fillEnabledUI: enabled }),
```

## Phase 3: Rebuild ToolPanel with Inspector

### 3.1 New ToolPanel Component

**File:** `/client/src/pages/components/ToolPanel.tsx`

```tsx
import React, { useState, useEffect, useRef } from 'react';
import { useDeviceUIStore, Tool } from '../../stores/device-ui-store';

// Import icon components (see Phase 5 for icon definitions)
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
  const showInspector = ['pen', 'highlighter', 'text', 'select', 'shape'].includes(activeTool);
  const showColors = !['eraser', 'pan', 'image'].includes(activeTool);
  const showSizes = !['pan', 'image'].includes(activeTool) && activeTool !== 'eraser';
  const showFillToggle =
    activeTool === 'shape' || activeTool === 'pen' || activeTool === 'highlighter';

  // Get current settings
  const getCurrentSettings = () => {
    switch (activeTool) {
      case 'pen':
        return pen;
      case 'highlighter':
        return highlighter;
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
    if (activeTool === 'eraser') return [10]; // Fixed
    return [10, 14, 18, 22];
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
        {/* Tools in order */}
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
          onClick={() => setActiveTool('image')}
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

      {/* Undo/Redo micro buttons (top-right corner) */}
      <div className="undo-redo-micro">
        <button className="micro-ghost" aria-label="Undo" onClick={() => onToast?.('UNDO')}>
          <svg viewBox="0 0 24 24" className="micro-icon">
            <path d="M9 5l-5 5 5 5M20 12H5" />
          </svg>
        </button>
        <button className="micro-ghost" aria-label="Redo" onClick={() => onToast?.('REDO')}>
          <svg viewBox="0 0 24 24" className="micro-icon">
            <path d="M15 5l5 5-5 5M4 12h15" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// Tool Button Component
function ToolButton({ tool, isActive, onClick, tooltip, children }) {
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

// Enhanced Inspector Component with new color system
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
}) {
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
```

## Phase 4: CSS Implementation

### 4.1 Brand Palette & Toolbar Styles (48px Rail)

**File:** `/client/src/pages/RoomPage.css`

Add/update these CSS variables and styles:

```css
:root {
  /* Brand Palette */
  --dock-bg: #2d2d2d; /* Toolbar/inspector background */
  --dock-border: #3a3a3a; /* Subtle outline */
  --dock-hover: #383838; /* Hover on dark */
  --dock-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);

  --accent: #74a12e; /* Matcha - selected state */
  --accent-hover: #6a952b; /* Hover for selected */
  --accent-border: #5c8426; /* Focus/active border */

  --icon-muted: #f5f5f5; /* Default icon color */
  --icon-selected: #000000; /* Selected icon on accent */
  --text-muted: #e9e9e9;
  --text-weak: #bfbfbf;

  --divider: #3a3a3a;
  --ring: #9dd65a; /* Focus ring */
  --ring-offset: 2px;

  /* Component metrics - UPDATED FOR 48px RAIL */
  --dock-h: 48px; /* New baseline height */
  --btn: 36px; /* Button hit target */
  --btn-radius: 10px; /* Slightly larger radius */
  --dock-radius: 12px; /* Rounder for taller rail */
  --icon: 22px; /* Icon render size */
  --divider-h: 18px; /* Divider height */

  /* Inspector - kept tiny */
  --swatch: 14px; /* True circles */
  --swatch-ring: 2px; /* Faint selection ring */
  --pill-h: 22px; /* Size pill height */
  --pill-font: 11px; /* Size pill font */
  --pill-radius: 999px;

  /* Spacing scale */
  --gap-xxs: 4px;
  --gap-xs: 6px;
  --gap-s: 8px;
  --gap-m: 12px;
}

/* Remove header styles */
.header {
  display: none;
}

/* Workspace takes full height */
.workspace {
  height: 100vh;
  position: relative;
}

/* Canvas container full size */
.canvas-container {
  width: 100%;
  height: 100%;
  position: relative;
  background: white; /* Canvas background */
}

/* Top-left micro cluster */
.micro-cluster {
  position: fixed;
  top: 12px; /* Updated from 8px */
  left: 12px; /* Updated from 8px */
  z-index: 400;
  display: flex;
  align-items: center;
  gap: 6px;
}

.micro {
  height: 20px;
  min-width: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 6px;
  color: #6b7280;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  transition: all 120ms ease;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.micro:hover {
  background: #f9fafb;
  border-color: rgba(0, 0, 0, 0.1);
}

.micro-kebab {
  width: 16px;
  padding: 0 1px;
}

.micro-kebab .dot {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: #9ca3af;
  display: block;
  margin: 1px 0;
}

.micro-trash {
  width: 20px;
}

.icon-14 {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}

.micro-invite {
  font-weight: 700;
}

/* User avatar cluster */
.user-avatar-cluster {
  display: flex;
  align-items: center;
  gap: -3px; /* Overlap avatars slightly */
}

.micro-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: white;
  border: 1px solid white;
  cursor: pointer;
  transition: transform 100ms ease;
}

.micro-avatar:hover {
  transform: scale(1.1);
  z-index: 1;
}

.micro-avatar-me {
  background: #74a12e;
  color: black;
}

.user-overflow {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 11px;
  color: #6b7280;
  font-weight: 600;
}

/* Fixed top toolbar */
.tool-dock-wrap {
  position: fixed;
  top: 12px; /* Updated from 8px */
  left: 50%;
  transform: translateX(-50%);
  z-index: 380;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* The dock bar */
.tool-dock {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: var(--dock-h); /* Using new variable */
  padding: 0 10px;
  border-radius: var(--dock-radius);
  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  box-shadow: var(--dock-shadow);
  backdrop-filter: blur(6px);
}

/* Tool buttons */
.tool-dock .tool-btn {
  width: var(--btn); /* Using new variable */
  height: var(--btn); /* Using new variable */
  display: grid;
  place-items: center;
  border-radius: var(--btn-radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--icon-muted);
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
  cursor: pointer;
}

.tool-dock .tool-btn .icon {
  width: var(--icon); /* Using new variable */
  height: var(--icon); /* Using new variable */
  color: inherit;
}

.tool-dock .tool-btn:hover {
  background: var(--dock-hover);
}

.tool-dock .tool-btn.active {
  background: var(--accent);
  border-color: var(--accent-border);
  color: var(--icon-selected);
}

.tool-dock .tool-btn.active:hover {
  background: var(--accent-hover);
}

.tool-dock .tool-btn:active {
  transform: translateY(0.5px);
}

.tool-dock .tool-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

.tool-dock .tool-divider {
  width: 1px;
  height: var(--divider-h); /* Using new variable */
  background: var(--divider);
  margin: 0 2px;
}

/* Inspector */
.inspector {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: var(--dock-h); /* Using new variable */
  padding: 0 8px;
  border-radius: var(--dock-radius);
  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  box-shadow: var(--dock-shadow);
}

.inspector .row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* Color swatches */
.swatch-row {
  display: flex;
  align-items: center;
  gap: var(--gap-xs);
}

.swatch {
  width: var(--swatch); /* Using new variable */
  height: var(--swatch); /* Using new variable */
  border-radius: 9999px; /* Perfect circles */
  border: 1px solid rgba(255, 255, 255, 0.08);
  outline: none;
  cursor: pointer;
  transition:
    transform 90ms ease,
    box-shadow 120ms ease;
}

.swatch:hover {
  transform: scale(0.98) translateY(-0.5px);
}

.swatch.is-active-fixed {
  box-shadow: 0 0 0 var(--swatch-ring) rgba(157, 214, 90, 0.35); /* Faint matcha ring */
  border-color: var(--accent-border);
}

/* "+" button for more colors */
.swatch-plus {
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 12px;
  color: #e5e7eb;
  background: transparent;
  border: 1px dashed rgba(229, 231, 235, 0.25);
}

.swatch-plus.custom-outline {
  border-style: solid;
  border-width: 2px;
}

.swatch:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

/* Size pills */
.size-pill {
  height: var(--pill-h);
  padding: 0 8px;
  border-radius: var(--pill-radius);
  background: transparent;
  border: 1px solid var(--dock-border);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
  cursor: pointer;
}

.size-pill:hover {
  background: var(--dock-hover);
}

.size-pill.active {
  background: var(--accent);
  border-color: var(--accent-border);
  color: var(--icon-selected);
}

.size-pill:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

/* Color Popover */
.color-popover {
  position: absolute;
  z-index: 500;
  top: calc(var(--dock-h) + 8px);
  left: 0;
  width: 232px;
  padding: 10px;
  background: #1f1f1f;
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  transform: translateY(8px) scale(0.98);
  opacity: 0;
  animation: pop-enter 160ms cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}

@keyframes pop-enter {
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

.color-popover.closing {
  animation: pop-exit 130ms cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
}

@keyframes pop-exit {
  to {
    transform: translateY(8px) scale(0.98);
    opacity: 0;
  }
}

.popover-section {
  margin-bottom: 8px;
}

.popover-section:last-child {
  margin-bottom: 0;
}

.popover-section h6 {
  margin: 0 0 6px 0;
  font:
    600 11px/1 Inter,
    ui-sans-serif,
    system-ui;
  letter-spacing: 0.02em;
  color: #bfbfbf;
  text-transform: uppercase;
}

.swatch-grid {
  display: grid;
  grid-template-columns: repeat(6, var(--swatch));
  gap: 6px;
}

.hex-row {
  display: flex;
  gap: 6px;
}

.hex-row input {
  flex: 1;
  height: 24px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #111;
  color: #e5e7eb;
  padding: 0 8px;
  font:
    12px Inter,
    ui-sans-serif,
    system-ui;
}

.hex-row .hex-apply {
  width: 28px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #171717;
  color: #e5e7eb;
  font-size: 12px;
  cursor: pointer;
  transition: background 140ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.hex-row .hex-apply:hover {
  background: #1f2937;
}

/* Fill button */
.icon-btn {
  width: var(--btn);
  height: var(--btn);
  border-radius: var(--btn-radius);
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid transparent;
  color: #e5e7eb;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease;
}

.icon-btn.on {
  background: rgba(116, 161, 46, 0.14);
  border-color: #5c8426;
}

.icon-btn:hover {
  background: var(--dock-hover);
}

/* Undo/Redo micro buttons */
.undo-redo-micro {
  position: fixed;
  top: 12px; /* Updated from 8px */
  right: 12px; /* Updated from 8px */
  z-index: 381;
  display: inline-flex;
  gap: 6px;
  opacity: 0.95;
}

.micro-ghost {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  color: var(--icon-muted);
  box-shadow: var(--dock-shadow);
  transition: all 120ms ease;
  cursor: pointer;
}

.micro-ghost:hover {
  background: var(--dock-hover);
}

.micro-ghost:active {
  transform: translateY(0.5px);
}

.micro-icon {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  fill: none;
}
```

## Phase 5: SVG Icon Components

### 5.1 Create Icon Components

**New File:** `/client/src/pages/icons/index.tsx`

```tsx
import React from 'react';

// All icons use currentColor for automatic color inheritance

export const IconSelect: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    {/* Lasso select icon - exact path from user */}
    <path
      d="M4.495 11.05a8.186 8.186 0 0 0 .695-3.067c.001-.027.006-.052.007-.078l.965.41a9.254 9.254 0 0 1-.648 2.888zm14.087-5.128l-.81.61a12.73 12.73 0 0 1 1.272 1.98l1-.307a13.602 13.602 0 0 0-1.462-2.283zm-4.224-2.13a8.128 8.128 0 0 1 2.02 1.285l.825-.62a9.226 9.226 0 0 0-2.6-1.648zm-4.541-.355a6.581 6.581 0 0 1 1.748-.237 6.919 6.919 0 0 1 .864.063l.245-.985a7.967 7.967 0 0 0-1.109-.078 7.501 7.501 0 0 0-2.023.276zM5.873 18.574a3.676 3.676 0 0 1-2.13-1.012L2.66 17.8a4.49 4.49 0 0 0 3.103 1.776zm-2.861-2.9c-.003-.058-.012-.11-.012-.17 0-.594.314-1.01.917-1.756.168-.208.349-.438.53-.682l-1.13-.169A4.135 4.135 0 0 0 2 15.504c0 .136.012.261.022.389zM6.534 6.3a4.422 4.422 0 0 1 1.458-1.97l-.29-1.016a5.53 5.53 0 0 0-2.078 2.599zm15.084 7.022a16.977 16.977 0 0 0-.788-3.266l-.974.299a16.1 16.1 0 0 1 .587 2.11zM18.757 17l2.189 4.515-2.894 1.456-2.266-4.621L13 22.17V9.51L23.266 17zm-1.597-1h3.038L14 11.478v7.624l1.954-2.68 2.552 5.201 1.11-.559zM11 18.854a8.011 8.011 0 0 0-2.454-.391c-.229 0-.444.011-.651.026l-.111 1.013c.243-.022.493-.039.763-.039a7.2 7.2 0 0 1 2.453.453z"
      fill="currentColor"
    />
  </svg>
);

export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M14.7 3.3l6 6-3.2 3.2-6-6 3.2-3.2zM10.3 7.7l6 6-6.6 6.6c-.24.24-.54.41-.87.47l-4.39.73a.9.9 0 0 1-1.05-1.05l.73-4.39c.06-.33.23-.63.47-.87l6.61-6.45z"
      fill="currentColor"
    />
    <rect x="3.5" y="19.25" width="17" height="1.5" rx="0.75" fill="currentColor" />
  </svg>
);

export const IconHighlighter: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="m9 11-6 6v3h9l3-3m10-5-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconEraser: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconText: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M4 7V4h16v3M9 20h6M12 4v16"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconRectangle: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <rect
      x="5"
      y="6"
      width="14"
      height="12"
      rx="2"
      stroke="currentColor"
      strokeWidth="2.2"
      fill="none"
    />
  </svg>
);

export const IconEllipse: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <ellipse cx="12" cy="12" rx="8" ry="8" stroke="currentColor" strokeWidth="2.2" fill="none" />
  </svg>
);

export const IconArrow: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M4 12h12M12 6l6 6-6 6"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export const IconLine: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <line
      x1="6"
      y1="18"
      x2="18"
      y2="6"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    />
    <circle cx="6" cy="18" r="2.1" fill="currentColor" />
    <circle cx="18" cy="6" r="2.1" fill="currentColor" />
  </svg>
);

export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" />
    <path d="M7 16l3.2-3.2 3.8 4.8 2.7-3.3L21 18H7z" fill="#2D2D2D" />
    <circle cx="10" cy="9" r="1.6" fill="#2D2D2D" />
  </svg>
);

export const IconPan: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M9 12.5V9.8a1.8 1.8 0 1 1 3.6 0v1.2h.8V7.9a1.8 1.8 0 1 1 3.6 0v3.1h.8V9.5a1.8 1.8 0 1 1 3.6 0v6c0 3.1-2.6 5.6-5.7 5.6H10c-2.5 0-4.6-2-4.6-4.6v-3a1.7 1.7 0 1 1 3.6 0z"
      fill="currentColor"
    />
  </svg>
);

// Fill icon (paint bucket metaphor)
export const IconFill: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M3 11l6-6 8 8-6 6-8-8Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <path
      d="M15 7l2-2m-2 6c2.5.8 3.8 1.7 3.8 2.7 0 1.1-1.4 2-4.2 2"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);
```

### 7.3 LocalStorage Migration

Update the Zustand store migration to handle size changes only:

```typescript
migrate: (persistedState: any, version: number) => {
  // Update old size values to new system
  const migrateSize = (oldSize: number): number => {
    if (oldSize <= 5) return 10; // S
    if (oldSize <= 10) return 14; // M
    if (oldSize <= 15) return 18; // L
    return 22; // XL
  };

  const migrateTextSize = (oldSize: number): number => {
    if (oldSize <= 16) return 20; // S
    if (oldSize <= 24) return 30; // M
    if (oldSize <= 32) return 40; // L
    return 50; // XL
  };

  // Migrate old colors to new palette
  const migrateColor = (oldColor: string): string => {
    const colorMap: Record<string, string> = {
      '#111827': '#262626', // Old ink to new soft black
      '#0F172A': '#262626', // Another old ink variant
      '#F97316': '#EAB308', // Old orange to new yellow
      '#F59E0B': '#EAB308', // Old amber to new yellow
      '#10B981': '#22C55E', // Old green to new green
    };
    return colorMap[oldColor] || oldColor;
  };

  return {
    ...persistedState,
    pen: persistedState.pen
      ? {
          ...persistedState.pen,
          size: migrateSize(persistedState.pen.size),
          color: migrateColor(persistedState.pen.color || '#262626'),
        }
      : { size: 10, color: '#262626' },
    highlighter: persistedState.highlighter
      ? {
          ...persistedState.highlighter,
          size: migrateSize(persistedState.highlighter.size),
          color: migrateColor(persistedState.highlighter.color || '#EAB308'),
        }
      : { size: 10, color: '#EAB308', opacity: 0.45 },
    text: persistedState.text
      ? {
          ...persistedState.text,
          size: migrateTextSize(persistedState.text.size),
          color: migrateColor(persistedState.text.color || '#262626'),
        }
      : { size: 30, color: '#262626' },
    shape: persistedState.shape
      ? {
          ...persistedState.shape,
          settings: {
            ...persistedState.shape.settings,
            size: migrateSize(persistedState.shape.settings?.size || 10),
            color: migrateColor(persistedState.shape.settings?.color || '#262626'),
          },
        }
      : { variant: 'rectangle', settings: { size: 10, color: '#262626' } },

    // Add new color system fields
    fixedColors: [
      '#262626',
      '#EF4444',
      '#F97316',
      '#EAB308',
      '#22C55E',
      '#3B82F6',
      '#8B5CF6',
      '#6B7280',
    ],
    recentColors: persistedState.recentColors || [],
    isColorPopoverOpen: false,
    fillEnabledUI: persistedState.fillEnabledUI || false,

    // Add image placeholder
    image: { enabled: false },

    // Keep editor state for future
    editorCollapsed: persistedState.editorCollapsed || false,

    // Remove deprecated field
    toolbarPos: undefined,
  };
};
```

## Known Limitations & Future Work

1. **Fill Rendering**: Fill toggle is UI-only, actual rendering logic for shapes not implemented
2. **Image Tool**: Currently a placeholder, needs implementation
3. **Select Tool**: Lasso functionality not yet implemented
4. **Undo/Redo**: Currently shows toast only, needs actual implementation
5. **Keyboard Shortcuts**: Need to be updated for new tools and color popover navigation

