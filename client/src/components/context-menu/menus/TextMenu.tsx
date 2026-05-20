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
import { ColorPickerPopover } from '../ColorPickerPopover';
import { NO_FILL } from '../color-palette';
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
  fillColorSecond: s.selectedStyles.fillColorSecond,
});

export const TextMenu = memo(function TextMenu() {
  const { fontSize, labelColor, fillColor, fillColorMixed, fillColorSecond } = useSelectionStore(useShallow(selectTextStyles));
  const effectiveColor = labelColor ?? '#262626';
  return (
    <>
      <ShapeTypeDropdown mode="text" />
      <div className="ctx-divider" />
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
        <div className="ctx-divider" />
        <AlignDropdown />
        <div className="ctx-divider" />
        <TextColorPopover color={effectiveColor} onSelect={setSelectedTextColor} />
        <HighlightPickerPopover onSelect={setSelectedHighlight} />
        <div className="ctx-divider" />
        <ColorPickerPopover
          color={fillColor ?? '#fff'}
          variant={fillColor === null && !fillColorMixed ? 'none' : 'filled'}
          secondColor={fillColorMixed ? fillColorSecond : undefined}
          mode="fill"
          selectedColor={fillColor}
          onSelect={(c) => setSelectedFillColor(c === NO_FILL ? null : c)}
        />
      </ButtonGroup>
    </>
  );
});
