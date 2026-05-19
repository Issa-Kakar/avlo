import { memo, type ReactNode } from 'react';
import { openImageFilePicker } from '@/core/image/image-actions';
import { isStrokeTool, setActiveTool, useDeviceUIStore } from '@/stores/device-ui-store';
import { IconArrow } from './icons/IconArrow';
import { IconCode } from './icons/IconCode';
import { IconEraser } from './icons/IconEraser';
import { IconImage } from './icons/IconImage';
import { IconPan } from './icons/IconPan';
import { IconPen } from './icons/IconPen';
import { IconSelect } from './icons/IconSelect';
import { IconShapes } from './icons/IconShapes';
import { IconStickyNote } from './icons/IconStickyNote';
import { IconText } from './icons/IconText';
import { ConnectorInspector } from './inspectors/ConnectorInspector';
import { PenInspector } from './inspectors/PenInspector';
import { ShapeInspector } from './inspectors/ShapeInspector';
import './Toolbar.css';

interface ToolButtonProps {
  isActive: boolean;
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}

const ToolButton = memo(function ToolButton({ isActive, tooltip, onClick, children }: ToolButtonProps) {
  return (
    <button className={`tool-btn ${isActive ? 'active' : ''}`} data-tooltip={tooltip} aria-label={tooltip} tabIndex={-1} onClick={onClick}>
      {children}
    </button>
  );
});

// Pre-bound handlers so memoized ToolButton props are stable across renders.
const clickSelect = () => setActiveTool('select');
const clickPan = () => setActiveTool('pan');
const clickNote = () => setActiveTool('note');
const clickText = () => setActiveTool('text');
// Shape entry point. Variant is whatever was last persisted in s.shape.variant
// — the inspector below switches it. R/O/D/3 keyboard shortcuts also flip the
// active tool, so this button mirrors the keyboard semantics for an idle
// (non-shape) variant.
const clickShape = () => setActiveTool('shape');
const clickConnector = () => setActiveTool('connector');
const clickPen = () => setActiveTool('pen');
const clickCode = () => setActiveTool('code');
const clickEraser = () => setActiveTool('eraser');
const clickImage = () => openImageFilePicker();

export function Toolbar() {
  const activeTool = useDeviceUIStore((s) => s.tool.active);

  return (
    <div className="toolbar-wrap">
      <div className="toolbar-main">
        <ToolButton isActive={activeTool === 'select'} tooltip="Select (V)" onClick={clickSelect}>
          <IconSelect className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'pan'} tooltip="Pan (Space)" onClick={clickPan}>
          <IconPan className="icon" />
        </ToolButton>

        <div className="toolbar-divider" />

        <ToolButton isActive={activeTool === 'note'} tooltip="Sticky Note (N)" onClick={clickNote}>
          <IconStickyNote className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'text'} tooltip="Text (T)" onClick={clickText}>
          <IconText className="icon" />
        </ToolButton>
        {/* Anchor wrappers tie the inspector's positioning context to the trigger
            button (not the whole pill), so the inspector centers on the clicked
            button. Pen inspector is too tall for this — anchoring it to the Pen
            button (8th in the column) would push its bottom edge below the dock —
            so it stays a direct child of .toolbar-main, centered on the pill. */}
        <div className="tool-btn-anchor">
          <ToolButton isActive={activeTool === 'shape'} tooltip="Shapes" onClick={clickShape}>
            <IconShapes className="icon" />
          </ToolButton>
          {activeTool === 'shape' && <ShapeInspector />}
        </div>
        <div className="tool-btn-anchor">
          <ToolButton isActive={activeTool === 'connector'} tooltip="Connector (A)" onClick={clickConnector}>
            <IconArrow className="icon" />
          </ToolButton>
          {activeTool === 'connector' && <ConnectorInspector />}
        </div>
        <ToolButton isActive={isStrokeTool(activeTool)} tooltip="Pen (P)" onClick={clickPen}>
          <IconPen className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'code'} tooltip="Code" onClick={clickCode}>
          <IconCode className="icon" />
        </ToolButton>
        <ToolButton isActive={false} tooltip="Image (I)" onClick={clickImage}>
          <IconImage className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'eraser'} tooltip="Eraser (E)" onClick={clickEraser}>
          <IconEraser className="icon" />
        </ToolButton>

        {isStrokeTool(activeTool) && <PenInspector tool={activeTool} />}
      </div>
    </div>
  );
}
