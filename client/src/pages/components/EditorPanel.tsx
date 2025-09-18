import React from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';

interface EditorPanelProps {
  className?: string;
}

export function EditorPanel({ className = '' }: EditorPanelProps) {
  const { editorCollapsed, toggleEditor } = useDeviceUIStore();

  return (
    <>
      {/* Persistent expand tab - OUTSIDE the panel */}
      {editorCollapsed && (
        <button className="editor-expand-tab" onClick={toggleEditor} aria-label="Expand editor">
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
          <span className="vertical-text">Editor</span>
        </button>
      )}

      {/* The actual panel */}
      <div className={`editor-panel ${editorCollapsed ? 'collapsed' : ''} ${className}`}>
        <div className="editor-header">
          <div className="editor-tabs">
            <button className="editor-tab active">Code</button>
            <button className="editor-tab">Output</button>
          </div>
          <button className="icon-btn" onClick={toggleEditor} aria-label="Toggle editor">
            <svg className="icon icon-sm" viewBox="0 0 24 24">
              <path d="M11 19l-7-7 7-7M4 12h16" />
            </svg>
          </button>
        </div>

        <div className="editor-content">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-tertiary)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Monaco Editor + Pyodide (Phase 15)
          </div>
        </div>

        {/* AI Panel Stub */}
        <div className="ai-panel">
          <div className="ai-header">
            <div className="ai-title">
              <svg className="icon icon-sm" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              AI Assistant
            </div>
            <button className="icon-btn" aria-label="Clear chat">
              <svg className="icon icon-sm" viewBox="0 0 24 24">
                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
              </svg>
            </button>
          </div>

          <div
            className="ai-messages"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-tertiary)',
              fontSize: 'var(--text-xs)',
            }}
          >
            AI Chat (Future)
          </div>

          <div className="ai-input-area">
            <textarea className="ai-input" placeholder="Ask about your code..." rows={1} disabled />
            <button className="ai-send" disabled>
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
