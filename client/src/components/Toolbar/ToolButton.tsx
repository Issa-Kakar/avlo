import React from 'react';

interface ToolButtonProps {
  label: string;
  icon: string;
  isActive: boolean;
  isEnabled: boolean;
  onClick: () => void;
}

export function ToolButton({ label, icon, isActive, isEnabled, onClick }: ToolButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={!isEnabled}
      className={`
        relative p-3 rounded-lg transition-all
        ${
          isActive ? 'bg-blue-500 text-white shadow-md' : 'bg-white text-gray-700 hover:bg-gray-100'
        }
        ${!isEnabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
      title={isEnabled ? label : `${label} (Coming soon)`}
    >
      <span className="text-xl">{icon}</span>
      {isActive && (
        <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-white rounded-full mb-1" />
      )}
    </button>
  );
}
