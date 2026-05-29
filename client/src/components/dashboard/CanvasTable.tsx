import { CanvasRow, type Column } from './CanvasRow';
import type { CanvasGroup } from './data';

interface CanvasTableProps {
  columns: readonly Column[];
  groups: readonly CanvasGroup[];
  starredIds: ReadonlySet<string>;
  onToggleStar: (id: string) => void;
  /** Home view sits below a Filter/Sort row — adds extra top separation. */
  spacious?: boolean;
}

export function CanvasTable({ columns, groups, starredIds, onToggleStar, spacious = false }: CanvasTableProps) {
  const template = columns.map((c) => c.width).join(' ');
  const allEmpty = groups.every((g) => g.rows.length === 0);

  return (
    <div className={spacious ? 'dash-table dash-table-spacious' : 'dash-table'}>
      <div className="dash-thead" style={{ gridTemplateColumns: template }}>
        {columns.map((col) => (
          <div
            key={col.key + (col.dateField ?? '')}
            className={col.key === 'star' ? 'dash-th dash-th-star' : col.key === 'kebab' ? 'dash-th dash-th-kebab' : 'dash-th'}
          >
            {col.header}
          </div>
        ))}
      </div>

      {allEmpty ? (
        <div className="dash-empty">Nothing to show here.</div>
      ) : (
        groups.map((group) => (
          <div key={group.title ?? '_'}>
            {group.title && group.rows.length > 0 && <div className="dash-section">{group.title}</div>}
            {group.rows.map((canvas) => (
              <CanvasRow
                key={canvas.id}
                columns={columns}
                template={template}
                canvas={canvas}
                starred={starredIds.has(canvas.id)}
                onToggleStar={onToggleStar}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
