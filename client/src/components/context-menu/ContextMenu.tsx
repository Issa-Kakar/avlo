import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import './context-menu.css';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionKind, SelectionStore } from '@/stores/selection-store';
import { filterSelectionByKind } from '@/stores/selection-store';
import { Divider } from './Divider';
import { MenuButton } from './MenuButton';
import { ButtonGroup } from './ButtonGroup';
import { SizeStepper } from './SizeStepper';
import { SizeLabel } from './SizeLabel';
import { TypefaceButton } from './TypefaceButton';
import { FilterObjectsDropdown } from './FilterObjectsDropdown';
import { ColorPickerPopover } from './ColorPickerPopover';
import {
  IconAlignTextLeft, IconAlignTextCenter, IconAlignTextRight,
  TextColorIcon, HighlightIcon,
  IconBold, IconItalic,
  IconMoreDots, IconTrash,
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
  colorMixed: s.selectedStyles.colorMixed,
  colorSecond: s.selectedStyles.colorSecond,
  width: s.selectedStyles.width,
  fillColor: s.selectedStyles.fillColor,
});
const selectTextStyles = (s: SelectionStore) => ({
  fontSize: s.selectedStyles.fontSize,
  textAlign: s.selectedStyles.textAlign,
  color: s.selectedStyles.color,
  colorMixed: s.selectedStyles.colorMixed,
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
  const { color, colorMixed, colorSecond, width } = useSelectionStore(useShallow(selectStrokeStyles));
  return (
    <ButtonGroup>
      <ColorPickerPopover
        color={color}
        variant={colorMixed ? 'hollow' : 'filled'}
        secondColor={colorMixed ? colorSecond : undefined}
        mode="stroke"
        selectedColor={color}
      />
      <Divider variant="light" />
      <SizeLabel value={width ?? 0} kind="stroke" />
    </ButtonGroup>
  );
});

const ShapeStyleGroup = memo(function ShapeStyleGroup() {
  const { color, colorMixed, colorSecond, width, fillColor } = useSelectionStore(useShallow(selectShapeStyles));
  return (
    <ButtonGroup>
      <ColorPickerPopover
        color={color}
        variant="hollow"
        secondColor={colorMixed ? colorSecond : undefined}
        mode="stroke"
        selectedColor={color}
      />
      <ColorPickerPopover
        color={fillColor ?? '#fff'}
        variant={fillColor === null ? 'none' : 'filled'}
        mode="fill"
        selectedColor={fillColor}
      />
      <Divider variant="light" />
      <SizeLabel value={width ?? 0} kind="stroke" />
    </ButtonGroup>
  );
});

const TextStyleGroup = memo(function TextStyleGroup() {
  const { fontSize, textAlign, color, colorMixed } = useSelectionStore(useShallow(selectTextStyles));
  return (
    <ButtonGroup>
      <TypefaceButton />
      <Divider variant="light" />
      {fontSize !== null && <SizeStepper value={fontSize} />}
      <Divider variant="light" />
      <MenuButton className="ctx-btn-sq">
        <IconBold />
      </MenuButton>
      <MenuButton className="ctx-btn-sq">
        <IconItalic />
      </MenuButton>
      <Divider variant="light" />
      <div className="ctx-group-tight">
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'left'}>
          <IconAlignTextLeft />
        </MenuButton>
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'center'}>
          <IconAlignTextCenter />
        </MenuButton>
        <MenuButton className="ctx-btn ctx-btn-align" active={textAlign === 'right'}>
          <IconAlignTextRight />
        </MenuButton>
      </div>
      <Divider variant="light" />
      <MenuButton className="ctx-btn-color">
        <TextColorIcon barColor={colorMixed ? '#9CA3AF' : color} width={20} height={20} />
      </MenuButton>
      <MenuButton className="ctx-btn-color">
        <HighlightIcon barColor={null} width={20} height={20} />
      </MenuButton>
    </ButtonGroup>
  );
});

const ConnectorGroup = memo(function ConnectorGroup() {
  const { color, colorMixed, colorSecond, width } = useSelectionStore(useShallow(selectConnectorStyles));
  return (
    <ButtonGroup>
      <ColorPickerPopover
        color={color}
        variant={colorMixed ? 'hollow' : 'filled'}
        secondColor={colorMixed ? colorSecond : undefined}
        mode="stroke"
        selectedColor={color}
      />
      <Divider variant="light" />
      <SizeLabel value={width ?? 0} kind="connector" />
    </ButtonGroup>
  );
});

const CommonActionsGroup = memo(function CommonActionsGroup() {
  return (
    <ButtonGroup>
      <MenuButton className="ctx-btn-sq ctx-btn-danger">
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
        <><MixedFilterGroup /><Divider /></>
      ) : (
        <>
          {effectiveKind === 'strokesOnly' && <><StrokeStyleGroup /><Divider /></>}
          {effectiveKind === 'shapesOnly' && <><ShapeStyleGroup /><Divider /></>}
          {effectiveKind === 'textOnly' && <><TextStyleGroup /><Divider /></>}
          {effectiveKind === 'connectorsOnly' && <><ConnectorGroup /><Divider /></>}
        </>
      )}
      <CommonActionsGroup />
      <Divider />
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
