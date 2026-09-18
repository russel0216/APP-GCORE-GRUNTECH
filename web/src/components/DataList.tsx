import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, qs, type ListResult } from '../lib/api';
import { Empty, ErrorBox, Loading } from './ui';

/**
 * The shared list pattern (model §8.4).
 *
 * "All list on menu have the same format, search bar arrange by category."
 * Every list screen in G-Core — quotations, purchase requests, employees,
 * inventory — renders through this component. Add New · Search · Filter ·
 * Columns · Export · Refresh, plus sorting, pagination, saved filters and the
 * Mine/All scope switch. Build it once, and the twentieth list screen costs a
 * column definition rather than a week.
 */

export interface Column<T> {
  key: string;
  label: string;
  /** Column id to sort by on the server; omit for a non-sortable column. */
  sortKey?: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Hidden by default; the user turns it on from Columns. */
  optional?: boolean;
}

export interface FilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

interface Props<T> {
  /** Stable id used for saved filters and column preferences. */
  listKey: string;
  endpoint: string;
  columns: Column<T>[];
  filters?: FilterDef[];
  searchPlaceholder?: string;
  /** Shows the Mine/All switch — for records that have an owner. */
  scoped?: boolean;
  onRowClick?: (row: T) => void;
  actions?: ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  /** Bump to force a reload from outside (after a create, say). */
  reloadToken?: number;
  rowKey: (row: T) => string;
}

export function DataList<T>({
  listKey,
  endpoint,
  columns,
  filters = [],
  searchPlaceholder = 'Search…',
  scoped = false,
  onRowClick,
  actions,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  reloadToken = 0,
  rowKey,
}: Props<T>) {
  const [data, setData] = useState<ListResult<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [scope, setScope] = useState<'mine' | 'all'>('all');
  const [active, setActive] = useState<Record<string, string>>({});
  const [showColumns, setShowColumns] = useState(false);

  const [hidden, setHidden] = useState<Set<string>>(() => {
    // Column choices are a per-viewer convenience — localStorage is the right
    // home for them, and it failing is not an error worth showing anyone.
    try {
      const raw = localStorage.getItem(`gcore_cols_${listKey}`);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
    return new Set(columns.filter((c) => c.optional).map((c) => c.key));
  });

  useEffect(() => {
    try {
      localStorage.setItem(`gcore_cols_${listKey}`, JSON.stringify([...hidden]));
    } catch {
      /* ignore */
    }
  }, [hidden, listKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 280);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(
    () => qs({ page, pageSize, search: debounced, sort, dir, scope, ...active }),
    [page, pageSize, debounced, sort, dir, scope, active],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<ListResult<T>>(`${endpoint}${query}`));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [endpoint, query]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const visible = columns.filter((c) => !hidden.has(c.key));

  function toggleSort(column: Column<T>) {
    if (!column.sortKey) return;
    if (sort === column.sortKey) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(column.sortKey);
      setDir('asc');
    }
    setPage(1);
  }

  function exportCsv() {
    if (!data) return;
    const header = visible.map((c) => c.label);
    const lines = data.rows.map((row) =>
      visible.map((c) => csvCell(extractText(c.render(row)))).join(','),
    );
    const csv = [header.map(csvCell).join(','), ...lines].join('\r\n');
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${listKey}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="list-toolbar">
        {actions}

        <input
          className="list-search"
          type="text"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {scoped && (
          <div className="scope-switch">
            <button
              className={scope === 'mine' ? 'active' : ''}
              onClick={() => {
                setScope('mine');
                setPage(1);
              }}
            >
              Mine
            </button>
            <button
              className={scope === 'all' ? 'active' : ''}
              onClick={() => {
                setScope('all');
                setPage(1);
              }}
            >
              All
            </button>
          </div>
        )}

        {filters.map((f) => (
          <select
            key={f.key}
            style={{ width: 'auto' }}
            value={active[f.key] ?? ''}
            onChange={(e) => {
              setActive((a) => ({ ...a, [f.key]: e.target.value }));
              setPage(1);
            }}
          >
            <option value="">{f.label}: all</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}

        <div className="topbar-spacer" />

        <button className="btn btn-sm" onClick={() => setShowColumns((s) => !s)}>
          Columns
        </button>
        <button className="btn btn-sm" onClick={exportCsv} disabled={!data?.rows.length}>
          Export
        </button>
        <button className="btn btn-sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {showColumns && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row">
            {columns.map((c) => (
              <label key={c.key} className="checkbox">
                <input
                  type="checkbox"
                  checked={!hidden.has(c.key)}
                  onChange={(e) =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (e.target.checked) next.delete(c.key);
                      else next.add(c.key);
                      return next;
                    })
                  }
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <ErrorBox error={error} />

      <div className="table-wrap">
        {loading && !data ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty title={emptyTitle} hint={emptyHint} />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {visible.map((c) => (
                  <th
                    key={c.key}
                    className={c.sortKey ? 'sortable' : ''}
                    style={{ width: c.width, textAlign: c.align }}
                    onClick={() => toggleSort(c)}
                  >
                    {c.label}
                    {sort === c.sortKey && (dir === 'asc' ? ' ↑' : ' ↓')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? 'clickable' : ''}
                  onClick={() => onRowClick?.(row)}
                >
                  {visible.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align }}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="pager">
          <span>
            {(data.page - 1) * data.pageSize + 1}–
            {Math.min(data.page * data.pageSize, data.total)} of {data.total}
          </span>
          <div className="row">
            <select
              style={{ width: 'auto' }}
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="mono">
              {data.page} / {data.pageCount}
            </span>
            <button
              className="btn btn-sm"
              disabled={data.page >= data.pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pulls plain text out of a rendered cell so Export matches what's on screen. */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join(' ');
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

function csvCell(value: string): string {
  const v = value.replace(/\s+/g, ' ').trim();
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
