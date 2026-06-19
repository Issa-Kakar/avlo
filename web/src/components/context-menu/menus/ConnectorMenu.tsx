import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ConnectorType } from '@/core/types/objects';
import { selectTextColor, selectTextSize, useDeviceUIStore } from '@/stores/device-ui-store';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import {
  decrementFontSize,
  incrementFontSize,
  setSelectedColor,
  setSelectedEndCap,
  setSelectedFontSize,
  setSelectedStartCap,
  setSelectedTextColor,
  setSelectedWidth,
} from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { ConnectorCapControl } from '../ConnectorCapControl';
import { ConnectorTypeControl } from '../ConnectorTypeControl';
import { FontSizeStepper } from '../FontSizeStepper';
import { LabelButton } from '../LabelButton';
import { OUTLINE_WIDTHS } from '../menu-widths';
import { StrokeColorControl } from '../StrokeColorControl';
import { StrokeWidthControl } from '../StrokeWidthControl';
import { TextColorPopover } from '../TextColorPopover';
import { TypefaceButton } from '../TypefaceButton';

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
  startCap: s.selectedStyles.startCap,
  endCap: s.selectedStyles.endCap,
  // Labels attach to a single connector — multi-select has no meaningful target,
  // so the label slot stays hidden until exactly one connector is selected.
  singleConnector: s.kindCounts.total === 1,
  // hasLabel drives the "Add label" button ⇄ live text controls swap; labelColor
  // and fontSize feed those controls (fontFamily is self-subscribed by TypefaceButton).
  hasLabel: s.selectedStyles.connectorHasLabel,
  labelColor: s.selectedStyles.labelColor,
  fontSize: s.selectedStyles.fontSize,
});

export const ConnectorMenu = memo(function ConnectorMenu() {
  const { color, colorMixed, width, connectorType, startCap, endCap, singleConnector, hasLabel, labelColor, fontSize } = useSelectionStore(
    useShallow(selectConnectorStyles),
  );
  // Coalesce for the labeled connector's text controls. A labeled connector always
  // carries labelColor + fontSize, so these fall back only as a null-safety floor —
  // sourced from the device-ui text defaults the label would otherwise inherit.
  const deviceTextColor = useDeviceUIStore(selectTextColor);
  const deviceTextSize = useDeviceUIStore(selectTextSize);
  return (
    <ButtonGroup>
      <StrokeColorControl color={color} mixed={colorMixed} onSelect={setSelectedColor} />
      <div className="ctx-divider" />
      <StrokeWidthControl widths={OUTLINE_WIDTHS} value={width} onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <ConnectorCapControl slot="start" value={startCap} onSelect={setSelectedStartCap} />
      <ConnectorCapControl slot="end" value={endCap} onSelect={setSelectedEndCap} />
      <div className="ctx-divider" />
      <ConnectorTypeControl value={connectorType} onSelect={setSelectedConnectorTypeNoop} />
      {singleConnector && (
        <>
          <div className="ctx-divider" />
          {hasLabel ? (
            <>
              <TextColorPopover color={labelColor ?? deviceTextColor} onSelect={setSelectedTextColor} />
              <TypefaceButton />
              <FontSizeStepper
                value={fontSize ?? deviceTextSize}
                onDecrement={decrementFontSize}
                onIncrement={incrementFontSize}
                onSelectSize={setSelectedFontSize}
              />
            </>
          ) : (
            <LabelButton />
          )}
        </>
      )}
    </ButtonGroup>
  );
});
