import { normalizeRoomTitle, ROOM_TITLE_MAX_LEN } from '@avlo/shared';
import { memo, useRef } from 'react';
import { useDropdown } from '../context-menu/useDropdown';
import { EyeIcon } from '../icons/EyeIcon';
import { EditIcon } from '../topbar/icons/EditIcon';
import { type Canvas, formatDate, permissionLabel } from './data';
import { KebabIcon } from './icons/KebabIcon';
import { StarIcon } from './icons/StarIcon';

export interface Column {
  key: 'star' | 'name' | 'date' | 'type' | 'owner' | 'kebab';
  header: string;
  width: string;
  dateField?: 'openedTs' | 'createdTs'; // required for `date` columns
}

/** Rename wiring threaded from Dashboard (which owns `renamingId` + the mutation). */
export interface RowRenameProps {
  onRenameStart: (id: string) => void;
  onRenameCommit: (id: string, title: string) => void;
  onRenameEnd: () => void;
}

interface CanvasRowProps extends RowRenameProps {
  columns: readonly Column[];
  template: string;
  canvas: Canvas;
  /** Derived boolean (not the id) so memo'd siblings don't re-render on rename start/end. */
  renaming: boolean;
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
}

/**
 * Kebab cell for OWNED rows — `useDropdown` (the SortFilterDropdown pattern) with a
 * right-anchored popover. The trigger toggles on mousedown (outside-dismiss is a
 * document POINTERDOWN, which fires first — so pressing another kebab closes this one
 * before that one's mousedown toggles it open); the item acts on click so the menu is
 * still mounted at mouseup, and both stopPropagation so the row never opens.
 */
function KebabMenuCell({ canvasId, onRenameStart }: { canvasId: string; onRenameStart: (id: string) => void }) {
  const { open, containerRef, toggle, close } = useDropdown();
  return (
    <div className="dash-kebab-cell" ref={containerRef}>
      <button
        type="button"
        className="dash-kebab"
        aria-label="Canvas options"
        aria-expanded={open}
        onMouseDown={(e) => {
          e.stopPropagation();
          toggle(e);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <KebabIcon width={20} height={20} />
      </button>
      {open && (
        <div className="dash-dd-menu dash-row-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="dash-dd-item dash-row-menu-item"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              close();
              onRenameStart(canvasId);
            }}
          >
            <EditIcon width={20} height={20} />
            Rename
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Name cell — plain text, or an uncontrolled input while this row renames. One commit
 * path (blur): Enter blurs, Escape flags a cancel before blurring. Empty/unchanged
 * reverts without a request; otherwise the normalized title goes to the rename mutation.
 */
function NameCell({
  canvas,
  renaming,
  onRenameCommit,
  onRenameEnd,
}: { canvas: Canvas; renaming: boolean } & Omit<RowRenameProps, 'onRenameStart'>) {
  const cancelled = useRef(false);
  if (!renaming) return <div className="dash-cell-name">{canvas.name}</div>;
  return (
    // Click shield while editing — the row's onOpen must never fire from inside the editor.
    <div className="dash-cell-name" onClick={(e) => e.stopPropagation()}>
      <input
        className="dash-rename-input"
        defaultValue={canvas.name}
        maxLength={ROOM_TITLE_MAX_LEN}
        aria-label="Canvas name"
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const { value } = e.currentTarget;
          onRenameEnd();
          if (cancelled.current) return;
          const next = normalizeRoomTitle(value);
          if (next === null || next === canvas.name) return;
          onRenameCommit(canvas.id, next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur(); // commit via the single blur path
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function Cell({
  column,
  canvas,
  renaming,
  onToggleStar,
  onRenameStart,
  onRenameCommit,
  onRenameEnd,
}: { column: Column; canvas: Canvas; renaming: boolean; onToggleStar: (id: string) => void } & RowRenameProps) {
  switch (column.key) {
    case 'star':
      return (
        <div className="dash-star-cell">
          <button
            type="button"
            className="dash-star-btn"
            aria-label={canvas.starred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(canvas.id);
            }}
          >
            <StarIcon width={23} height={23} filled={canvas.starred} />
          </button>
        </div>
      );
    case 'name':
      return <NameCell canvas={canvas} renaming={renaming} onRenameCommit={onRenameCommit} onRenameEnd={onRenameEnd} />;
    case 'date':
      return <div className="dash-cell-date">{formatDate(canvas[column.dateField ?? 'openedTs'])}</div>;
    case 'type':
      // "View only" rows carry the eye glyph; the owner additionally gets a tooltip
      // explaining why their own row reads view-only.
      return (
        <div
          className="dash-cell-type"
          title={canvas.permission === 'readonly' && canvas.isOwner ? "Viewers can't edit — you own this canvas" : undefined}
        >
          {canvas.permission === 'readonly' && <EyeIcon width={17} height={17} />}
          <span>{permissionLabel(canvas.permission)}</span>
        </div>
      );
    case 'owner':
      return (
        <div className="dash-cell-owner">
          <span>{canvas.owner}</span>
        </div>
      );
    case 'kebab':
      // Rename is owner-only, so non-owned rows get an empty cell (an inert button next
      // to working ones would read as broken); the grid column keeps its footprint.
      return canvas.isOwner ? <KebabMenuCell canvasId={canvas.id} onRenameStart={onRenameStart} /> : <div className="dash-kebab-cell" />;
  }
}

// memo'd + keyed by id. The row is mouse-clickable → onOpen; the star + kebab + rename
// surfaces stopPropagation so they never trigger a row open (and the row ignores clicks
// outright while renaming). Row hover is pure CSS (no per-row state), so a hover never
// triggers a React render.
export const CanvasRow = memo(function CanvasRow({
  columns,
  template,
  canvas,
  renaming,
  onOpen,
  onToggleStar,
  onRenameStart,
  onRenameCommit,
  onRenameEnd,
}: CanvasRowProps) {
  return (
    <div className="dash-row" style={{ gridTemplateColumns: template }} onClick={() => !renaming && onOpen(canvas.id)}>
      {columns.map((column) => (
        <Cell
          key={column.key + (column.dateField ?? '')}
          column={column}
          canvas={canvas}
          renaming={renaming}
          onToggleStar={onToggleStar}
          onRenameStart={onRenameStart}
          onRenameCommit={onRenameCommit}
          onRenameEnd={onRenameEnd}
        />
      ))}
    </div>
  );
});
