import { memo } from 'react';
import type { Canvas } from './data';
import { formatDate } from './data';
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
  starred: boolean;
  onToggleStar: (id: string) => void;
}

function Cell({ column, canvas, starred, onToggleStar }: Omit<CanvasRowProps, 'columns' | 'template'> & { column: Column }) {
  switch (column.key) {
    case 'star':
      return (
        <div className="dash-star-cell">
          <button
            type="button"
            className="dash-star-btn"
            aria-label={starred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar(canvas.id);
            }}
          >
            <StarIcon width={23} height={23} filled={starred} />
          </button>
        </div>
      );
    case 'name':
      return <div className="dash-cell-name">{canvas.name}</div>;
    case 'date':
      return <div className="dash-cell-date">{formatDate(canvas[column.dateField ?? 'openedTs'])}</div>;
    case 'owner':
      return (
        <div className="dash-cell-owner">
          <OwnerAvatar name={canvas.owner} />
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

// memo'd + keyed by id: a star toggle re-renders only the toggled row (it receives
// a `starred` boolean, not the Set). Row hover + kebab reveal are pure CSS — no
// per-row state, so a hover never triggers a React render.
export const CanvasRow = memo(function CanvasRow({ columns, template, canvas, starred, onToggleStar }: CanvasRowProps) {
  return (
    <div className="dash-row" style={{ gridTemplateColumns: template }}>
      {columns.map((column) => (
        <Cell key={column.key + (column.dateField ?? '')} column={column} canvas={canvas} starred={starred} onToggleStar={onToggleStar} />
      ))}
    </div>
  );
});
