import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
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
 *
 * The list's state lives in the URL (rule 15). `?q=`, `?scope=`, `?page=` and
 * `?<filterKey>=` for every key the screen DECLARES in `filters` are read on
 * mount and written back on every change, with `replace` so the back button
 * still leaves the screen, and every key the list does not own (`new`,
 * `jobId`, `visit`, `payment`…) is preserved untouched. That is what makes a
 * dashboard tile's `/g-fin/ar?overdue=true` true rather than a link to an
 * unfiltered list — twenty of those were dead before this. URL wins over
 * `initialFilters` when both name a key; `pageSize` stays out of the URL.
 */

const OWN_KEYS = ['q', 'scope', 'page'] as const;

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
  /** Offered inside the empty state — usually the same button as `actions`. */
  emptyAction?: ReactNode;
  /**
   * Filters the screen starts with — for a menu entry that is one screen with
   * a preset, such as the three service-report menus.
   */
  initialFilters?: Record<string, string>;
  /** Bump to force a reload from outside (after a create, say). */
  reloadToken?: number;
  /**
   * Whether search, scope, page and filters are mirrored to the URL. On by
   * default; a screen that mounts two lists at once turns it off on one of
   * them so they do not fight over `?page=`.
   */
  urlState?: boolean;
  rowKey: (row: T) => string;
}

/** The URL's view of this list: only the keys it owns, only when present. */
function readUrl(
  params: URLSearchParams,
  filterKeys: string[],
): { q: string | null; scope: 'mine' | 'all' | null; page: number | null; filters: Record<string, string> } {
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const v = params.get(key);
    if (v) filters[key] = v;
  }
  const scopeRaw = params.get('scope');
  const pageRaw = Number(params.get('page'));
  return {
    q: params.get('q'),
    scope: scopeRaw === 'mine' || scopeRaw === 'all' ? scopeRaw : null,
    page: Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : null,
    filters,
  };
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
  emptyAction,
  initialFilters,
  reloadToken = 0,
  urlState = true,
  rowKey,
}: Props<T>) {
  const [data, setData] = useState<ListResult<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [params, setParams] = useSearchParams();
  const filterKeys = filters.map((f) => f.key);
  const filterKeysKey = filterKeys.join('|');
  // Read once for the initial state — the URL is the linked window, so the
  // first fetch is already the filtered one rather than a flash of everything.
  const initial = useRef(readUrl(params, filterKeys)).current;
  const fromUrl = urlState ? initial : { q: null, scope: null, page: null, filters: {} };

  const [search, setSearch] = useState(fromUrl.q ?? '');
  const [debounced, setDebounced] = useState(fromUrl.q ?? '');
  const [page, setPage] = useState(fromUrl.page ?? 1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [scope, setScope] = useState<'mine' | 'all'>(fromUrl.scope ?? 'all');
  const [active, setActive] = useState<Record<string, string>>({
    ...(initialFilters ?? {}),
    ...fromUrl.filters,
  });

  // A preset that changes because the route changed — Preventive Maintenance to
  // Service Inspections, say — is a different screen, not a filter the user set.
  const presetKey = JSON.stringify(initialFilters ?? {});
  const firstPreset = useRef(presetKey);
  useEffect(() => {
    if (presetKey === firstPreset.current) return;
    firstPreset.current = presetKey;
    setActive({ ...(initialFilters ?? {}), ...(urlState ? readUrl(params, filterKeys).filters : {}) });
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetKey]);

  /*
    Two-way with the URL. `lastWritten` is the query string this list last put
    there: when the URL changes to something else, the change came from
    outside — a tile on the same page linking to `?status=LATE` — and the list
    follows it. When it matches, it is our own write echoing back, and nothing
    happens. That one ref is what keeps the two directions from chasing each
    other.
  */
  const lastWritten = useRef<string | null>(null);
  useEffect(() => {
    if (!urlState) return;
    const current = params.toString();
    if (lastWritten.current === null) {
      // First render: the state was built from these params already.
      lastWritten.current = current;
      return;
    }
    if (current === lastWritten.current) return;
    lastWritten.current = current;
    const next = readUrl(params, filterKeys);
    setSearch(next.q ?? '');
    setDebounced(next.q ?? '');
    setPage(next.page ?? 1);
    setScope(next.scope ?? 'all');
    setActive({ ...(initialFilters ?? {}), ...next.filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, urlState, filterKeysKey]);

  useEffect(() => {
    if (!urlState) return;
    const next = new URLSearchParams(params);
    for (const key of OWN_KEYS) next.delete(key);
    for (const key of filterKeys) next.delete(key);
    if (debounced) next.set('q', debounced);
    if (scope !== 'all') next.set('scope', scope);
    if (page > 1) next.set('page', String(page));
    // A route preset (`initialFilters`) is the screen's own default, not a
    // choice the user made — it stays out of the URL so the menu path reads
    // the way the registry declares it. Only a departure from it is written.
    for (const key of filterKeys) {
      if (active[key] && active[key] !== initialFilters?.[key]) next.set(key, active[key]);
    }
    const encoded = next.toString();
    if (encoded === params.toString()) return;
    lastWritten.current = encoded;
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, scope, page, active, urlState, filterKeysKey]);

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
    // Nothing typed since the last settle — on mount, say, when both came
    // from the URL — so the page the link named must not be reset to 1.
    if (search === debounced) return;
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const activeFilterCount = Object.values(active).filter(Boolean).length;

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

        {/*
          Columns, Export and Refresh are the same three on every screen and
          are never why someone came here. Grouped to the right, and on a
          narrow screen they take a line of their own rather than squeezing
          the search box down to its minimum.
        */}
        <div className="list-tools">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowColumns((s) => !s)}
            aria-expanded={showColumns}
          >
            Columns
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={exportCsv}
            disabled={!data?.rows.length}
          >
            Export
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {/*
        A filtered list used to look exactly like an empty one. Three rows out
        of four hundred with nothing on screen explaining why is how people
        conclude their data has gone missing.
      */}
      {(activeFilterCount > 0 || debounced) && (
        <div className="filter-note">
          <span>
            {debounced && (
              <>
                Matching “<strong>{debounced}</strong>”
                {activeFilterCount > 0 ? ', ' : ''}
              </>
            )}
            {activeFilterCount > 0 &&
              `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied`}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setActive({});
              setSearch('');
              setDebounced('');
              setPage(1);
            }}
          >
            Clear all
          </button>
        </div>
      )}

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

      {/*
        `busy` is a reload over rows that are already on screen. It used to be
        silent: change a filter, and the old rows sat there looking like the
        answer until the new ones replaced them. Now the table dims and says so.
      */}
      <div className={`table-wrap${loading && data ? ' busy' : ''}`}>
        {loading && data && <div className="table-busy-bar" aria-hidden="true" />}
        {loading && !data ? (
          <Loading />
        ) : !data?.rows.length ? (
          <Empty
            /*
              "No customers yet" is a lie when there are four hundred of them
              and a filter is hiding all four hundred. Filtered-to-nothing and
              genuinely-empty are different situations and now say so.
            */
            title={activeFilterCount > 0 || debounced ? 'No matches' : emptyTitle}
            hint={
              activeFilterCount > 0 || debounced
                ? 'Nothing here matches the current search and filters.'
                : emptyHint
            }
            /*
              An empty state that offers nothing is a dead end, and it is the
              first thing a new user sees on most of these screens. Falling
              back to the toolbar's own actions means every list gets its
              primary button here without thirty pages repeating it — and when
              the list is empty only because of a filter, no action is offered,
              because the answer then is to clear the filter, not to create
              something.
            */
            action={activeFilterCount > 0 || debounced ? undefined : (emptyAction ?? actions)}
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {visible.map((c) => {
                  const sorted = c.sortKey && sort === c.sortKey;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={c.sortKey ? 'sortable' : ''}
                      style={{ width: c.width, textAlign: c.align }}
                      // aria-sort is how a screen reader announces which column
                      // orders the table and in which direction. It had none.
                      aria-sort={
                        !c.sortKey ? undefined : sorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      // A sortable header is a control, so it has to be
                      // reachable and operable without a mouse.
                      tabIndex={c.sortKey ? 0 : undefined}
                      role={c.sortKey ? 'button' : undefined}
                      onClick={() => toggleSort(c)}
                      onKeyDown={(e) => {
                        if (c.sortKey && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          toggleSort(c);
                        }
                      }}
                    >
                      {c.label}
                      {c.sortKey && (
                        <span className="sort-mark" aria-hidden="true">
                          {sorted ? (dir === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={onRowClick ? 'clickable' : ''}
                  onClick={() => onRowClick?.(row)}
                  // A row that opens a record is the primary action on most of
                  // these screens, and it was mouse-only.
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onRowClick(row);
                    }
                  }}
                >
                  {visible.map((c) => (
                    <td
                      key={c.key}
                      className={c.align === 'right' ? 'num' : undefined}
                      style={{ textAlign: c.align }}
                    >
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
