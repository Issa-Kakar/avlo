import { type FC, type SVGProps, useCallback, useState } from 'react';
import { selectConnector, setConnectorColor, setConnectorMode, useDeviceUIStore } from '@/stores/device-ui-store';
import { ColorField } from '../color/ColorField';
import { CONNECTOR_VARIANT_IDS, CONNECTOR_VARIANT_SPECS, type ConnectorVariantId, deriveConnectorVariant } from '../connector-variants';
import { IconConnectorArrow, IconConnectorDoubleArrow, IconConnectorElbow, IconConnectorLine } from '../icons';
import { InspectorButton } from './InspectorButton';
import './Inspector.css';

const VARIANT_HANDLERS: Record<ConnectorVariantId, () => void> = {
  line: () => setConnectorMode('line'),
  arrow: () => setConnectorMode('arrow'),
  doubleArrow: () => setConnectorMode('doubleArrow'),
  elbow: () => setConnectorMode('elbow'),
};

const VARIANT_ICONS: Record<ConnectorVariantId, FC<SVGProps<SVGSVGElement>>> = {
  line: IconConnectorLine,
  arrow: IconConnectorArrow,
  doubleArrow: IconConnectorDoubleArrow,
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
