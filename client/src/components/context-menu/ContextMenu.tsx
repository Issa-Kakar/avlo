import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import './context-menu.css';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionKind, SelectionStore } from '@/stores/selection-store';
import {
  filterSelectionByKind,
  selectInlineBold,
  selectInlineItalic,
} from '@/stores/selection-store';
import {
  setSelectedWidth,
  setSelectedColor,
  setSelectedFillColor,
  setSelectedTextColor,
  setSelectedFontSize,
  setSelectedHighlight,
  toggleSelectedBold,
  toggleSelectedItalic,
  incrementFontSize,
  decrementFontSize,
  deleteSelected,
  incrementCodeFontSize,
  decrementCodeFontSize,
  setSelectedCodeFontSize,
  toggleCodeLineNumbers,
  toggleCodeHeader,
  toggleCodeOutput,
} from '@/tools/selection/selection-actions';
import { useDeviceUIStore, selectTextColor, selectTextSize } from '@/stores/device-ui-store';
import { NO_FILL } from './color-palette';

import { MenuButton } from './MenuButton';
import { ButtonGroup } from './ButtonGroup';
import { FontSizeStepper } from './FontSizeStepper';
import { SizeLabel } from './SizeLabel';
import { TypefaceButton } from './TypefaceButton';
import { FilterObjectsDropdown } from './FilterObjectsDropdown';
import { ColorPickerPopover } from './ColorPickerPopover';
import { TextColorPopover } from './TextColorPopover';
import { HighlightPickerPopover } from './HighlightPickerPopover';
import { ShapeTypeDropdown } from './ShapeTypeDropdown';
import { AlignDropdown } from './AlignDropdown';
import {
  IconBold,
  IconItalic,
  IconMoreDots,
  IconTrash,
  IconCodeLines,
  IconCodeHeader,
  IconCodeOutput,
} from './icons';
import { LanguageDropdown } from './LanguageDropdown';
import { NoteAlignDropdown } from './NoteAlignDropdown';
import { getHandleKind } from '@/runtime/room-runtime';

// === Selectors (stable module-level references) ===

const selectMenuOpen = (s: SelectionStore) => s.menuOpen;
const selectKind = (s: SelectionStore) => s.selectionKind;
const selectEditing = (s: SelectionStore) => s.textEditingId;
const selectCodeEditing = (s: SelectionStore) => s.codeEditingId;
const selectKindCounts = (s: SelectionStore) => s.kindCounts;
const selectStrokeStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
  colorSecond: s.selectedStyles.colorSecond,
  width: s.selectedStyles.width,
});
const selectShapeStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  width: s.selectedStyles.width,
  fillColor: s.selectedStyles.fillColor,
  fillColorMixed: s.selectedStyles.fillColorMixed,
  fillColorSecond: s.selectedStyles.fillColorSecond,
  fontSize: s.selectedStyles.fontSize,
  labelColor: s.selectedStyles.labelColor,
});
const selectTextStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  labelColor: s.selectedStyles.labelColor,
  fillColor: s.selectedStyles.fillColor,
  fillColorMixed: s.selectedStyles.fillColorMixed,
  fillColorSecond: s.selectedStyles.fillColorSecond,
});
const selectConnectorStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
  colorSecond: s.selectedStyles.colorSecond,
  width: s.selectedStyles.width,
});
const selectNoteStyles = (s: SelectionStore) => ({
  fillColor: s.selectedStyles.fillColor,
});

// === Group Components ===

const MixedFilterGroup = memo(function MixedFilterGroup() {
  const kindCounts = useSelectionStore(useShallow(selectKindCounts));
  return <FilterObjectsDropdown kindCounts={kindCounts} onFilterByKind={filterSelectionByKind} />;
});

const StrokeStyleGroup = memo(function StrokeStyleGroup() {
  const { color, colorMixed, colorSecond, width } = useSelectionStore(
    useShallow(selectStrokeStyles),
  );
  return (
    <ButtonGroup>
      <SizeLabel value={width ?? 0} kind="stroke" onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <ColorPickerPopover
        color={color}
        variant="filled"
        secondColor={colorMixed ? colorSecond : undefined}
        mode="stroke"
        selectedColor={color}
        onSelect={setSelectedColor}
      />
    </ButtonGroup>
  );
});

const ShapeStyleGroup = memo(function ShapeStyleGroup() {
  const { color, width, fillColor, fillColorMixed, fillColorSecond, fontSize, labelColor } =
    useSelectionStore(useShallow(selectShapeStyles));
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
      <div className="ctx-divider" />
      <NoteAlignDropdown />
      <div className="ctx-divider" />
      <TextColorPopover color={effectiveLabelColor} onSelect={setSelectedTextColor} />
      <HighlightPickerPopover onSelect={setSelectedHighlight} />
      <div className="ctx-divider" />
      <ColorPickerPopover
        color={color}
        variant="hollow"
        mode="stroke"
        selectedColor={color}
        onSelect={setSelectedColor}
      />
      <ColorPickerPopover
        color={fillColor ?? '#fff'}
        variant={fillColor === null && !fillColorMixed ? 'none' : 'filled'}
        secondColor={fillColorMixed ? fillColorSecond : undefined}
        mode="fill"
        selectedColor={fillColor}
        onSelect={(c) => setSelectedFillColor(c === NO_FILL ? null : c)}
      />
      <div className="ctx-divider" />
      <SizeLabel value={width ?? 0} kind="stroke" onSelect={setSelectedWidth} />
    </ButtonGroup>
  );
});

const BoldButton = memo(function BoldButton() {
  const bold = useSelectionStore(selectInlineBold);
  return (
    <MenuButton className="ctx-btn-sq" active={bold} onClick={toggleSelectedBold}>
      <IconBold style={{ width: 16, height: 16 }} />
    </MenuButton>
  );
});

const ItalicButton = memo(function ItalicButton() {
  const italic = useSelectionStore(selectInlineItalic);
  return (
    <MenuButton className="ctx-btn-sq" active={italic} onClick={toggleSelectedItalic}>
      <IconItalic style={{ width: 16, height: 16 }} />
    </MenuButton>
  );
});

const TextStyleGroup = memo(function TextStyleGroup() {
  const { fontSize, labelColor, fillColor, fillColorMixed, fillColorSecond } = useSelectionStore(
    useShallow(selectTextStyles),
  );
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
  );
});

const selectCodeStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  headerVisible: s.selectedStyles.codeHeaderVisible,
  outputVisible: s.selectedStyles.codeOutputVisible,
});

const CodeStyleGroup = memo(function CodeStyleGroup() {
  const { fontSize, headerVisible, outputVisible } = useSelectionStore(
    useShallow(selectCodeStyles),
  );
  const effectiveFontSize = fontSize ?? 14;
  return (
    <ButtonGroup>
      <LanguageDropdown />
      <div className="ctx-divider" />
      <FontSizeStepper
        value={effectiveFontSize}
        onDecrement={decrementCodeFontSize}
        onIncrement={incrementCodeFontSize}
        onSelectSize={setSelectedCodeFontSize}
      />
      <div className="ctx-divider" />
      <MenuButton className="ctx-btn-sq" onMouseDown={toggleCodeLineNumbers}>
        <IconCodeLines style={{ width: 22, height: 16 }} />
      </MenuButton>
      <MenuButton
        className="ctx-btn-sq"
        active={headerVisible === true}
        onMouseDown={toggleCodeHeader}
      >
        <IconCodeHeader style={{ width: 16, height: 16 }} />
      </MenuButton>
      <MenuButton
        className="ctx-btn-sq"
        active={outputVisible === true}
        onMouseDown={toggleCodeOutput}
      >
        <IconCodeOutput style={{ width: 16, height: 16 }} />
      </MenuButton>
    </ButtonGroup>
  );
});

const ConnectorGroup = memo(function ConnectorGroup() {
  const { color, colorMixed, colorSecond, width } = useSelectionStore(
    useShallow(selectConnectorStyles),
  );
  return (
    <ButtonGroup>
      <SizeLabel value={width ?? 0} kind="connector" onSelect={setSelectedWidth} />
      <div className="ctx-divider" />
      <ColorPickerPopover
        color={color}
        variant="filled"
        secondColor={colorMixed ? colorSecond : undefined}
        mode="stroke"
        selectedColor={color}
        onSelect={setSelectedColor}
      />
    </ButtonGroup>
  );
});

const NoteStyleGroup = memo(function NoteStyleGroup() {
  const { fillColor } = useSelectionStore(useShallow(selectNoteStyles));
  return (
    <ButtonGroup>
      <TypefaceButton />
      <div className="ctx-divider" />
      <BoldButton />
      <ItalicButton />
      <div className="ctx-divider" />
      <NoteAlignDropdown />
      <div className="ctx-divider" />
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
  );
});

const CommonActionsGroup = memo(function CommonActionsGroup() {
  return (
    <ButtonGroup>
      <MenuButton className="ctx-btn-sq ctx-btn-danger" onClick={deleteSelected}>
        <IconTrash />
      </MenuButton>
    </ButtonGroup>
  );
});

const OverflowButton = memo(function OverflowButton() {
  return (
    <MenuButton className="ctx-btn-sq ctx-btn-more">
      <IconMoreDots />
    </MenuButton>
  );
});

// === Bar (shell) ===

function ContextMenuBar() {
  const kind = useSelectionStore(selectKind);
  const editing = useSelectionStore(selectEditing);
  const codeEditing = useSelectionStore(selectCodeEditing);
  const effectiveKind: SelectionKind =
    editing !== null && kind === 'none'
      ? getHandleKind(editing) === 'note'
        ? 'notesOnly'
        : 'textOnly'
      : codeEditing !== null && kind === 'none'
        ? 'codeOnly'
        : kind;

  return (
    <div className="ctx-menu">
      {effectiveKind === 'mixed' ? (
        <>
          <MixedFilterGroup />
          <div className="ctx-divider" />
        </>
      ) : (
        <>
          {effectiveKind === 'strokesOnly' && (
            <>
              <StrokeStyleGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'shapesOnly' && (
            <>
              <ShapeTypeDropdown mode="shapes" />
              <div className="ctx-divider" />
              <ShapeStyleGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'textOnly' && (
            <>
              <ShapeTypeDropdown mode="text" />
              <div className="ctx-divider" />
              <TextStyleGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'notesOnly' && (
            <>
              <ShapeTypeDropdown mode="note" />
              <div className="ctx-divider" />
              <NoteStyleGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'codeOnly' && (
            <>
              <CodeStyleGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'connectorsOnly' && (
            <>
              <ConnectorGroup />
              <div className="ctx-divider" />
            </>
          )}
          {effectiveKind === 'imagesOnly' && (
            // Images: no style controls, just the common actions (delete)
            <></>
          )}
        </>
      )}
      <CommonActionsGroup />
      <div className="ctx-divider" />
      <OverflowButton />
    </div>
  );
}

// === Gate ===

export function ContextMenu() {
  const open = useSelectionStore(selectMenuOpen);
  if (!open) return null;
  return <ContextMenuBar />;
}
