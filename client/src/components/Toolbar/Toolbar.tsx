import React from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';
import { ToolButton } from './ToolButton';
import { ToolControls } from './ToolControls';

// Tool definitions with enabled flags
const TOOLS = [
  { id: 'pen', label: 'Pen', icon: '✏️', enabled: true },
  { id: 'highlighter', label: 'Highlighter', icon: '🖊️', enabled: true },
  { id: 'text', label: 'Text', icon: 'T', enabled: false },
  { id: 'eraser', label: 'Eraser', icon: '🧹', enabled: false },
  { id: 'stamp', label: 'Stamp', icon: '⭐', enabled: false },
] as const;

interface ToolbarProps {
  className?: string;
}

export function Toolbar({ className = '' }: ToolbarProps) {
  const toolbar = useDeviceUIStore((state) => state.toolbar);
  const setTool = useDeviceUIStore((state) => state.setTool);
  const setToolSize = useDeviceUIStore((state) => state.setToolSize);
  const setToolColor = useDeviceUIStore((state) => state.setToolColor);

  const handleToolClick = (toolId: string) => {
    // Only allow switching to enabled tools
    const tool = TOOLS.find((t) => t.id === toolId);
    if (tool?.enabled) {
      setTool(toolId as 'pen' | 'highlighter' | 'text' | 'eraser' | 'stamp');
    }
  };

  return (
    <div className={`bg-gray-50 border-r border-gray-200 p-4 ${className}`}>
      {/* Tool Selection */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Tools</h3>
        <div className="grid grid-cols-1 gap-2">
          {TOOLS.map((tool) => (
            <ToolButton
              key={tool.id}
              label={tool.label}
              icon={tool.icon}
              isActive={toolbar.tool === tool.id}
              isEnabled={tool.enabled}
              onClick={() => handleToolClick(tool.id)}
            />
          ))}
        </div>
      </div>

      {/* Tool Controls - Only show for pen and highlighter */}
      {(toolbar.tool === 'pen' || toolbar.tool === 'highlighter') && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Properties</h3>
          <ToolControls
            size={toolbar.size}
            color={toolbar.color}
            onSizeChange={setToolSize}
            onColorChange={setToolColor}
          />
          {toolbar.tool === 'highlighter' && (
            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
              Note: Highlighter opacity is fixed at 25%
            </div>
          )}
        </div>
      )}

      {/* Info for disabled tools */}
      <div className="mt-6 p-3 bg-gray-100 rounded-lg">
        <p className="text-xs text-gray-500">
          Text, Eraser, and Stamp tools coming soon in future phases.
        </p>
      </div>
    </div>
  );
}
