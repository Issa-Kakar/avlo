import React, { useState } from 'react';
import './SelectionContextMenu.css';

// Icons as inline SVGs for the demo
const IconSwitchType = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="12" height="12" rx="2" />
  </svg>
);

const IconChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 4.5L6 7.5L9 4.5" />
  </svg>
);

const IconChevronUp = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6.5L5 4L7.5 6.5" />
  </svg>
);

const IconChevronDownSmall = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 3.5L5 6L7.5 3.5" />
  </svg>
);

// Shape type icons for submenu
const IconRectangle = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="12" height="10" rx="1" />
  </svg>
);

const IconRoundedRect = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="12" height="10" rx="3" />
  </svg>
);

const IconEllipse = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="8" cy="8" rx="6" ry="5" />
  </svg>
);

const IconDiamond = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 2L14 8L8 14L2 8L8 2Z" />
  </svg>
);

const IconTriangle = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3L14 13H2L8 3Z" />
  </svg>
);

interface SelectionContextMenuProps {
  /** Position in screen coords */
  x?: number;
  y?: number;
  /** For demo: show in fixed position */
  demo?: boolean;
}

/**
 * SelectionContextMenu - UI Spec Component
 *
 * A floating context menu that appears when objects are selected.
 * This is a visual spec - logic/positioning to be implemented separately.
 */
export function SelectionContextMenu({ x = 0, y = 0, demo = false }: SelectionContextMenuProps) {
  const [showTypeSubmenu, setShowTypeSubmenu] = useState(false);
  const [showFontSubmenu, setShowFontSubmenu] = useState(false);
  const [fontSize, setFontSize] = useState(10);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [selectedFont, setSelectedFont] = useState('Inter');
  const [selectedType, setSelectedType] = useState<'rectangle' | 'roundedRect' | 'ellipse' | 'diamond' | 'triangle'>('roundedRect');

  const fonts = [
    'Inter',
    'SF Pro',
    'Roboto',
    'Open Sans',
    'Lato',
    'Montserrat',
    'Source Sans Pro',
    'Nunito',
  ];

  const shapeTypes = [
    { id: 'rectangle', label: 'Rectangle', icon: <IconRectangle /> },
    { id: 'roundedRect', label: 'Rounded', icon: <IconRoundedRect /> },
    { id: 'ellipse', label: 'Ellipse', icon: <IconEllipse /> },
    { id: 'diamond', label: 'Diamond', icon: <IconDiamond /> },
    { id: 'triangle', label: 'Triangle', icon: <IconTriangle /> },
  ] as const;

  const handleFontSizeUp = () => setFontSize(prev => Math.min(prev + 1, 144));
  const handleFontSizeDown = () => setFontSize(prev => Math.max(prev - 1, 6));

  const positionStyle = demo
    ? { position: 'fixed' as const, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
    : { position: 'absolute' as const, left: x, top: y };

  return (
    <div
      className="selection-context-menu"
      style={positionStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Switch Type Button */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-icon ${showTypeSubmenu ? 'active' : ''}`}
          onClick={() => {
            setShowTypeSubmenu(!showTypeSubmenu);
            setShowFontSubmenu(false);
          }}
          aria-label="Switch shape type"
          aria-haspopup="menu"
          aria-expanded={showTypeSubmenu}
        >
          {shapeTypes.find(t => t.id === selectedType)?.icon || <IconSwitchType />}
          <IconChevronDown />
        </button>

        {/* Type Submenu */}
        {showTypeSubmenu && (
          <div className="scm-submenu scm-submenu-types">
            {shapeTypes.map((type) => (
              <button
                key={type.id}
                className={`scm-submenu-item ${selectedType === type.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedType(type.id);
                  setShowTypeSubmenu(false);
                }}
              >
                <span className="scm-submenu-icon">{type.icon}</span>
                <span className="scm-submenu-label">{type.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="scm-divider" />

      {/* Font Selector */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-font ${showFontSubmenu ? 'active' : ''}`}
          onClick={() => {
            setShowFontSubmenu(!showFontSubmenu);
            setShowTypeSubmenu(false);
          }}
          aria-label="Select font"
          aria-haspopup="listbox"
          aria-expanded={showFontSubmenu}
        >
          <span className="scm-font-name">{selectedFont}</span>
          <IconChevronDown />
        </button>

        {/* Font Submenu */}
        {showFontSubmenu && (
          <div className="scm-submenu scm-submenu-fonts">
            {fonts.map((font) => (
              <button
                key={font}
                className={`scm-submenu-item ${selectedFont === font ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedFont(font);
                  setShowFontSubmenu(false);
                }}
                style={{ fontFamily: font }}
              >
                {font}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="scm-divider" />

      {/* Font Size */}
      <div className="scm-group scm-size-group">
        <button
          className="scm-size-btn scm-size-down"
          onClick={handleFontSizeDown}
          aria-label="Decrease font size"
        >
          <IconChevronDownSmall />
        </button>
        <span className="scm-size-value">{fontSize}</span>
        <button
          className="scm-size-btn scm-size-up"
          onClick={handleFontSizeUp}
          aria-label="Increase font size"
        >
          <IconChevronUp />
        </button>
      </div>

      <div className="scm-divider" />

      {/* Bold / Italic */}
      <div className="scm-group scm-format-group">
        <button
          className={`scm-btn scm-btn-format ${isBold ? 'active' : ''}`}
          onClick={() => setIsBold(!isBold)}
          aria-label="Bold"
          aria-pressed={isBold}
        >
          <span className="scm-format-b">B</span>
        </button>
        <button
          className={`scm-btn scm-btn-format ${isItalic ? 'active' : ''}`}
          onClick={() => setIsItalic(!isItalic)}
          aria-label="Italic"
          aria-pressed={isItalic}
        >
          <span className="scm-format-i">I</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Demo wrapper to show the context menu in isolation
 */
export function SelectionContextMenuDemo() {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: '#f8fafc',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <SelectionContextMenu demo />
    </div>
  );
}

export default SelectionContextMenu;
