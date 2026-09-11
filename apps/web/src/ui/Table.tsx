import { useMemo, useState, type ReactNode } from 'react';
import { downloadCsv } from '../lib/csv';
import { Button } from './primitives';

export interface Column<T> {
  key: string;
  header: string;
  /** cell renderer */
  render: (row: T) => ReactNode;
  /** value used for sorting and CSV (defaults to render output when it is a primitive) */
  value?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** file name for Export CSV; omit to hide the button */
  exportName?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  emptyMessage?: string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  title?: ReactNode;
}

function cellValue<T>(col: Column<T>, row: T): string | number | null | undefined {
  if (col.value) return col.value(row);
  const r = col.render(row);
  if (typeof r === 'string' || typeof r === 'number') return r;
  return r == null ? null : String(r);
}

/** Sortable table with CSV export (spec 9.7). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  exportName,
  defaultSort,
  emptyMessage = 'No data',
  dense,
  rowClassName,
  onRowClick,
  toolbar,
  title,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = cellValue(col, a);
      const vb = cellValue(col, b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
    });
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const exportCsv = () => {
    if (!exportName) return;
    downloadCsv(
      exportName,
      columns.map((c) => ({ header: c.header, value: (r: T) => cellValue(c, r) })),
      sorted,
    );
  };

  return (
    <div className="dt">
      {(title || toolbar || exportName) && (
        <div className="dt-toolbar">
          {title && <div className="dt-title">{title}</div>}
          <div className="dt-toolbar-spacer" />
          {toolbar}
          {exportName && (
            <Button size="sm" variant="ghost" onClick={exportCsv} title="Export the current view as CSV">
              Export CSV
            </Button>
          )}
        </div>
      )}
      <div className="dt-scroll">
        <table className={`dt-table${dense ? ' dt-dense' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? 'left', width: c.width }}
                  className={c.sortable === false ? undefined : 'dt-sortable'}
                  onClick={c.sortable === false ? undefined : () => toggleSort(c.key)}
                >
                  {c.header}
                  {sort?.key === c.key && <span className="dt-sort-ind">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="dt-empty">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {sorted.map((r, i) => (
              <tr
                key={rowKey(r, i)}
                className={`${rowClassName?.(r) ?? ''}${onRowClick ? ' dt-clickable' : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
