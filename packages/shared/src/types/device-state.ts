// Toolbar state stored locally
export interface ToolbarState {
  tool: 'pen' | 'highlighter' | 'text' | 'eraser' | 'stamp';
  size: number;
  color: string;
  opacity: number;
  advancedOpen: boolean;
}

// Complete device UI state
export interface DeviceUIState {
  toolbar: ToolbarState;
  collaborationMode: 'server' | 'peer';
  aiPanelOpen: boolean;
  lastVersionSeen: string; // For update prompts
}

// Storage key constant
export const DEVICE_UI_STORAGE_KEY = 'avlo:v1:ui';
