import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectTextColor, selectTextSize, useDeviceUIStore } from '@/stores/device-ui-store';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import {
  decrementFontSize,
  incrementFontSize,
  setSelectedColor,
  setSelectedFillColor,
  setSelectedFontSize,
  setSelectedHighlight,
  setSelectedTextColor,
  setSelectedWidth,
} from '@/tools/selection/selection-actions';
import { BorderColorControl } from '../BorderColorControl';
import { ButtonGroup } from '../ButtonGroup';
import { FillColorControl } from '../FillColorControl';
import { FontSizeStepper } from '../FontSizeStepper';
import { BoldButton, ItalicButton } from '../FormatButtons';
import { HighlightPickerPopover } from '../HighlightPickerPopover';
import { OUTLINE_WIDTHS } from '../menu-widths';
import { NoteAlignDropdown } from '../NoteAlignDropdown';
import { ShapeTypeDropdown } from '../ShapeTypeDropdown';
import { StrokeWidthControl } from '../StrokeWidthControl';
import { TextColorPopover } from '../TextColorPopover';
import { TypefaceButton } from '../TypefaceButton';

const selectShapeStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
  width: s.selectedStyles.width,
  fillColor: s.selectedStyles.fillColor,
  fillColorMixed: s.selectedStyles.fillColorMixed,
  fontSize: s.selectedStyles.fontSize,
  labelColor: s.selectedStyles.labelColor,
});

export const ShapeMenu = memo(function ShapeMenu() {
  const { color, colorMixed, width, fillColor, fillColorMixed, fontSize, labelColor } = useSelectionStore(useShallow(selectShapeStyles));
  const deviceTextColor = useDeviceUIStore(selectTextColor);
  const deviceTextSize = useDeviceUIStore(selectTextSize);
  const effectiveLabelColor = labelColor ?? deviceTextColor;
  const effectiveFontSize = fontSize ?? deviceTextSize;
  return (
    <ButtonGroup>
      <TypefaceButton />
      <div className="ctx-divider" />
      <FontSizeStepper
        value={effectiveFontSize}
        onDecrement={decrementFontSize}
        onIncrement={incrementFontSize}
        onSelectSize={setSelectedFontSize}
      />
      <div className="ctx-divider" />
      <BoldButton />
      <ItalicButton />
      <NoteAlignDropdown />
      <TextColorPopover color={effectiveLabelColor} onSelect={setSelectedTextColor} />
      <HighlightPickerPopover onSelect={setSelectedHighlight} />
      <div className="ctx-divider" />
      <FillColorControl fillColor={fillColor} mixed={fillColorMixed} onSelect={setSelectedFillColor} />
      <BorderColorControl color={color} mixed={colorMixed} onSelect={setSelectedColor} />
      <div className="ctx-divider" />
      <StrokeWidthControl widths={OUTLINE_WIDTHS} value={width} onSelect={setSelectedWidth} disabled={color === null && !colorMixed} />
      <div className="ctx-divider" />
      <ShapeTypeDropdown mode="shapes" />
    </ButtonGroup>
  );
});
