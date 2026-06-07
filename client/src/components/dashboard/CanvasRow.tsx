import { memo } from 'react';
import { type Canvas, formatDate, OWNER_SELF } from './data';
import { KebabIcon } from './icons/KebabIcon';
import { StarIcon } from './icons/StarIcon';
import { OwnerAvatar } from './OwnerAvatar';

export interface Column {
  key: 'star' | 'name' | 'date' | 'owner' | 'kebab';
  header: string;
  width: string;
  dateField?: 'openedTs' | 'createdTs'; // required for `date` columns
}

interface CanvasRowProps {
  columns: readonly Column[];
  template: string;
  canvas: Canvas;
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
}

function Cell({ column, canvas, onToggleStar }: { column: Column; canvas: Canvas; onToggleStar: (id: string) => void }) {
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
      return <div className="dash-cell-name">{canvas.name}</div>;
    case 'date':
      return <div className="dash-cell-date">{formatDate(canvas[column.dateField ?? 'openedTs'])}</div>;
    case 'owner':
      // Self → "Me" + self avatar; anyone else → "Anonymous", no avatar (no account names until OAuth).
      return (
        <div className="dash-cell-owner">
          {canvas.owner === OWNER_SELF && <OwnerAvatar name={canvas.owner} />}
          <span>{canvas.owner}</span>
        </div>
      );
    case 'kebab':
      return (
        <div className="dash-kebab-cell">
          <button type="button" className="dash-kebab" aria-label="Canvas options" onClick={(e) => e.stopPropagation()}>
            <KebabIcon width={20} height={20} />
          </button>
        </div>
      );
  }
}

// memo'd + keyed by id. The row is mouse-clickable → onOpen; the star + kebab buttons
// stopPropagation so they never trigger a row open. Row hover is pure CSS (no per-row
// state), so a hover never triggers a React render.
export const CanvasRow = memo(function CanvasRow({ columns, template, canvas, onOpen, onToggleStar }: CanvasRowProps) {
  return (
    <div className="dash-row" style={{ gridTemplateColumns: template }} onClick={() => onOpen(canvas.id)}>
      {columns.map((column) => (
        <Cell key={column.key + (column.dateField ?? '')} column={column} canvas={canvas} onToggleStar={onToggleStar} />
      ))}
    </div>
  );
});
