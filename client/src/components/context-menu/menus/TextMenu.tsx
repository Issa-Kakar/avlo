import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import {
  decrementFontSize,
  incrementFontSize,
  setSelectedFillColor,
  setSelectedFontSize,
  setSelectedHighlight,
  setSelectedTextColor,
} from '@/tools/selection/selection-actions';
import { AlignDropdown } from '../AlignDropdown';
import { ButtonGroup } from '../ButtonGroup';
import { FillColorControl } from '../FillColorControl';
import { FontSizeStepper } from '../FontSizeStepper';
import { BoldButton, ItalicButton } from '../FormatButtons';
import { HighlightPickerPopover } from '../HighlightPickerPopover';
import { ShapeTypeDropdown } from '../ShapeTypeDropdown';
import { TextColorPopover } from '../TextColorPopover';
import { TypefaceButton } from '../TypefaceButton';

const selectTextStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  labelColor: s.selectedStyles.labelColor,
  fillColor: s.selectedStyles.fillColor,
  fillColorMixed: s.selectedStyles.fillColorMixed,
});

export const TextMenu = memo(function TextMenu() {
  const { fontSize, labelColor, fillColor, fillColorMixed } = useSelectionStore(useShallow(selectTextStyles));
  const effectiveColor = labelColor ?? '#262626';
  return (
    <ButtonGroup>
      <TypefaceButton />
      <div className="ctx-divider" />
      {fontSize !== null && (
        <FontSizeStepper
          value={fontSize}
          onDecrement={decrementFontSize}
          onIncrement={incrementFontSize}
          onSelectSize={setSelectedFontSize}
        />
      )}
      <div className="ctx-divider" />
      <BoldButton />
      <ItalicButton />
      <AlignDropdown />
      <TextColorPopover color={effectiveColor} onSelect={setSelectedTextColor} />
      <HighlightPickerPopover onSelect={setSelectedHighlight} />
      <div className="ctx-divider" />
      <FillColorControl fillColor={fillColor} mixed={fillColorMixed} onSelect={setSelectedFillColor} />
      <div className="ctx-divider" />
      <ShapeTypeDropdown mode="text" />
    </ButtonGroup>
  );
});
