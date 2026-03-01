import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import './context-menu.css';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionKind, SelectionStore } from '@/stores/selection-store';
import { filterSelectionByKind, selectInlineBold, selectInlineItalic } from '@/stores/selection-store';
import {
  setSelectedWidth,
  setSelectedColor,
  setSelectedFillColor,
  setSelectedTextColor,
  setSelectedFontSize,
  setSelectedTextAlign,
  setSelectedHighlight,
  toggleSelectedBold,
  toggleSelectedItalic,
  incrementFontSize,
  decrementFontSize,
  deleteSelected,
} from '@/lib/utils/selection-actions';
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
import {
  IconAlignTextLeft,
  IconAlignTextCenter,
  IconAlignTextRight,
  IconBold,
  IconItalic,
  IconMoreDots,
  IconTrash,
} from './icons';

// === Selectors (stable module-level references) ===

const selectMenuOpen = (s: SelectionStore) => s.menuOpen;
const selectKind = (s: SelectionStore) => s.selectionKind;
const selectEditing = (s: SelectionStore) => s.textEditingId;
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
});
const selectTextStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  textAlign: s.selectedStyles.textAlign,
  color: s.selectedStyles.color,
});
const selectConnectorStyles = (s: SelectionStore) => ({
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
  colorSecond: s.selectedStyles.colorSecond,
  width: s.selectedStyles.width,
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
  const { color, width, fillColor, fillColorMixed, fillColorSecond } = useSelectionStore(
    useShallow(selectShapeStyles),
  );
  return (
    <ButtonGroup>
      <SizeLabel value={width ?? 0} kind="stroke" onSelect={setSelectedWidth} />
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
    </ButtonGroup>
  );
});

const BoldButton = memo(function BoldButton() {
  const bold = useSelectionStore(selectInlineBold);
  return (
    <MenuButton className="ctx-btn-sq" active={bold} onClick={toggleSelectedBold}>
      <IconBold />
    </MenuButton>
  );
});

const ItalicButton = memo(function ItalicButton() {
  const italic = useSelectionStore(selectInlineItalic);
  return (
    <MenuButton className="ctx-btn-sq" active={italic} onClick={toggleSelectedItalic}>
      <IconItalic />
    </MenuButton>
  );
});

const TextStyleGroup = memo(function TextStyleGroup() {
  const { fontSize, textAlign, color } = useSelectionStore(
    useShallow(selectTextStyles),
  );
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
      <div className="ctx-group-tight">
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'left'} onClick={() => setSelectedTextAlign('left')}>
          <IconAlignTextLeft />
        </MenuButton>
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'center'} onClick={() => setSelectedTextAlign('center')}>
          <IconAlignTextCenter />
        </MenuButton>
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'right'} onClick={() => setSelectedTextAlign('right')}>
          <IconAlignTextRight />
        </MenuButton>
      </div>
      <div className="ctx-divider" />
      <TextColorPopover color={color} onSelect={setSelectedTextColor} />
      <HighlightPickerPopover onSelect={setSelectedHighlight} />
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
  const effectiveKind: SelectionKind = editing !== null ? 'textOnly' : kind;

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
          {effectiveKind === 'connectorsOnly' && (
            <>
              <ConnectorGroup />
              <div className="ctx-divider" />
            </>
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
