import { memo, useMemo } from 'react';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import * as A from './actions';
import { ColorSlots } from './ColorSlots';
import { CONNECTOR_VARIANTS } from './constants';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const NOOP = () => {};

export function ConnectorInspector() {
  const variant = useDeviceUIStore((s) => s.connectorVariant);
  const color = useDeviceUIStore((s) => s.connectorColor);
  const isPickerOpen = useDeviceUIStore((s) => s.isColorPickerOpen);

  // Stable single-element tuple so ColorSlots's React.memo holds across renders.
  const colors = useMemo<readonly [string]>(() => [color], [color]);

  return (
    <div className="inspector inspector-connector">
      {CONNECTOR_VARIANTS.map(({ id, label }) => (
        <InspectorButton key={id} isActive={variant === id} ariaLabel={label} onClick={VARIANT_HANDLERS[id]}>
          <ConnectorVariantIcon variant={id} />
        </InspectorButton>
      ))}

      <div className="inspector-divider" />

      <ColorSlots
        colors={colors}
        activeIndex={0}
        isPickerOpen={isPickerOpen}
        onSelectSlot={NOOP}
        onTogglePicker={A.toggleColorPicker}
        onPickColor={A.setConnectorColor}
        onClosePicker={A.closeColorPicker}
      />
    </div>
  );
}

const VARIANT_HANDLERS: Record<'straight' | 'doubleArrow' | 'elbow', () => void> = {
  straight: () => A.setConnectorVariant('straight'),
  doubleArrow: () => A.setConnectorVariant('doubleArrow'),
  elbow: () => A.setConnectorVariant('elbow'),
};

interface VariantIconProps {
  variant: 'straight' | 'doubleArrow' | 'elbow';
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
  if (variant === 'straight') {
    return (
      <svg className="insp-icon" viewBox="0 0 24 24" aria-hidden="true">
        <line x1="4" y1="12" x2="20" y2="12" {...VARIANT_STROKE} />
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
