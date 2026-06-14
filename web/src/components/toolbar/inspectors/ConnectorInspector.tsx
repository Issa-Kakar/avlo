import { type FC, type SVGProps, useCallback, useState } from 'react';
import { selectConnector, setConnectorColor, setConnectorMode, setConnectorWidth, useDeviceUIStore } from '@/stores/device-ui-store';
import { ColorField } from '../color/ColorField';
import { CONNECTOR_VARIANT_IDS, CONNECTOR_VARIANT_SPECS, type ConnectorVariantId, deriveConnectorVariant } from '../connector-variants';
import { IconConnectorElbow, IconConnectorLine } from '../icons/ConnectorVariantIcons';
import { IconArrow } from '../icons/IconArrow';
import { CONNECTOR_WEIGHTS } from '../weights';
import { InspectorButton } from './InspectorButton';
import { WeightField } from './WeightField';
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

// At most one popout open at a time. Cross-picker switching is order-safe:
// usePickerDismiss closes the old one on mousedown before the toggle opens
// the new one on click.
type OpenPicker = 'weight' | 'color' | null;

export function ConnectorInspector() {
  const [openPicker, setOpenPicker] = useState<OpenPicker>(null);

  // One cluster selector covers all five fields we read.
  const { type, startCap, endCap, color, width } = useDeviceUIStore(selectConnector);
  const activeVariant = deriveConnectorVariant(type, startCap, endCap);

  const handleToggleWeight = useCallback(() => setOpenPicker((v) => (v === 'weight' ? null : 'weight')), []);
  const handleToggleColor = useCallback(() => setOpenPicker((v) => (v === 'color' ? null : 'color')), []);
  const handleClosePicker = useCallback(() => setOpenPicker(null), []);

  const handlePickColor = useCallback((c: string) => {
    setConnectorColor(c);
    setOpenPicker(null);
  }, []);
  const handleChangeWidth = useCallback((w: number) => {
    setConnectorWidth(w);
    setOpenPicker(null);
  }, []);

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

      <WeightField
        presets={CONNECTOR_WEIGHTS}
        value={width}
        isPickerOpen={openPicker === 'weight'}
        onTogglePicker={handleToggleWeight}
        onChangeWidth={handleChangeWidth}
        onClosePicker={handleClosePicker}
      />

      <div className="inspector-divider" />

      <ColorField
        color={color}
        isPickerOpen={openPicker === 'color'}
        onTogglePicker={handleToggleColor}
        onPickColor={handlePickColor}
        onClosePicker={handleClosePicker}
      />
    </div>
  );
}
