import React, { useState } from 'react';
import './SelectionContextMenu.css';

// ============================================================================
// ICONS
// ============================================================================

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

// Shape type icons
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

// Object type icons for filter
const IconPen = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2L14 4L5 13L2 14L3 11L12 2Z" />
  </svg>
);

const IconShape = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L2 14H10L14 2H6Z" />
  </svg>
);

const IconConnector = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12L8 4L14 12" />
    <circle cx="2" cy="12" r="1.5" fill="currentColor" />
    <path d="M14 9V12H11" />
  </svg>
);

// Alignment icons
const IconAlignLeft = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="2" y1="2" x2="2" y2="14" />
    <rect x="4" y="4" width="8" height="3" rx="0.5" />
    <rect x="4" y="9" width="5" height="3" rx="0.5" />
  </svg>
);

const IconAlignCenterH = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="8" y1="2" x2="8" y2="14" />
    <rect x="3" y="4" width="10" height="3" rx="0.5" />
    <rect x="5" y="9" width="6" height="3" rx="0.5" />
  </svg>
);

const IconAlignRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="14" y1="2" x2="14" y2="14" />
    <rect x="4" y="4" width="8" height="3" rx="0.5" />
    <rect x="7" y="9" width="5" height="3" rx="0.5" />
  </svg>
);

const IconAlignTop = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="2" y1="2" x2="14" y2="2" />
    <rect x="3" y="4" width="3" height="8" rx="0.5" />
    <rect x="8" y="4" width="3" height="5" rx="0.5" />
  </svg>
);

const IconAlignCenterV = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="2" y1="8" x2="14" y2="8" />
    <rect x="3" y="3" width="3" height="10" rx="0.5" />
    <rect x="8" y="5" width="3" height="6" rx="0.5" />
  </svg>
);

const IconAlignBottom = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="2" y1="14" x2="14" y2="14" />
    <rect x="3" y="4" width="3" height="8" rx="0.5" />
    <rect x="8" y="7" width="3" height="5" rx="0.5" />
  </svg>
);

// Action icons
const IconGroup = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="1" width="6" height="6" rx="1" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M7 4H9M12 7V9M4 9V7M9 12H7" strokeDasharray="2 1" />
  </svg>
);

const IconMoreMenu = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="3" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="8" cy="13" r="1.5" />
  </svg>
);

const IconLock = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="10" height="7" rx="1" />
    <path d="M4 6V4C4 2.34315 5.34315 1 7 1C8.65685 1 10 2.34315 10 4V6" />
  </svg>
);

const IconBringToFront = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="5" width="6" height="6" rx="1" opacity="0.4" />
    <rect x="5" y="1" width="8" height="8" rx="1" fill="white" />
    <rect x="5" y="1" width="8" height="8" rx="1" />
  </svg>
);

const IconBringForward = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="5" width="6" height="6" rx="1" />
    <rect x="5" y="1" width="6" height="6" rx="1" fill="white" />
    <rect x="5" y="1" width="6" height="6" rx="1" />
  </svg>
);

const IconSendBackward = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="5" width="6" height="6" rx="1" />
    <rect x="1" y="1" width="6" height="6" rx="1" fill="white" />
    <rect x="1" y="1" width="6" height="6" rx="1" />
  </svg>
);

const IconSendToBack = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="7" y="7" width="6" height="6" rx="1" opacity="0.4" />
    <rect x="1" y="1" width="8" height="8" rx="1" fill="white" />
    <rect x="1" y="1" width="8" height="8" rx="1" />
  </svg>
);

const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="5" width="8" height="8" rx="1" />
    <path d="M3 9H2C1.44772 9 1 8.55228 1 8V2C1 1.44772 1.44772 1 2 1H8C8.55228 1 9 1.44772 9 2V3" />
  </svg>
);

const IconDuplicate = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="9" height="9" rx="1" />
    <rect x="1" y="1" width="9" height="9" rx="1" />
  </svg>
);

const IconDelete = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4H12" />
    <path d="M5 4V2H9V4" />
    <path d="M3 4L4 13H10L11 4" />
    <line x1="6" y1="7" x2="6" y2="10" />
    <line x1="8" y1="7" x2="8" y2="10" />
  </svg>
);

const IconPasteStyle = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="1" width="8" height="12" rx="1" />
    <path d="M6 1V3H8V1" />
    <line x1="5" y1="6" x2="9" y2="6" />
    <line x1="5" y1="9" x2="9" y2="9" />
  </svg>
);

// ============================================================================
// COLOR PALETTE (16 balanced colors for whiteboard)
// ============================================================================

const COLOR_PALETTE = [
  // Row 1: Neutrals + Light
  '#FFFFFF', // White
  '#FEF3C7', // Light yellow
  '#FECACA', // Light red/pink
  '#D1FAE5', // Light green
  // Row 2: Pastels
  '#BFDBFE', // Light blue
  '#DDD6FE', // Light purple
  '#FBCFE8', // Light pink
  '#FED7AA', // Light orange
  // Row 3: Vivid
  '#FACC15', // Yellow
  '#F87171', // Red
  '#34D399', // Green
  '#60A5FA', // Blue
  // Row 4: Deep
  '#A855F7', // Purple
  '#EC4899', // Pink
  '#FB923C', // Orange
  '#1F2937', // Dark gray/black
];

// ============================================================================
// SINGLE OBJECT MENU (Shape/Text selected)
// ============================================================================

interface SingleObjectMenuProps {
  variant?: 'shape' | 'text';
  demo?: boolean;
}

export function SingleObjectMenu({ variant = 'shape', demo = false }: SingleObjectMenuProps) {
  const [showTypeSubmenu, setShowTypeSubmenu] = useState(false);
  const [showFontSubmenu, setShowFontSubmenu] = useState(false);
  const [showBorderSubmenu, setShowBorderSubmenu] = useState(false);
  const [showFillSubmenu, setShowFillSubmenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const [fontSize, setFontSize] = useState(13);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [selectedFont, setSelectedFont] = useState('Noto Sans');
  const [selectedType, setSelectedType] = useState<string>('roundedRect');
  const [borderColor, setBorderColor] = useState('#1F2937');
  const [fillColor, setFillColor] = useState('#BFDBFE');
  const [fillOpacity, setFillOpacity] = useState(100);
  const [borderThickness, setBorderThickness] = useState(2);
  const [borderStyle, setBorderStyle] = useState<'solid' | 'dashed' | 'dotted'>('solid');

  const closeAllSubmenus = () => {
    setShowTypeSubmenu(false);
    setShowFontSubmenu(false);
    setShowBorderSubmenu(false);
    setShowFillSubmenu(false);
    setShowMoreMenu(false);
  };

  const fonts = ['Noto Sans', 'Inter', 'SF Pro', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Georgia'];

  const shapeTypes = [
    { id: 'rectangle', label: 'Rectangle', icon: <IconRectangle /> },
    { id: 'roundedRect', label: 'Rounded', icon: <IconRoundedRect /> },
    { id: 'ellipse', label: 'Ellipse', icon: <IconEllipse /> },
    { id: 'diamond', label: 'Diamond', icon: <IconDiamond /> },
    { id: 'triangle', label: 'Triangle', icon: <IconTriangle /> },
  ];

  const positionStyle = demo
    ? { position: 'relative' as const }
    : { position: 'absolute' as const };

  return (
    <div className="selection-context-menu" style={positionStyle} onClick={(e) => e.stopPropagation()}>
      {/* Shape Type Switcher */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-icon ${showTypeSubmenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowTypeSubmenu(!showTypeSubmenu); }}
          aria-label="Switch shape type"
        >
          {shapeTypes.find(t => t.id === selectedType)?.icon || <IconRoundedRect />}
          <IconChevronDown />
        </button>
        {showTypeSubmenu && (
          <div className="scm-submenu scm-submenu-types">
            {shapeTypes.map((type) => (
              <button
                key={type.id}
                className={`scm-submenu-item ${selectedType === type.id ? 'selected' : ''}`}
                onClick={() => { setSelectedType(type.id); setShowTypeSubmenu(false); }}
              >
                <span className="scm-submenu-icon">{type.icon}</span>
                <span className="scm-submenu-label">{type.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {variant === 'text' && (
        <>
          <div className="scm-divider" />
          {/* Font Selector */}
          <div className="scm-group">
            <button
              className={`scm-btn scm-btn-font ${showFontSubmenu ? 'active' : ''}`}
              onClick={() => { closeAllSubmenus(); setShowFontSubmenu(!showFontSubmenu); }}
            >
              <span className="scm-font-name">{selectedFont}</span>
              <IconChevronDown />
            </button>
            {showFontSubmenu && (
              <div className="scm-submenu scm-submenu-fonts">
                {fonts.map((font) => (
                  <button
                    key={font}
                    className={`scm-submenu-item ${selectedFont === font ? 'selected' : ''}`}
                    onClick={() => { setSelectedFont(font); setShowFontSubmenu(false); }}
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
            <button className="scm-size-btn" onClick={() => setFontSize(prev => Math.max(prev - 1, 6))}>
              <IconChevronDownSmall />
            </button>
            <span className="scm-size-value">{fontSize}</span>
            <button className="scm-size-btn" onClick={() => setFontSize(prev => Math.min(prev + 1, 144))}>
              <IconChevronUp />
            </button>
          </div>

          <div className="scm-divider" />

          {/* Bold / Italic */}
          <div className="scm-group scm-format-group">
            <button
              className={`scm-btn scm-btn-format ${isBold ? 'active' : ''}`}
              onClick={() => setIsBold(!isBold)}
            >
              <span className="scm-format-b">B</span>
            </button>
            <button
              className={`scm-btn scm-btn-format ${isItalic ? 'active' : ''}`}
              onClick={() => setIsItalic(!isItalic)}
            >
              <span className="scm-format-i">I</span>
            </button>
          </div>
        </>
      )}

      <div className="scm-divider" />

      {/* Border Style & Color */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-color scm-btn-border ${showBorderSubmenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowBorderSubmenu(!showBorderSubmenu); }}
          aria-label="Border style and color"
        >
          <span className="scm-color-circle scm-color-border" style={{ borderColor: borderColor }} />
        </button>
        {showBorderSubmenu && (
          <div className="scm-submenu scm-submenu-color">
            <div className="scm-color-section">
              <div className="scm-section-label">Line Style</div>
              <div className="scm-line-styles">
                <button
                  className={`scm-line-style-btn ${borderStyle === 'solid' ? 'selected' : ''}`}
                  onClick={() => setBorderStyle('solid')}
                >
                  <svg width="32" height="2"><line x1="0" y1="1" x2="32" y2="1" stroke="currentColor" strokeWidth="2" /></svg>
                </button>
                <button
                  className={`scm-line-style-btn ${borderStyle === 'dashed' ? 'selected' : ''}`}
                  onClick={() => setBorderStyle('dashed')}
                >
                  <svg width="32" height="2"><line x1="0" y1="1" x2="32" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="6 3" /></svg>
                </button>
                <button
                  className={`scm-line-style-btn ${borderStyle === 'dotted' ? 'selected' : ''}`}
                  onClick={() => setBorderStyle('dotted')}
                >
                  <svg width="32" height="2"><line x1="0" y1="1" x2="32" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" strokeLinecap="round" /></svg>
                </button>
              </div>
            </div>
            <div className="scm-color-section">
              <div className="scm-section-label">Thickness</div>
              <div className="scm-slider-row">
                <input
                  type="range"
                  min="1"
                  max="8"
                  value={borderThickness}
                  onChange={(e) => setBorderThickness(Number(e.target.value))}
                  className="scm-slider"
                />
                <span className="scm-slider-value">{borderThickness}px</span>
              </div>
            </div>
            <div className="scm-color-section">
              <div className="scm-section-label">Color</div>
              <div className="scm-color-grid">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    className={`scm-color-swatch ${borderColor === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setBorderColor(color)}
                    aria-label={`Color ${color}`}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Fill Color & Opacity */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-color scm-btn-fill ${showFillSubmenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowFillSubmenu(!showFillSubmenu); }}
          aria-label="Fill color and opacity"
        >
          <span className="scm-color-circle scm-color-fill" style={{ backgroundColor: fillColor, opacity: fillOpacity / 100 }} />
        </button>
        {showFillSubmenu && (
          <div className="scm-submenu scm-submenu-color">
            <div className="scm-color-section">
              <div className="scm-section-label">Opacity</div>
              <div className="scm-slider-row">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={fillOpacity}
                  onChange={(e) => setFillOpacity(Number(e.target.value))}
                  className="scm-slider"
                />
                <span className="scm-slider-value">{fillOpacity}%</span>
              </div>
            </div>
            <div className="scm-color-section">
              <div className="scm-section-label">All colors</div>
              <div className="scm-color-grid">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    className={`scm-color-swatch ${fillColor === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setFillColor(color)}
                    aria-label={`Color ${color}`}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="scm-divider" />

      {/* 3-dot More Menu */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-icon scm-btn-more ${showMoreMenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowMoreMenu(!showMoreMenu); }}
          aria-label="More options"
        >
          <IconMoreMenu />
        </button>
        {showMoreMenu && <MoreMenuDropdown />}
      </div>
    </div>
  );
}

// ============================================================================
// MIXED SELECTION MENU (Multiple different object types)
// ============================================================================

interface ObjectTypeCount {
  type: 'pen' | 'shape' | 'connector' | 'text';
  count: number;
}

interface MixedSelectionMenuProps {
  objectCounts?: ObjectTypeCount[];
  demo?: boolean;
}

export function MixedSelectionMenu({
  objectCounts = [
    { type: 'pen', count: 1 },
    { type: 'shape', count: 1 },
    { type: 'connector', count: 1 },
  ],
  demo = false
}: MixedSelectionMenuProps) {
  const [showFilterSubmenu, setShowFilterSubmenu] = useState(false);
  const [showAlignSubmenu, setShowAlignSubmenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const totalCount = objectCounts.reduce((sum, o) => sum + o.count, 0);

  const closeAllSubmenus = () => {
    setShowFilterSubmenu(false);
    setShowAlignSubmenu(false);
    setShowMoreMenu(false);
  };

  const typeIcons: Record<string, React.ReactNode> = {
    pen: <IconPen />,
    shape: <IconShape />,
    connector: <IconConnector />,
    text: <span style={{ fontWeight: 600, fontSize: 12 }}>T</span>,
  };

  const typeLabels: Record<string, string> = {
    pen: 'Pen',
    shape: 'Shape',
    connector: 'Connection line',
    text: 'Text',
  };

  const positionStyle = demo ? { position: 'relative' as const } : { position: 'absolute' as const };

  return (
    <div className="selection-context-menu" style={positionStyle} onClick={(e) => e.stopPropagation()}>
      {/* Filter Dropdown */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-filter ${showFilterSubmenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowFilterSubmenu(!showFilterSubmenu); }}
        >
          <span className="scm-filter-label">
            <span className="scm-filter-title">Filter</span>
            <span className="scm-filter-count">{totalCount} objects</span>
          </span>
          <IconChevronDown />
        </button>
        {showFilterSubmenu && (
          <div className="scm-submenu scm-submenu-filter">
            {objectCounts.map((item) => (
              <button key={item.type} className="scm-submenu-item scm-filter-item">
                <span className="scm-submenu-icon">{typeIcons[item.type]}</span>
                <span className="scm-submenu-label">{typeLabels[item.type]}</span>
                <span className="scm-filter-num">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="scm-divider" />

      {/* Align Button */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-icon ${showAlignSubmenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowAlignSubmenu(!showAlignSubmenu); }}
          aria-label="Align objects"
        >
          <IconAlignLeft />
        </button>
        {showAlignSubmenu && (
          <div className="scm-submenu scm-submenu-align">
            <div className="scm-align-section">
              <div className="scm-section-label">Horizontal</div>
              <div className="scm-align-row">
                <button className="scm-align-btn" aria-label="Align left"><IconAlignLeft /></button>
                <button className="scm-align-btn" aria-label="Align center horizontally"><IconAlignCenterH /></button>
                <button className="scm-align-btn" aria-label="Align right"><IconAlignRight /></button>
              </div>
            </div>
            <div className="scm-align-section">
              <div className="scm-section-label">Vertical</div>
              <div className="scm-align-row">
                <button className="scm-align-btn" aria-label="Align top"><IconAlignTop /></button>
                <button className="scm-align-btn" aria-label="Align center vertically"><IconAlignCenterV /></button>
                <button className="scm-align-btn" aria-label="Align bottom"><IconAlignBottom /></button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Group Button */}
      <button className="scm-btn scm-btn-icon" aria-label="Group objects">
        <IconGroup />
      </button>

      <div className="scm-divider" />

      {/* 3-dot More Menu */}
      <div className="scm-group">
        <button
          className={`scm-btn scm-btn-icon scm-btn-more ${showMoreMenu ? 'active' : ''}`}
          onClick={() => { closeAllSubmenus(); setShowMoreMenu(!showMoreMenu); }}
          aria-label="More options"
        >
          <IconMoreMenu />
        </button>
        {showMoreMenu && <MoreMenuDropdown />}
      </div>
    </div>
  );
}

// ============================================================================
// MORE MENU DROPDOWN (shared)
// ============================================================================

function MoreMenuDropdown() {
  return (
    <div className="scm-submenu scm-submenu-more">
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconPasteStyle /></span>
        <span className="scm-submenu-label">Paste style</span>
      </button>
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconLock /></span>
        <span className="scm-submenu-label">Lock</span>
      </button>
      <div className="scm-submenu-divider" />
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconBringToFront /></span>
        <span className="scm-submenu-label">Bring to front</span>
      </button>
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconBringForward /></span>
        <span className="scm-submenu-label">Bring forward</span>
      </button>
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconSendBackward /></span>
        <span className="scm-submenu-label">Send backward</span>
      </button>
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconSendToBack /></span>
        <span className="scm-submenu-label">Send to back</span>
      </button>
      <div className="scm-submenu-divider" />
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconCopy /></span>
        <span className="scm-submenu-label">Copy</span>
        <span className="scm-shortcut">Ctrl+C</span>
      </button>
      <button className="scm-submenu-item">
        <span className="scm-submenu-icon"><IconDuplicate /></span>
        <span className="scm-submenu-label">Duplicate</span>
        <span className="scm-shortcut">Ctrl+D</span>
      </button>
      <div className="scm-submenu-divider" />
      <button className="scm-submenu-item scm-item-danger">
        <span className="scm-submenu-icon"><IconDelete /></span>
        <span className="scm-submenu-label">Delete</span>
        <span className="scm-shortcut">Del</span>
      </button>
    </div>
  );
}

// ============================================================================
// LEGACY EXPORT (for backwards compatibility)
// ============================================================================

export function SelectionContextMenu({ x: _x = 0, y: _y = 0, demo = false }: { x?: number; y?: number; demo?: boolean }) {
  return <SingleObjectMenu variant="shape" demo={demo} />;
}

// ============================================================================
// DEMO COMPONENT (shows all menu variants)
// ============================================================================

export function SelectionContextMenuDemo() {
  return (
    <div className="scm-demo-container">
      <h1 className="scm-demo-title">Selection Context Menu - UI Spec</h1>

      <div className="scm-demo-grid">
        {/* Shape Menu */}
        <div className="scm-demo-panel">
          <h3 className="scm-demo-panel-title">Shape Selected</h3>
          <p className="scm-demo-panel-desc">Single shape object selected</p>
          <div className="scm-demo-menu-wrap">
            <SingleObjectMenu variant="shape" demo />
          </div>
        </div>

        {/* Text Menu */}
        <div className="scm-demo-panel">
          <h3 className="scm-demo-panel-title">Text Selected</h3>
          <p className="scm-demo-panel-desc">Text object with font controls</p>
          <div className="scm-demo-menu-wrap">
            <SingleObjectMenu variant="text" demo />
          </div>
        </div>

        {/* Mixed Selection Menu */}
        <div className="scm-demo-panel">
          <h3 className="scm-demo-panel-title">Mixed Selection</h3>
          <p className="scm-demo-panel-desc">Multiple different object types</p>
          <div className="scm-demo-menu-wrap">
            <MixedSelectionMenu demo />
          </div>
        </div>

        {/* Mixed with more objects */}
        <div className="scm-demo-panel">
          <h3 className="scm-demo-panel-title">Large Mixed Selection</h3>
          <p className="scm-demo-panel-desc">Many objects of various types</p>
          <div className="scm-demo-menu-wrap">
            <MixedSelectionMenu
              objectCounts={[
                { type: 'pen', count: 5 },
                { type: 'shape', count: 3 },
                { type: 'connector', count: 2 },
                { type: 'text', count: 4 },
              ]}
              demo
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default SelectionContextMenu;
