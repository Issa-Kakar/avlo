import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedColor, setSelectedWidth } from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { OUTLINE_WIDTHS } from '../menu-widths';
import { StrokeColorControl } from '../StrokeColorControl';
import { StrokeWidthControl } from '../StrokeWidthControl';

const selectConnectorStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
  width: s.selectedStyles.width,
});

export const ConnectorMenu = memo(function ConnectorMenu() {
  const { color, colorMixed, width } = useSelectionStore(useShallow(selectConnectorStyles));
  return (
    <ButtonGroup>
      <StrokeWidthControl widths={OUTLINE_WIDTHS} value={width} onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <StrokeColorControl color={color} mixed={colorMixed} onSelect={setSelectedColor} />
    </ButtonGroup>
  );
});
