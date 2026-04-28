import { memo, type ReactNode } from 'react';
import {
  IconArrow,
  IconCode,
  IconDiamond,
  IconEllipse,
  IconEraser,
  IconImage,
  IconPan,
  IconPen,
  IconRectangle,
  IconRedo,
  IconSelect,
  IconStickyNote,
  IconText,
  IconUndo,
} from '@/components/icons';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import * as A from './actions';
import { PenInspector } from './PenInspector';
import './Toolbar.css';

interface ToolButtonProps {
  isActive: boolean;
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}

const ToolButton = memo(function ToolButton({ isActive, tooltip, onClick, children }: ToolButtonProps) {
  return (
    <button className={`tool-btn ${isActive ? 'active' : ''}`} data-tooltip={tooltip} aria-label={tooltip} onClick={onClick}>
      {children}
    </button>
  );
});

// Pre-bound handlers so memoized ToolButton props are stable across renders.
const clickSelect = () => A.selectTool('select');
const clickPan = () => A.selectTool('pan');
const clickNote = () => A.selectTool('note');
const clickText = () => A.selectTool('text');
const clickRect = () => A.selectShape('rectangle');
const clickEllipse = () => A.selectShape('ellipse');
const clickDiamond = () => A.selectShape('diamond');
const clickConnector = () => A.selectTool('connector');
const clickPen = () => A.selectTool('pen');
const clickCode = () => A.selectTool('code');
const clickEraser = () => A.selectTool('eraser');

export function Toolbar() {
  const activeTool = useDeviceUIStore((s) => s.activeTool);
  const shapeVariant = useDeviceUIStore((s) => s.shapeVariant);
  const showInspector = activeTool === 'pen' || activeTool === 'highlighter';

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
        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'rectangle'} tooltip="Rectangle (R)" onClick={clickRect}>
          <IconRectangle className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'ellipse'} tooltip="Ellipse (O)" onClick={clickEllipse}>
          <IconEllipse className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'shape' && shapeVariant === 'diamond'} tooltip="Diamond (D)" onClick={clickDiamond}>
          <IconDiamond className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'connector'} tooltip="Connector (A)" onClick={clickConnector}>
          <IconArrow className="icon" />
        </ToolButton>
        <ToolButton isActive={showInspector} tooltip="Pen (P)" onClick={clickPen}>
          <IconPen className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'code'} tooltip="Code" onClick={clickCode}>
          <IconCode className="icon" />
        </ToolButton>
        <ToolButton isActive={false} tooltip="Image (I)" onClick={A.pickImage}>
          <IconImage className="icon" />
        </ToolButton>
        <ToolButton isActive={activeTool === 'eraser'} tooltip="Eraser (E)" onClick={clickEraser}>
          <IconEraser className="icon" />
        </ToolButton>

        {showInspector && <PenInspector />}
      </div>

      <div className="toolbar-actions">
        <ToolButton isActive={false} tooltip="Undo" onClick={A.undo}>
          <IconUndo className="icon" />
        </ToolButton>
        <ToolButton isActive={false} tooltip="Redo" onClick={A.redo}>
          <IconRedo className="icon" />
        </ToolButton>
      </div>
    </div>
  );
}
