import { memo, type ReactNode } from 'react';
import { openImageFilePicker } from '@/core/image/image-actions';
import { getActiveRoomDoc, hasActiveRoom } from '@/runtime/room-runtime';
import { isStrokeTool, setActiveTool, setShapeMode, useDeviceUIStore } from '@/stores/device-ui-store';
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
} from './icons';
import { ConnectorInspector } from './inspectors/ConnectorInspector';
import { PenInspector } from './inspectors/PenInspector';
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
const clickSelect = () => setActiveTool('select');
const clickPan = () => setActiveTool('pan');
const clickNote = () => setActiveTool('note');
const clickText = () => setActiveTool('text');
const clickRect = () => setShapeMode('rectangle');
const clickEllipse = () => setShapeMode('ellipse');
const clickDiamond = () => setShapeMode('diamond');
const clickConnector = () => setActiveTool('connector');
const clickPen = () => setActiveTool('pen');
const clickCode = () => setActiveTool('code');
const clickEraser = () => setActiveTool('eraser');
const clickImage = () => openImageFilePicker();
const clickUndo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().undo();
};
const clickRedo = () => {
  if (hasActiveRoom()) getActiveRoomDoc().redo();
};

export function Toolbar() {
  const activeTool = useDeviceUIStore((s) => s.tool.active);
  const shapeVariant = useDeviceUIStore((s) => s.shape.variant);

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
        {activeTool === 'connector' && <ConnectorInspector />}
      </div>

      <div className="toolbar-actions">
        <ToolButton isActive={false} tooltip="Undo" onClick={clickUndo}>
          <IconUndo className="icon" />
        </ToolButton>
        <ToolButton isActive={false} tooltip="Redo" onClick={clickRedo}>
          <IconRedo className="icon" />
        </ToolButton>
      </div>
    </div>
  );
}
