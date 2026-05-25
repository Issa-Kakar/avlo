import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConnectorType } from '@/core/types/objects';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedColor, setSelectedWidth } from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { ConnectorTypeControl } from '../ConnectorTypeControl';
import { LabelButton } from '../LabelButton';
import { OUTLINE_WIDTHS } from '../menu-widths';
import { StrokeColorControl } from '../StrokeColorControl';
import { StrokeWidthControl } from '../StrokeWidthControl';

// No-op placeholder for connector-type switching — routing changes require
// endpoint/anchor recomputation that lives in the connector subsystem; wiring
// the action lands separately. The trigger reads the live `connectorType`
// style and rebuilds on selection-store change.
const setSelectedConnectorTypeNoop = (_: ConnectorType) => {};

const selectConnectorStyles = (s: SelectionStore) => ({
  // SelectedStyles.color is nullable (no-stroke shapes); connectors are never
  // null at runtime — coalesce so StrokeColorControl's string prop stays honest.
  color: s.selectedStyles.color ?? '#262626',
  colorMixed: s.selectedStyles.colorMixed,
  width: s.selectedStyles.width,
  connectorType: s.selectedStyles.connectorType,
});

export const ConnectorMenu = memo(function ConnectorMenu() {
  const { color, colorMixed, width, connectorType } = useSelectionStore(useShallow(selectConnectorStyles));
  return (
    <ButtonGroup>
      <StrokeColorControl color={color} mixed={colorMixed} onSelect={setSelectedColor} />
      <div className="ctx-divider" />
      <StrokeWidthControl widths={OUTLINE_WIDTHS} value={width} onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <ConnectorTypeControl value={connectorType} onSelect={setSelectedConnectorTypeNoop} />
      <div className="ctx-divider" />
      <LabelButton />
    </ButtonGroup>
  );
});
