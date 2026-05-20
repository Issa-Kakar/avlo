import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import { setSelectedFillColor, setSelectedHighlight } from '@/tools/selection/selection-actions';
import { ButtonGroup } from '../ButtonGroup';
import { ColorPickerPopover } from '../ColorPickerPopover';
import { NO_FILL } from '../color-palette';
import { BoldButton, ItalicButton } from '../FormatButtons';
import { HighlightPickerPopover } from '../HighlightPickerPopover';
import { NoteAlignDropdown } from '../NoteAlignDropdown';
import { ShapeTypeDropdown } from '../ShapeTypeDropdown';
import { TypefaceButton } from '../TypefaceButton';

const selectNoteStyles = (s: SelectionStore) => ({
  fillColor: s.selectedStyles.fillColor,
});

export const NoteMenu = memo(function NoteMenu() {
  const { fillColor } = useSelectionStore(useShallow(selectNoteStyles));
  return (
    <>
      <ShapeTypeDropdown mode="note" />
      <div className="ctx-divider" />
      <ButtonGroup>
        <TypefaceButton />
        <div className="ctx-divider" />
        <BoldButton />
        <ItalicButton />
        <NoteAlignDropdown />
        <HighlightPickerPopover onSelect={setSelectedHighlight} />
        <div className="ctx-divider" />
        <ColorPickerPopover
          color={fillColor ?? '#FEF3AC'}
          variant="filled"
          mode="fill"
          selectedColor={fillColor}
          onSelect={(c) => setSelectedFillColor(c === NO_FILL ? null : c)}
        />
      </ButtonGroup>
    </>
  );
});
