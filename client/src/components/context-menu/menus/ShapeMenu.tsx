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
import { ButtonGroup } from '../ButtonGroup';
import { ColorPickerPopover } from '../ColorPickerPopover';
import { NO_FILL } from '../color-palette';
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
  width: s.selectedStyles.width,
  fillColor: s.selectedStyles.fillColor,
  fillColorMixed: s.selectedStyles.fillColorMixed,
  fillColorSecond: s.selectedStyles.fillColorSecond,
  fontSize: s.selectedStyles.fontSize,
  labelColor: s.selectedStyles.labelColor,
});

export const ShapeMenu = memo(function ShapeMenu() {
  const { color, width, fillColor, fillColorMixed, fillColorSecond, fontSize, labelColor } = useSelectionStore(
    useShallow(selectShapeStyles),
  );
  const deviceTextColor = useDeviceUIStore(selectTextColor);
  const deviceTextSize = useDeviceUIStore(selectTextSize);
  const effectiveLabelColor = labelColor ?? deviceTextColor;
  const effectiveFontSize = fontSize ?? deviceTextSize;
  return (
    <>
      <ShapeTypeDropdown mode="shapes" />
      <div className="ctx-divider" />
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
        <ColorPickerPopover color={color} variant="hollow" mode="stroke" selectedColor={color} onSelect={setSelectedColor} />
        <ColorPickerPopover
          color={fillColor ?? '#fff'}
          variant={fillColor === null && !fillColorMixed ? 'none' : 'filled'}
          secondColor={fillColorMixed ? fillColorSecond : undefined}
          mode="fill"
          selectedColor={fillColor}
          onSelect={(c) => setSelectedFillColor(c === NO_FILL ? null : c)}
        />
        <div className="ctx-divider" />
        <StrokeWidthControl widths={OUTLINE_WIDTHS} value={width} onSelect={setSelectedWidth} />
      </ButtonGroup>
    </>
  );
});
