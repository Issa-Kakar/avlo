import type { ComponentType } from 'react';
import './context-menu.css';
import { getHandleKind } from '@/runtime/room-runtime';
import type { SelectionStore } from '@/stores/selection-store';
import { useSelectionStore } from '@/stores/selection-store';
import type { SelectionKind } from '@/tools/selection/types';
import { LockButton } from './LockButton';
import { CodeMenu } from './menus/CodeMenu';
import { ConnectorMenu } from './menus/ConnectorMenu';
import { MixedMenu } from './menus/MixedMenu';
import { NoteMenu } from './menus/NoteMenu';
import { ShapeMenu } from './menus/ShapeMenu';
import { StrokeMenu } from './menus/StrokeMenu';
import { TextMenu } from './menus/TextMenu';

// === Selectors (stable module-level references) ===

const selectMenuOpen = (s: SelectionStore) => s.menuOpen;
const selectKind = (s: SelectionStore) => s.selectionKind;
const selectEditing = (s: SelectionStore) => s.textEditingId;
const selectCodeEditing = (s: SelectionStore) => s.codeEditingId;

// Per-kind menu bar. `none` / `image` / `bookmark` intentionally have no menu
// content — the lock button in the shell is the entire bar for those kinds.
const MENU_BY_KIND: Partial<Record<SelectionKind, ComponentType>> = {
  stroke: StrokeMenu,
  connector: ConnectorMenu,
  shape: ShapeMenu,
  text: TextMenu,
  note: NoteMenu,
  code: CodeMenu,
  mixed: MixedMenu,
};

// === Bar (shell) ===

function ContextMenuBar() {
  const kind = useSelectionStore(selectKind);
  const editing = useSelectionStore(selectEditing);
  const codeEditing = useSelectionStore(selectCodeEditing);
  const effectiveKind: SelectionKind =
    editing !== null && kind === 'none'
      ? getHandleKind(editing) === 'note'
        ? 'note'
        : 'text'
      : codeEditing !== null && kind === 'none'
        ? 'code'
        : kind;

  const Menu = MENU_BY_KIND[effectiveKind];

  return (
    <div className="ctx-menu">
      <LockButton />
      {Menu && (
        <>
          <div className="ctx-divider" />
          <Menu />
        </>
      )}
    </div>
  );
}

// === Gate ===

export function ContextMenu() {
  const open = useSelectionStore(selectMenuOpen);
  if (!open) return null;
  return <ContextMenuBar />;
}
