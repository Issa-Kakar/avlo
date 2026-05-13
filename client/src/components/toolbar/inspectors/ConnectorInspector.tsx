import { memo, useCallback, useMemo, useState } from 'react';
import { selectConnector, setConnectorColor, setConnectorMode, useDeviceUIStore } from '@/stores/device-ui-store';
import { ColorSlots } from '../color/ColorSlots';
import { CONNECTOR_VARIANT_IDS, CONNECTOR_VARIANT_SPECS, type ConnectorVariantId, deriveConnectorVariant } from '../connector-variants';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const VARIANT_HANDLERS: Record<ConnectorVariantId, () => void> = {
  line: () => setConnectorMode('line'),
  arrow: () => setConnectorMode('arrow'),
  doubleArrow: () => setConnectorMode('doubleArrow'),
  elbow: () => setConnectorMode('elbow'),
};

export function ConnectorInspector() {
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // One cluster selector covers all four fields we read.
  const { type, startCap, endCap, color } = useDeviceUIStore(selectConnector);
  const activeVariant = deriveConnectorVariant(type, startCap, endCap);

  // Stable single-element tuple so ColorSlots's React.memo holds across renders.
  const colors = useMemo<readonly [string]>(() => [color], [color]);

  const handlePick = useCallback((c: string) => {
    setConnectorColor(c);
    setIsPickerOpen(false);
  }, []);
  const handleToggle = useCallback(() => setIsPickerOpen((v) => !v), []);
  const handleClose = useCallback(() => setIsPickerOpen(false), []);

  return (
    <div className="inspector inspector-connector">
      {CONNECTOR_VARIANT_IDS.map((id) => (
        <InspectorButton
          key={id}
          isActive={id === activeVariant}
          ariaLabel={CONNECTOR_VARIANT_SPECS[id].label}
          onClick={VARIANT_HANDLERS[id]}
        >
          <ConnectorVariantIcon variant={id} />
        </InspectorButton>
      ))}

      <div className="inspector-divider" />

      <ColorSlots
        colors={colors}
        activeIndex={0}
        isPickerOpen={isPickerOpen}
        onTogglePicker={handleToggle}
        onPickColor={handlePick}
        onClosePicker={handleClose}
      />
    </div>
  );
}

interface VariantIconProps {
  variant: ConnectorVariantId;
}

// Crude placeholder geometry — to be redesigned. For now each path is
// laid out so its bbox center sits at (12, 12) inside the 0-24 viewBox.
const VARIANT_STROKE = {
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

const ConnectorVariantIcon = memo(function ConnectorVariantIcon({ variant }: VariantIconProps) {
  if (variant === 'line') {
    return (
      <svg className="insp-icon" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="4" y1="12" x2="20" y2="12" {...VARIANT_STROKE} />
      </svg>
    );
  }
  if (variant === 'arrow') {
    return (
      <svg className="insp-icon" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="4" y1="12" x2="18" y2="12" {...VARIANT_STROKE} />
        <path d="M15 9L18 12L15 15" {...VARIANT_STROKE} />
      </svg>
    );
  }
  if (variant === 'doubleArrow') {
    return (
      <svg className="insp-icon" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="6" y1="12" x2="18" y2="12" {...VARIANT_STROKE} />
        <path d="M9 9L6 12L9 15" {...VARIANT_STROKE} />
        <path d="M15 9L18 12L15 15" {...VARIANT_STROKE} />
      </svg>
    );
  }
  // Elbow w/ end-cap arrow. bbox x[6,18], y[8,16] → center (12, 12).
  return (
    <svg className="insp-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8H13C14.1046 8 15 8.8954 15 10V16" {...VARIANT_STROKE} />
      <path d="M12 13L15 16L18 13" {...VARIANT_STROKE} />
    </svg>
  );
});
