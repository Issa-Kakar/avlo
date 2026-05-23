import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedColor, setSelectedWidth } from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { STROKE_WIDTHS } from '../menu-widths';
import { StrokeColorControl } from '../StrokeColorControl';
import { StrokeWidthControl } from '../StrokeWidthControl';

const selectStrokeStyles = (s: SelectionStore) => ({
  // SelectedStyles.color is nullable (no-stroke shapes); strokes are never
  // null at runtime — coalesce so StrokeColorControl's string prop stays honest.
  color: s.selectedStyles.color ?? '#262626',
  colorMixed: s.selectedStyles.colorMixed,
  width: s.selectedStyles.width,
});

export const StrokeMenu = memo(function StrokeMenu() {
  const { color, colorMixed, width } = useSelectionStore(useShallow(selectStrokeStyles));
  return (
    <ButtonGroup>
      <StrokeWidthControl widths={STROKE_WIDTHS} value={width} onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <StrokeColorControl color={color} mixed={colorMixed} onSelect={setSelectedColor} />
    </ButtonGroup>
  );
});
