import { type CSSProperties, useEffect } from 'react';
import { beginNotePlace } from '@/runtime/input/toolbar-place';
import { closeStickyPanel, NOTE_COLOR_PALETTE, setNoteFillColor } from '@/stores/device-ui-store';
import { isDark } from '../color/palette';
import './StickyNotePanel.css';

// CSS custom properties — typed via cast because CSSProperties doesn't list
// app-specific custom properties (same pattern as colorButtonStyle). Centralized
// here so the cast lives in one place. `--tilt` alternates by column so a
// hovered note splays outward like a hand-placed sheet.
function swatchStyle(fill: string, index: number): CSSProperties {
  return {
    '--fill': fill,
    '--tilt': index % 2 === 0 ? '-2.6deg' : '2.6deg',
  } as CSSProperties;
}

// One-shot picker: a swatch click sets the fill and dismisses the panel.
function pickColor(fill: string): void {
  setNoteFillColor(fill);
  closeStickyPanel();
}

/**
 * Sticky-note color palette — a popout beside the dock, mounted by Toolbar
 * while `stickyPanelOpen` is set. No active/selected swatch: the panel is a
 * one-shot picker, so flagging a "current" color would only add noise.
 */
export function StickyNotePanel() {
  // Escape dismisses the popout — standard for a transient surface. No editor
  // is mounted while the panel is open, so this never collides with TextTool's
  // own Escape handler.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeStickyPanel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="sticky-panel" aria-label="Sticky note color">
      <div className="sticky-grid">
        {NOTE_COLOR_PALETTE.map((c, i) => (
          <button
            key={c.fill}
            type="button"
            className="sticky-swatch"
            style={swatchStyle(c.fill, i)}
            data-dark={isDark(c.fill) || undefined}
            aria-label={`${c.name} sticky note`}
            tabIndex={-1}
            onClick={() => pickColor(c.fill)}
            onPointerDown={(e) => beginNotePlace(e, c.fill)}
          />
        ))}
      </div>
    </div>
  );
}
