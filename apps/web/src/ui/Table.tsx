import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { downloadCsv } from '../lib/csv';
import { Button } from './primitives';

export interface Column<T> {
  key: string;
  header: string;
  /** cell renderer */
  render: (row: T) => ReactNode;
  /** value used for sorting and CSV (defaults to render output when it is a primitive) */
  value?: (row: T) => string | number | null | undefined;
  /** `right` also turns on tabular figures (docs/DESIGN.md, principle 3) */
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
  /** sticky column headers inside the scroll area (default true) */
  stickyHeader?: boolean;
  /** drill-down rows; return one or more `<tr className="dt-subrow">` elements */
  renderSubRows?: (row: T) => ReactNode;
  /** which rows can expand (default: every row, when `renderSubRows` is given) */
  expandable?: (row: T) => boolean;
  /** controlled expansion; omit both to let the table keep its own state */
  expandedKeys?: (string | number)[];
  onToggleExpand?: (key: string | number, row: T) => void;
}

function cellValue<T>(col: Column<T>, row: T): string | number | null | undefined {
  if (col.value) return col.value(row);
  const r = col.render(row);
  if (typeof r === 'string' || typeof r === 'number') return r;
  return r == null ? null : String(r);
}

/** Sortable table with CSV export, sticky header and optional expander rows (spec 9.7). */
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
  stickyHeader = true,
  renderSubRows,
  expandable,
  expandedKeys,
  onToggleExpand,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);
  const [ownExpanded, setOwnExpanded] = useState<Set<string | number>>(new Set());

  const expanded = useMemo(() => (expandedKeys ? new Set<string | number>(expandedKeys) : ownExpanded), [expandedKeys, ownExpanded]);

  const toggleExpand = (key: string | number, row: T) => {
    if (onToggleExpand) onToggleExpand(key, row);
    if (!expandedKeys) {
      setOwnExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
  };

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

  const canExpand = (row: T) => renderSubRows != null && (expandable ? expandable(row) : true);

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
        <table className={`dt-table${dense ? ' dt-dense' : ''}${stickyHeader ? ' dt-sticky' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align ?? 'left', width: c.width }}
                  className={`${c.align === 'right' ? 'dt-num' : ''}${c.sortable === false ? '' : ' dt-sortable'}`.trim() || undefined}
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
            {sorted.map((r, i) => {
              const key = rowKey(r, i);
              const open = expanded.has(key);
              const showChevron = canExpand(r);
              return (
                <Fragment key={key}>
                  <tr
                    className={`${rowClassName?.(r) ?? ''}${onRowClick ? ' dt-clickable' : ''}`}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                  >
                    {columns.map((c, ci) => (
                      <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.align === 'right' ? 'dt-num' : undefined}>
                        {ci === 0 && showChevron && (
                          <button
                            type="button"
                            className="dt-expander"
                            aria-expanded={open}
                            aria-label={open ? 'Collapse' : 'Expand'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(key, r);
                            }}
                          >
                            <span className={`chev${open ? ' open' : ''}`} />
                          </button>
                        )}
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                  {open && showChevron && renderSubRows?.(r)}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
