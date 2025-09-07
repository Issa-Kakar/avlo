import React, { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useDeviceUIStore } from '../../stores/device-ui-store';

interface ColorSizeDockProps {
  className?: string;
}

// HSV color utilities for full spectrum
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r: number, g: number, b: number;

  if (h < 60) {
    [r, g, b] = [c, x, 0];
  } else if (h < 120) {
    [r, g, b] = [x, c, 0];
  } else if (h < 180) {
    [r, g, b] = [0, c, x];
  } else if (h < 240) {
    [r, g, b] = [0, x, c];
  } else if (h < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;

  let h = 0;
  const s = max === 0 ? 0 : diff / max;
  const v = max;

  if (diff !== 0) {
    if (max === r) {
      h = ((g - b) / diff) % 6;
    } else if (max === g) {
      h = (b - r) / diff + 2;
    } else {
      h = (r - g) / diff + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return [h, s, v];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.substring(0, 2), 16),
    parseInt(value.substring(2, 4), 16),
    parseInt(value.substring(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Predefined common colors with their hue values
const _COMMON_COLORS = [
  { name: 'Black', hex: '#000000', hue: 0 },
  { name: 'Red', hex: '#FF0000', hue: 0 },
  { name: 'Orange', hex: '#FF8C00', hue: 33 },
  { name: 'Yellow', hex: '#FFD700', hue: 51 },
  { name: 'Green', hex: '#32CD32', hue: 120 },
  { name: 'Cyan', hex: '#00CED1', hue: 180 },
  { name: 'Blue', hex: '#1E90FF', hue: 210 },
  { name: 'Purple', hex: '#9932CC', hue: 280 },
  { name: 'Pink', hex: '#FF69B4', hue: 330 },
  { name: 'White', hex: '#FFFFFF', hue: 0 },
];

export function ColorSizeDock({ className = '' }: ColorSizeDockProps) {
  const { activeTool, pen, highlighter, setPenSettings, setHighlighterSettings } =
    useDeviceUIStore();

  // Auto-hide state
  const [isVisible, setIsVisible] = useState(true);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show dock only for pen/highlighter
  const showDock = activeTool === 'pen' || activeTool === 'highlighter';
  const currentSettings = activeTool === 'pen' ? pen : highlighter;

  // Reset visibility and timer when tool changes to pen/highlighter
  useEffect(() => {
    if (showDock) {
      setIsVisible(true);

      // Clear existing timer
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
      }

      // Set new timer to hide after 5 seconds
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 5000);

      autoHideTimerRef.current = timer;
    } else {
      // Clear timer when switching away from pen/highlighter
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
      setIsVisible(false);
    }

    return () => {
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
      }
    };
  }, [activeTool, showDock]);

  // Show dock temporarily on interaction
  const handleInteraction = useCallback(() => {
    if (!showDock) return;

    setIsVisible(true);

    // Clear existing timer
    if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
    }

    // Set new timer (5 seconds)
    const timer = setTimeout(() => {
      setIsVisible(false);
    }, 5000);

    autoHideTimerRef.current = timer;
  }, [showDock]);

  // Convert color to slider value (0-359 for hue)
  const getSliderValueFromColor = useCallback((color: string): number => {
    const rgb = hexToRgb(color);
    const [r, g, b] = rgb;

    // Special cases for black and white
    if (r === 0 && g === 0 && b === 0) return 0; // Black
    if (r === 255 && g === 255 && b === 255) return 360; // White (map to end)

    // For other colors, get the hue from HSV
    const [h] = rgbToHsv(r, g, b);
    return Math.round(h);
  }, []);

  // Convert slider value (0-360) to color
  const getColorFromSliderValue = useCallback((value: number): string => {
    if (value === 0) {
      return '#000000'; // Black
    }
    if (value >= 360) {
      return '#FFFFFF'; // White
    }

    // Generate color from hue with full saturation and value
    const [r, g, b] = hsvToRgb(value, 1.0, 1.0);
    return rgbToHex(r, g, b);
  }, []);

  const currentColorValue = useMemo(
    () => getSliderValueFromColor(currentSettings.color),
    [currentSettings.color, getSliderValueFromColor],
  );

  const handleColorChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(event.target.value, 10);
      const newColor = getColorFromSliderValue(value);

      if (activeTool === 'pen') {
        setPenSettings({ color: newColor });
      } else if (activeTool === 'highlighter') {
        setHighlighterSettings({ color: newColor });
      }

      handleInteraction();
    },
    [
      activeTool,
      getColorFromSliderValue,
      setPenSettings,
      setHighlighterSettings,
      handleInteraction,
    ],
  );

  const handleSizeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const size = parseInt(event.target.value, 10);

      if (activeTool === 'pen') {
        setPenSettings({ size });
      } else if (activeTool === 'highlighter') {
        setHighlighterSettings({ size });
      }

      handleInteraction();
    },
    [activeTool, setPenSettings, setHighlighterSettings, handleInteraction],
  );

  if (!showDock) {
    return null;
  }

  return (
    <div
      className={`tool-dock ${isVisible ? 'show' : 'hide'} ${className}`}
      aria-label="Drawing settings"
      onMouseEnter={handleInteraction}
    >
      <div className="dock-group">
        <span className="dock-label">Color</span>
        <div className="color-picker-container">
          <div className="color-slider-wrapper" style={{ position: 'relative', height: 28 }}>
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                height: 10,
                borderRadius: 6,
                background:
                  'linear-gradient(90deg, #000000 0%, #ff0000 2.5%, #ffff00 19.5%, #00ff00 36%, #00ffff 52.5%, #0000ff 69%, #ff00ff 85%, #ff0000 97.5%, #ffffff 100%)',
                boxShadow: 'inset 0 0 0 1px var(--border-default, rgba(0,0,0,0.2))',
              }}
            />

            <div
              className="color-display-box"
              title={`Current color: ${currentSettings.color}`}
              style={{
                position: 'absolute',
                left: `clamp(0px, calc(${(currentColorValue / 360) * 100}% - 14px), calc(100% - 28px))`,
                bottom: '100%',
                transform: 'translateY(-8px)',
                width: 28,
                height: 18,
                backgroundColor: currentSettings.color,
                border: '1px solid var(--border-default, rgba(0,0,0,0.2))',
                borderRadius: 4,
                pointerEvents: 'none',
              }}
            />

            <div
              className="color-indicator-rect"
              aria-hidden
              style={{
                position: 'absolute',
                left: `clamp(0px, calc(${(currentColorValue / 360) * 100}% - 6px), calc(100% - 12px))`,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 12,
                height: 10,
                background: 'transparent',
                border: '2px solid var(--text-primary, #333)',
                borderRadius: 3,
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />

            <input
              type="range"
              className="dock-slider color"
              min="0"
              max="360"
              value={currentColorValue}
              onChange={handleColorChange}
              aria-label="Color spectrum slider"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                width: '100%',
                height: '100%',
                background: 'transparent',
                opacity: 0,
                zIndex: 3,
                cursor: 'pointer',
              }}
            />
          </div>
        </div>
      </div>

      <div className="dock-group">
        <span className="dock-label">Size</span>
        <input
          type="range"
          className="dock-slider size"
          min="1"
          max="20"
          value={currentSettings.size}
          onChange={handleSizeChange}
          aria-label="Brush size"
        />
        <span className="size-readout" aria-label="Size in pixels">
          {currentSettings.size}px
        </span>
      </div>
    </div>
  );
}
