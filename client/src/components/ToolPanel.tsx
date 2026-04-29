import type React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { openImageFilePicker } from '@/core/image/image-actions';
import { hasActiveRoom, redo, undo } from '@/runtime/room-runtime';
import { type ConnectorSizePreset, type SizePreset, TEXT_COLOR_PALETTE, type Tool, useDeviceUIStore } from '../stores/device-ui-store';

import './ToolPanel.css';

import {
  IconArrow,
  IconCode,
  IconDiamond,
  IconEllipse,
  IconEraser,
  IconFill,
  IconHighlighter,
  IconImage,
  IconPan,
  IconPen,
  IconRectangle,
  IconRedo,
  IconSelect,
  IconStickyNote,
  IconText,
  IconUndo,
} from './icons';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level constants — frozen, never re-allocated per render
// ─────────────────────────────────────────────────────────────────────────────

const SIZE_LABELS: readonly string[] = ['S', 'M', 'L', 'XL'];
const SIZE_PRESETS_DEFAULT: readonly number[] = [4, 7, 10, 13];
const SIZE_PRESETS_CONNECTOR: readonly number[] = [2, 4, 6, 8];
const SIZE_PRESETS_NONE: readonly number[] = [];

const FIXED_COLORS: readonly string[] = TEXT_COLOR_PALETTE.slice(0, 8);
const FIXED_COLORS_REVERSED: readonly string[] = [...FIXED_COLORS].reverse();
const FIXED_COLORS_LOWER: ReadonlySet<string> = new Set(FIXED_COLORS.map((c) => c.toLowerCase()));

const MORE_COLORS: readonly string[] = [
  '#FFFFFF',
  '#8B5E3C',
  '#06B6D4',
  '#EC4899',
  '#84CC16',
  '#1E3A8A',
  '#14B8A6',
  '#0EA5E9',
  '#A855F7',
  '#F43F5E',
  '#F5E7C6',
  '#374151',
];

const INSPECTOR_TOOLS: ReadonlySet<Tool> = new Set(['pen', 'highlighter', 'text', 'shape', 'connector', 'note']);
const NO_COLOR_TOOLS: ReadonlySet<Tool> = new Set(['eraser', 'pan', 'image']);
const NO_SIZE_TOOLS: ReadonlySet<Tool> = new Set(['pan', 'image']);
const FILL_TOGGLE_TOOLS: ReadonlySet<Tool> = new Set(['shape', 'pen', 'highlighter', 'select']);

// ─────────────────────────────────────────────────────────────────────────────
// Selectors — narrow the subscription so cursorOverride/text/code/etc. churn
// in the store does NOT re-render the toolbar.
// ─────────────────────────────────────────────────────────────────────────────

type DeviceUI = ReturnType<typeof useDeviceUIStore.getState>;

const selectActiveTool = (s: DeviceUI) => s.activeTool;
const selectToolPanelSlice = (s: DeviceUI) => ({
  drawingSettings: s.drawingSettings,
  shapeVariant: s.shapeVariant,
  recentColors: s.recentColors,
  isColorPopoverOpen: s.isColorPopoverOpen,
  connectorType: s.connectorType,
  connectorSize: s.connectorSize,
});

// ─────────────────────────────────────────────────────────────────────────────
// Stable handlers — defined once at module scope. Read live state via
// getState() at click time; never re-allocate.
// ─────────────────────────────────────────────────────────────────────────────

const setTool = (t: Tool) => useDeviceUIStore.getState().setActiveTool(t);
const onClickSelect = () => setTool('select');
const onClickPan = () => setTool('pan');
const onClickNote = () => setTool('note');
const onClickPen = () => setTool('pen');
const onClickHighlighter = () => setTool('highlighter');
const onClickEraser = () => setTool('eraser');
const onClickText = () => setTool('text');
const onClickConnector = () => setTool('connector');
const onClickCode = () => setTool('code');
const onClickImage = () => openImageFilePicker();

const onClickRectangle = () => {
  const s = useDeviceUIStore.getState();
  s.setActiveTool('shape');
  s.setShapeVariant('rectangle');
};
const onClickDiamond = () => {
  const s = useDeviceUIStore.getState();
  s.setActiveTool('shape');
  s.setShapeVariant('diamond');
};
const onClickEllipse = () => {
  const s = useDeviceUIStore.getState();
  s.setActiveTool('shape');
  s.setShapeVariant('ellipse');
};

const onClickUndo = () => {
  if (hasActiveRoom()) undo();
};
const onClickRedo = () => {
  if (hasActiveRoom()) redo();
};

const onColorChange = (c: string) => useDeviceUIStore.getState().setDrawingColor(c);
const onAddRecentColor = (c: string) => useDeviceUIStore.getState().addRecentColor(c);

const onTogglePopover = () => {
  const s = useDeviceUIStore.getState();
  s.setColorPopoverOpen(!s.isColorPopoverOpen);
};
const onToggleFill = () => {
  const s = useDeviceUIStore.getState();
  s.setFillEnabled(!s.drawingSettings.fill);
};
const onToggleConnectorType = () => {
  const s = useDeviceUIStore.getState();
  s.setConnectorType(s.connectorType === 'elbow' ? 'straight' : 'elbow');
};
const onChangeDrawingSize = (size: number) => useDeviceUIStore.getState().setDrawingSize(size as SizePreset);
const onChangeConnectorSize = (size: number) => useDeviceUIStore.getState().setConnectorSize(size as ConnectorSizePreset);

// ─────────────────────────────────────────────────────────────────────────────
// ToolPanel
// ─────────────────────────────────────────────────────────────────────────────

export function ToolPanel() {
  const activeTool = useDeviceUIStore(selectActiveTool);
  const { drawingSettings, shapeVariant, recentColors, isColorPopoverOpen, connectorType, connectorSize } = useDeviceUIStore(
    useShallow(selectToolPanelSlice),
  );

  const popoverRef = useRef<HTMLDivElement>(null);

  const showInspector = INSPECTOR_TOOLS.has(activeTool);
  const showColors = !NO_COLOR_TOOLS.has(activeTool);
  const showSizes = !NO_SIZE_TOOLS.has(activeTool);
  const showFillToggle = FILL_TOGGLE_TOOLS.has(activeTool);
  // TEMP: piggy-back the fill-toggle slot to expose the connector elbow⇄straight toggle.
  // Icon is intentionally reused (not semantic) — this whole panel is being replaced by
  // the vertical toolbar in a worktree. Delete both the flag and the button below when
  // the new toolbar lands.
  const showConnectorTypeToggle = activeTool === 'connector';

  const sizePresets =
    activeTool === 'text' || activeTool === 'note'
      ? SIZE_PRESETS_NONE
      : activeTool === 'connector'
        ? SIZE_PRESETS_CONNECTOR
        : SIZE_PRESETS_DEFAULT;

  const currentSize = activeTool === 'connector' ? connectorSize : drawingSettings.size;
  const onSizeChange = activeTool === 'connector' ? onChangeConnectorSize : onChangeDrawingSize;

  // Close popover on outside click
  useEffect(() => {
    if (!isColorPopoverOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        useDeviceUIStore.getState().setColorPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isColorPopoverOpen]);

  return (
    <div className="tool-dock-wrap">
      <div className="tool-dock">
        <ToolButton isActive={activeTool === 'select'} onClick={onClickSelect} tooltip="Select (V)">
          <IconSelect className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'pan'} onClick={onClickPan} tooltip="Pan (Space)">
          <IconPan className="icon" />
        </ToolButton>

        <div className="tool-divider" />

        <ToolButton isActive={activeTool === 'note'} onClick={onClickNote} tooltip="Sticky Note (N)">
          <IconStickyNote className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'pen'} onClick={onClickPen} tooltip="Pen (P)">
          <IconPen className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'highlighter'} onClick={onClickHighlighter} tooltip="Highlighter (H)">
          <IconHighlighter className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'eraser'} onClick={onClickEraser} tooltip="Eraser (E)">
          <IconEraser className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'text'} onClick={onClickText} tooltip="Text (T)">
          <IconText className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'connector'} onClick={onClickConnector} tooltip="Connector">
          <IconArrow className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'rectangle'} onClick={onClickRectangle} tooltip="Rectangle (R)">
          <IconRectangle className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'diamond'} onClick={onClickDiamond} tooltip="Diamond (D)">
          <IconDiamond className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'ellipse'} onClick={onClickEllipse} tooltip="Ellipse (O)">
          <IconEllipse className="icon" />
        </ToolButton>

        <ToolButton isActive={activeTool === 'code'} onClick={onClickCode} tooltip="Code">
          <IconCode className="icon" />
        </ToolButton>

        <ToolButton isActive={false} onClick={onClickImage} tooltip="Image (I)">
          <IconImage className="icon" />
        </ToolButton>

        {showInspector && (
          <Inspector
            fillEnabled={drawingSettings.fill}
            showColors={showColors}
            showSizes={showSizes}
            showFillToggle={showFillToggle}
            showConnectorTypeToggle={showConnectorTypeToggle}
            connectorType={connectorType}
            recentColors={recentColors}
            sizePresets={sizePresets}
            currentColor={drawingSettings.color}
            currentSize={currentSize}
            isColorPopoverOpen={isColorPopoverOpen}
            popoverRef={popoverRef}
            onSizeChange={onSizeChange}
          />
        )}

        <div className="undo-redo-compact">
          <button className="undo-btn" aria-label="Undo" onClick={onClickUndo}>
            <IconUndo className="undo-icon" />
          </button>
          <button className="redo-btn" aria-label="Redo" onClick={onClickRedo}>
            <IconRedo className="redo-icon" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolButton — memoized; siblings don't re-render when one button's `isActive`
// flips, since onClick refs are module-level and never invalidate.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolButtonProps {
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
}

const ToolButton = memo(function ToolButton({ isActive, onClick, tooltip, children }: ToolButtonProps) {
  return (
    <button className={`tool-btn ${isActive ? 'active' : ''}`} data-tooltip={tooltip} onClick={onClick} aria-label={tooltip}>
      {children}
    </button>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Inspector — memoized. Receives only the slice it actually displays.
// ─────────────────────────────────────────────────────────────────────────────

interface InspectorProps {
  showColors: boolean;
  showSizes: boolean;
  showFillToggle: boolean;
  showConnectorTypeToggle: boolean;
  connectorType: 'elbow' | 'straight';
  fillEnabled: boolean;
  recentColors: string[];
  sizePresets: readonly number[];
  currentColor: string;
  currentSize: number;
  isColorPopoverOpen: boolean;
  onSizeChange: (size: number) => void;
  popoverRef: React.RefObject<HTMLDivElement | null>;
}

const Inspector = memo(function Inspector({
  showColors,
  showSizes,
  showFillToggle,
  showConnectorTypeToggle,
  connectorType,
  fillEnabled,
  recentColors,
  sizePresets,
  currentColor,
  currentSize,
  isColorPopoverOpen,
  onSizeChange,
  popoverRef,
}: InspectorProps) {
  const [hexInput, setHexInput] = useState('#');

  const isCustomColor = !FIXED_COLORS_LOWER.has(currentColor?.toLowerCase());

  const handleColorSelect = (color: string, isCustom: boolean) => {
    onColorChange(color);
    if (isCustom) onAddRecentColor(color);
    onTogglePopover();
  };

  const handleHexSubmit = () => {
    const h = hexInput.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) {
      handleColorSelect(h, true);
      setHexInput('#');
    }
  };

  return (
    <div className="inspector">
      {showSizes && sizePresets.length > 1 && (
        <div className="row sizes">
          {sizePresets.map((px, i) => (
            <button
              key={px}
              className={`size-pill ${currentSize === px ? 'active' : ''}`}
              onClick={() => onSizeChange(px)}
              aria-label={`Size ${SIZE_LABELS[i]}`}
            >
              {SIZE_LABELS[i]}
            </button>
          ))}
        </div>
      )}

      {showFillToggle && (
        <button className={`icon-btn ${fillEnabled ? 'on' : ''}`} onClick={onToggleFill} aria-label="Fill" title="Fill">
          <IconFill className="icon" />
        </button>
      )}

      {/*
        TEMP: connector elbow⇄straight toggle squatting in the fill-toggle slot.
        Same <IconFill> + `.icon-btn` styling — purely to give the toggle somewhere
        to live until the new vertical toolbar ships. "on" state = elbow.
      */}
      {showConnectorTypeToggle && (
        <button
          className={`icon-btn ${connectorType === 'elbow' ? 'on' : ''}`}
          onClick={onToggleConnectorType}
          aria-label="Connector type"
          title={`Connector: ${connectorType} (click to toggle)`}
        >
          <IconFill className="icon" />
        </button>
      )}

      {showColors && (
        <div className="inspector-colors">
          <div className="swatch-row">
            <button
              className="swatch swatch-plus"
              onClick={onTogglePopover}
              aria-haspopup="dialog"
              aria-expanded={isColorPopoverOpen}
              aria-label="More colors"
            >
              {isCustomColor && <div className="custom-color-dot" style={{ backgroundColor: currentColor }} />}
            </button>

            {FIXED_COLORS_REVERSED.map((c) => (
              <button
                key={c}
                className={`swatch ${currentColor === c ? 'is-active-fixed' : ''}`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
                onClick={() => onColorChange(c)}
              />
            ))}
          </div>

          {isColorPopoverOpen && (
            <div className="color-popover" role="dialog" aria-modal="true" ref={popoverRef}>
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

              <div className="popover-section">
                <h6>MORE</h6>
                <div className="swatch-grid">
                  {MORE_COLORS.map((c) => (
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

              <div className="popover-section">
                <h6>HEX CODE</h6>
                <div className="hex-row">
                  <input
                    type="text"
                    value={hexInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHexInput(v.startsWith('#') ? v : `#${v}`);
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
});
