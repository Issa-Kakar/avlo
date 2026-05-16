import { type FC, type SVGProps, useCallback, useState } from 'react';
import { selectConnector, setConnectorColor, setConnectorMode, useDeviceUIStore } from '@/stores/device-ui-store';
import { ColorField } from '../color/ColorField';
import { CONNECTOR_VARIANT_IDS, CONNECTOR_VARIANT_SPECS, type ConnectorVariantId, deriveConnectorVariant } from '../connector-variants';
import { IconConnectorElbow, IconConnectorLine } from '../icons/ConnectorVariantIcons';
import { IconArrow } from '../icons/IconArrow';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const VARIANT_HANDLERS: Record<ConnectorVariantId, () => void> = {
  line: () => setConnectorMode('line'),
  arrow: () => setConnectorMode('arrow'),
  elbow: () => setConnectorMode('elbow'),
};

// `arrow` reuses the toolbar's connector tool icon — the chunky diagonal shaft +
// lug-corner arrowhead. The line/elbow icons share its / diagonal language so
// the three button states read as a coherent family.
const VARIANT_ICONS: Record<ConnectorVariantId, FC<SVGProps<SVGSVGElement>>> = {
  line: IconConnectorLine,
  arrow: IconArrow,
  elbow: IconConnectorElbow,
};

export function ConnectorInspector() {
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // One cluster selector covers all four fields we read.
  const { type, startCap, endCap, color } = useDeviceUIStore(selectConnector);
  const activeVariant = deriveConnectorVariant(type, startCap, endCap);

  const handlePick = useCallback((c: string) => {
    setConnectorColor(c);
    setIsPickerOpen(false);
  }, []);
  const handleToggle = useCallback(() => setIsPickerOpen((v) => !v), []);
  const handleClose = useCallback(() => setIsPickerOpen(false), []);

  return (
    <div className="inspector inspector-connector">
      {CONNECTOR_VARIANT_IDS.map((id) => {
        const Icon = VARIANT_ICONS[id];
        return (
          <InspectorButton
            key={id}
            isActive={id === activeVariant}
            ariaLabel={CONNECTOR_VARIANT_SPECS[id].label}
            onClick={VARIANT_HANDLERS[id]}
          >
            <Icon className="insp-icon" />
          </InspectorButton>
        );
      })}

      <div className="inspector-divider" />

      <ColorField
        color={color}
        isPickerOpen={isPickerOpen}
        onTogglePicker={handleToggle}
        onPickColor={handlePick}
        onClosePicker={handleClose}
      />
    </div>
  );
}
