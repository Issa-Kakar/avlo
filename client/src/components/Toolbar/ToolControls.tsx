import React from 'react';

interface ToolControlsProps {
  size: number;
  color: string;
  onSizeChange: (size: number) => void;
  onColorChange: (color: string) => void;
}

export function ToolControls({ size, color, onSizeChange, onColorChange }: ToolControlsProps) {
  return (
    <div className="space-y-4 p-4 bg-white rounded-lg shadow-sm">
      {/* Size Control */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2">Size: {size}px</label>
        <input
          type="range"
          min="1"
          max="64"
          value={size}
          onChange={(e) => onSizeChange(Number(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>1</span>
          <span>64</span>
        </div>
      </div>

      {/* Color Control */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2">Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            className="w-12 h-12 rounded cursor-pointer border border-gray-300"
          />
          <input
            type="text"
            value={color}
            onChange={(e) => {
              // Validate hex color format
              const value = e.target.value;
              if (/^#[0-9A-Fa-f]{6}$/.test(value) || value.length < 7) {
                onColorChange(value);
              }
            }}
            placeholder="#000000"
            className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Size Preview */}
      <div className="pt-2 border-t border-gray-100">
        <div className="text-xs text-gray-500 mb-2">Preview</div>
        <div className="flex justify-center items-center h-16 bg-gray-50 rounded">
          <div
            className="rounded-full"
            style={{
              width: `${Math.min(size, 48)}px`,
              height: `${Math.min(size, 48)}px`,
              backgroundColor: color,
            }}
          />
        </div>
      </div>
    </div>
  );
}
