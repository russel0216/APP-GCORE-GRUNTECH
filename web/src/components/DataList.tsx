import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, openPdf, qs, type ListResult, type ListSummary } from '../lib/api';
import { parseDay, todayLocal } from '../lib/day';
import {
  MAX_SELECTED,
  countActiveFilters,
  filterKeysOf,
  pageSelection,
  togglePage,
  readListUrl,
  readView,
  saveView,
  viewQuery,
  writeListUrl,
  type DateRangeFilterDef,
  type FilterDef,
  type ListOption,
  type ListScope,
  type LookupFilterDef,
  type SavedView,
  type TabsDef,
} from '../lib/listUrl';
import { Menu } from './Menu';
import { Empty, ErrorBox, Loading, formatDate } from './ui';

export type { FilterDef, TabsDef, ListOption } from '../lib/listUrl';

/** What a screen's own mass actions are handed: the ticked rows, and ways to finish. */
export interface BulkContext<T> {
  /** Every ticked row, across pages, in the order they were ticked. */
  rows: T[];
  /** Untick everything. */
  clear: () => void;
  /** Keep only these rows ticked — the ones an action could not finish, say. */
  keep: (keys: string[]) => void;
  /** Fetch the list again. */
  reload: () => void;
}

/**
 * The shared list pattern (model §8.4).
 *
 * "All list on menu have the same format, search bar arrange by category."
 * Every list screen in G-Core — quotations, purchase requests, employees,
 * inventory — renders through this component. Build it once, and the
 * twentieth list screen costs a column definition rather than a week.
 *
 * The toolbar has two weights (2026-10-08, after SCORO's list of quotes). On
 * the left, what somebody came for: the screen's own New, the search box, the
 * Mine/All switch and one Filters button that opens every filter in a panel.
 * On the right, one "..." menu with the tools nobody came for: Columns,
 * Export CSV, Print (where the screen has a printed list), Save view and
 * Refresh. Under the toolbar, an optional tab strip over one filter key — the
 * quotation list's stages, each with its count — then a chip for every filter
 * on, each removable, then the table, then the totals line.
 *
 * The list's state lives in the URL (rule 16, `lib/listUrl.ts`). `?q=`,
 * `?scope=`, `?page=` and every key the screen DECLARES — its filters, a date
 * range's two keys, its tab key — are read on mount and written back on every
 * change, with `replace` so the back button still leaves the screen, and
 * every key the list does not own (`new`, `jobId`, `visit`, `payment`…) is
 * preserved untouched. URL wins over `initialFilters` and over
 * `defaultScope`; neither default is written back, so a menu entry keeps the
 * path the registry declares. `pageSize` and sort stay out of the URL.
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

interface Props<T> {
  /** Stable id used for saved views and column preferences. */
  listKey: string;
  endpoint: string;
  columns: Column<T>[];
  filters?: FilterDef[];
  /** A strip of tabs over one filter key, each with the count the endpoint's `summary.tabCounts` gives it. */
  tabs?: TabsDef;
  searchPlaceholder?: string;
  /** Shows the Mine/All switch — for records that have an owner. */
  scoped?: boolean;
  /** Where the switch starts when the URL says nothing. */
  defaultScope?: ListScope;
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
  /**
   * The printed list, a full path such as `/api/quotations/pdf`. It is sent
   * the list's own query — search, scope, sort and every filter — so the
   * paper is the screen. Offered as Print in the "..." menu, and — with the
   * ticked rows' keys as `?ids=` — as Print selected, so the endpoint must
   * honour `ids` (`idsFilter()` in api/src/http/kit.ts) and `rowKey` must be
   * the record id.
   */
  printPath?: string;
  /**
   * Tick boxes on the rows and a bar of mass actions over the table (SCORO's
   * mass actions): Export selected, Print selected where there is a
   * `printPath`, and the screen's own `bulkActions`. Never a bulk delete — a
   * record is deleted from its own page, with its own refusals.
   */
  selectable?: boolean;
  bulkActions?: (ctx: BulkContext<T>) => ReactNode;
  /** How a row is named to a screen reader on its tick box ("Select 0062602018"). */
  rowLabel?: (row: T) => string;
  /**
   * The screen's own tools for the "..." menu — an Import, say — listed above
   * Columns. A tool goes here, never back on the toolbar line (rule 9).
   */
  menuItems?: { label: string; hint?: string; onSelect: () => void }[];
  /** The totals line under the table, from the endpoint's `summary` and the filtered total. */
  summaryLine?: (summary: ListSummary, total: number) => ReactNode;
  /** Told each time a fetch brings a summary — for a screen that learns from it (the partners' categories). */
  onSummary?: (summary: ListSummary) => void;
  rowKey: (row: T) => string;
}

export function DataList<T>({
  listKey,
  endpoint,
  columns,
  filters = [],
  tabs,
  searchPlaceholder = 'Search…',
  scoped = false,
  defaultScope = 'all',
  onRowClick,
  actions,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  emptyAction,
  initialFilters,
  reloadToken = 0,
  urlState = true,
  printPath,
  selectable = false,
  bulkActions,
  rowLabel,
  menuItems = [],
  summaryLine,
  onSummary,
  rowKey,
}: Props<T>) {
  const [data, setData] = useState<ListResult<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [params, setParams] = useSearchParams();
  const filterKeys = filterKeysOf(filters, tabs);
  const filterKeysKey = filterKeys.join('|');
  // Read once for the initial state — the URL is the linked window, so the
  // first fetch is already the filtered one rather than a flash of everything.
  const initial = useRef(readListUrl(params, filterKeys)).current;
  const fromUrl = urlState ? initial : { q: null, scope: null, page: null, filters: {} };

  const [search, setSearch] = useState(fromUrl.q ?? '');
  const [debounced, setDebounced] = useState(fromUrl.q ?? '');
  const [page, setPage] = useState(fromUrl.page ?? 1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [scope, setScope] = useState<ListScope>(fromUrl.scope ?? defaultScope);
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
    setActive({ ...(initialFilters ?? {}), ...(urlState ? readListUrl(params, filterKeys).filters : {}) });
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
    const next = readListUrl(params, filterKeys);
    setSearch(next.q ?? '');
    setDebounced(next.q ?? '');
    setPage(next.page ?? 1);
    setScope(next.scope ?? defaultScope);
    setActive({ ...(initialFilters ?? {}), ...next.filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, urlState, filterKeysKey]);

  useEffect(() => {
    if (!urlState) return;
    const next = writeListUrl(
      params,
      { q: debounced, scope, page, active },
      { filterKeys, defaultScope, presets: initialFilters },
    );
    const encoded = next.toString();
    if (encoded === params.toString()) return;
    lastWritten.current = encoded;
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, scope, page, active, urlState, filterKeysKey]);

  /*
    The ticked rows, by key, kept with the row itself so a selection that
    spans pages can still be exported and acted on. It outlives a page
    change, never a change of search, scope or filters: acting on rows the
    list no longer shows is acting on things off screen.
  */
  const [selected, setSelected] = useState<Map<string, T>>(() => new Map());
  const selectionScope = JSON.stringify([debounced, scope, active]);
  const lastSelectionScope = useRef(selectionScope);
  useEffect(() => {
    if (lastSelectionScope.current === selectionScope) return;
    lastSelectionScope.current = selectionScope;
    setSelected(new Map());
  }, [selectionScope]);

  const [panel, setPanel] = useState<'filters' | 'columns' | 'save' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

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

  // Saved views are the same kind of convenience: one viewer's, one browser's.
  const [views, setViews] = useState<SavedView[]>(() => {
    try {
      const raw = localStorage.getItem(`gcore_views_${listKey}`);
      const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
      return Array.isArray(parsed) ? parsed.filter((v) => v && typeof v.name === 'string' && typeof v.query === 'string') : [];
    } catch {
      return [];
    }
  });
  function storeViews(next: SavedView[]) {
    setViews(next);
    try {
      localStorage.setItem(`gcore_views_${listKey}`, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  const [viewName, setViewName] = useState('');

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

  /** The list's own query — rows, summary and the printed list all read it. */
  const filterQuery = useMemo(
    () => ({ search: debounced, sort, dir, scope, ...active }),
    [debounced, sort, dir, scope, active],
  );
  const query = useMemo(() => qs({ page, pageSize, ...filterQuery }), [page, pageSize, filterQuery]);

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

  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;
  useEffect(() => {
    if (data?.summary) onSummaryRef.current?.(data.summary);
  }, [data]);

  // A ticked row on the page just fetched is replaced by its fresh copy, so a
  // mass action never plans from a status the row no longer has.
  useEffect(() => {
    if (!data) return;
    setSelected((cur) => {
      if (!cur.size) return cur;
      let changed = false;
      const next = new Map(cur);
      for (const row of data.rows) {
        const key = rowKey(row);
        if (next.has(key) && next.get(key) !== row) {
          next.set(key, row);
          changed = true;
        }
      }
      return changed ? next : cur;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const visible = columns.filter((c) => !hidden.has(c.key));
  const anyActive = Object.values(active).some(Boolean);
  const filterCount = countActiveFilters(active, filters);

  function setFilter(key: string, value: string) {
    setActive((a) => ({ ...a, [key]: value }));
    setPage(1);
  }

  function clearAll() {
    setActive({});
    setSearch('');
    setDebounced('');
    setPage(1);
  }

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
    a.download = `${listKey}-${todayLocal()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function print() {
    if (!printPath) return;
    openPdf(`${printPath}${qs(filterQuery)}`, () => setError(new Error('The printed list could not be opened')));
  }

  const selectedRows = [...selected.values()];
  const pageKeys = (data?.rows ?? []).map(rowKey);
  const headState = pageSelection(pageKeys, new Set(selected.keys()));

  function toggleRow(row: T) {
    const key = rowKey(row);
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(key)) next.delete(key);
      else if (next.size < MAX_SELECTED) next.set(key, row);
      return next;
    });
  }

  function toggleHead() {
    const rows = data?.rows ?? [];
    setSelected((cur) => {
      const keys = togglePage(pageKeys, new Set(cur.keys()));
      const next = new Map<string, T>();
      for (const [k, v] of cur) if (keys.has(k)) next.set(k, v);
      for (const r of rows) if (keys.has(rowKey(r)) && !next.has(rowKey(r))) next.set(rowKey(r), r);
      return next;
    });
  }

  const bulk: BulkContext<T> = {
    rows: selectedRows,
    clear: () => setSelected(new Map()),
    keep: (keys) =>
      setSelected((cur) => {
        const next = new Map<string, T>();
        for (const k of keys) {
          const row = cur.get(k);
          if (row) next.set(k, row);
        }
        return next;
      }),
    reload: () => void load(),
  };

  function exportSelected() {
    const header = visible.map((c) => c.label);
    const lines = selectedRows.map((row) => visible.map((c) => csvCell(extractText(c.render(row)))).join(','));
    const csv = [header.map(csvCell).join(','), ...lines].join('\r\n');
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${listKey}-selected-${todayLocal()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printSelected() {
    if (!printPath || !selected.size) return;
    // Exactly the ticked rows, in the list's order; the server still applies
    // its visibility rule, so a key never prints what the caller cannot see.
    openPdf(`${printPath}${qs({ ids: [...selected.keys()].join(','), sort, dir, scope: 'all' })}`, () =>
      setError(new Error('The printed selection could not be opened')),
    );
  }

  const currentView = viewQuery({ q: debounced, scope, active }, filterKeys);

  function applyView(view: SavedView) {
    const v = readView(view.query, filterKeys, defaultScope);
    setSearch(v.q);
    setDebounced(v.q);
    setScope(v.scope);
    setActive({ ...(initialFilters ?? {}), ...v.active });
    setPage(1);
  }

  // Names for the chips of lookup filters: the label picked, or what
  // `describe` says a value from the URL is called.
  const [lookupLabels, setLookupLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const f of filters) {
      if (f.type !== 'lookup' || !f.describe) continue;
      const value = active[f.key];
      if (!value || lookupLabels[`${f.key}=${value}`]) continue;
      f.describe(value)
        .then((name) => {
          if (name) setLookupLabels((l) => ({ ...l, [`${f.key}=${value}`]: name }));
        })
        .catch(() => {
          /* the chip then says "selected"; nothing worth an error */
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, filterKeysKey]);

  const chips = filters.flatMap((f) => {
    if (f.type === 'dateRange') {
      const from = active[f.key];
      const to = active[f.toKey];
      if (!from && !to) return [];
      const text = from && to ? `${day(from)} – ${day(to)}` : from ? `from ${day(from)}` : `to ${day(to!)}`;
      return [{ id: f.key, text: `${f.label}: ${text}`, clear: () => clearRange(f) }];
    }
    const value = active[f.key];
    if (!value) return [];
    const name =
      f.type === 'lookup'
        ? (lookupLabels[`${f.key}=${value}`] ?? 'selected')
        : (f.options.find((o) => o.value === value)?.label ?? value);
    return [{ id: f.key, text: `${f.label}: ${name}`, clear: () => setFilter(f.key, '') }];
  });

  function clearRange(f: DateRangeFilterDef) {
    setActive((a) => ({ ...a, [f.key]: '', [f.toKey]: '' }));
    setPage(1);
  }

  const tabCounts = data?.summary?.tabCounts;
  const tabOptions = data?.summary?.tabs ?? tabs?.options ?? [];

  return (
    <div>
      <div className="list-toolbar">
        {actions}

        <input
          className="list-search"
          type="search"
          placeholder={searchPlaceholder}
          aria-label="Search this list"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {scoped && (
          <div className="scope-switch" role="group" aria-label="Whose records">
            <button
              type="button"
              className={scope === 'mine' ? 'active' : ''}
              aria-pressed={scope === 'mine'}
              onClick={() => {
                setScope('mine');
                setPage(1);
              }}
            >
              Mine
            </button>
            <button
              type="button"
              className={scope === 'all' ? 'active' : ''}
              aria-pressed={scope === 'all'}
              onClick={() => {
                setScope('all');
                setPage(1);
              }}
            >
              All
            </button>
          </div>
        )}

        {filters.length > 0 && (
          <button
            type="button"
            className="btn btn-sm list-filter-button"
            aria-expanded={panel === 'filters'}
            aria-controls={`${listKey}-filters`}
            onClick={() => setPanel((p) => (p === 'filters' ? null : 'filters'))}
          >
            Filters
            {filterCount > 0 && (
              <span className="list-filter-count" aria-label={`${filterCount} on`}>
                {filterCount}
              </span>
            )}
          </button>
        )}

        <div className="list-tools">
          <div className="menu-wrap">
            <button
              ref={menuButton}
              type="button"
              className="btn btn-sm"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More list tools"
              title="Columns, export, print, saved views"
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </button>
            {menuOpen && (
              <Menu
                label="List tools"
                onClose={() => {
                  setMenuOpen(false);
                  menuButton.current?.focus();
                }}
              >
                {menuItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                    {item.hint && <span className="menu-pop-why">{item.hint}</span>}
                  </button>
                ))}
                {menuItems.length > 0 && <div role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setPanel((p) => (p === 'columns' ? null : 'columns'));
                  }}
                >
                  Columns…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-disabled={!data?.rows.length}
                  onClick={() => {
                    if (!data?.rows.length) return;
                    setMenuOpen(false);
                    exportCsv();
                  }}
                >
                  Export CSV
                  <span className="menu-pop-why">The rows on this page, as shown</span>
                </button>
                {printPath && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      print();
                    }}
                  >
                    Print list
                    <span className="menu-pop-why">Every row the search and filters select</span>
                  </button>
                )}
                <div role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setViewName('');
                    setPanel('save');
                  }}
                >
                  Save view…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void load();
                  }}
                >
                  Refresh
                </button>
              </Menu>
            )}
          </div>
        </div>
      </div>

      {panel === 'filters' && filters.length > 0 && (
        <section id={`${listKey}-filters`} className="card list-filter-panel" aria-label="Filters">
          {filters.map((f) =>
            f.type === 'dateRange' ? (
              <div key={f.key} className="list-filter-field" role="group" aria-labelledby={`${listKey}-f-${f.key}`}>
                <span id={`${listKey}-f-${f.key}`}>{f.label}</span>
                <span className="list-date-range">
                    <input
                      type="date"
                      aria-label={`${f.label} from`}
                      value={active[f.key] ?? ''}
                      max={active[f.toKey] || undefined}
                      onChange={(e) => setFilter(f.key, e.target.value)}
                    />
                    <span aria-hidden="true">to</span>
                    <input
                      type="date"
                      aria-label={`${f.label} to`}
                      value={active[f.toKey] ?? ''}
                      min={active[f.key] || undefined}
                      onChange={(e) => setFilter(f.toKey, e.target.value)}
                    />
                </span>
              </div>
            ) : f.type === 'lookup' ? (
              <LookupFilter
                key={f.key}
                def={f}
                value={active[f.key] ?? ''}
                label={active[f.key] ? lookupLabels[`${f.key}=${active[f.key]}`] : undefined}
                onPick={(o) => {
                  if (o) setLookupLabels((l) => ({ ...l, [`${f.key}=${o.value}`]: o.label }));
                  setFilter(f.key, o?.value ?? '');
                }}
              />
            ) : (
              <label key={f.key} className="list-filter-field">
                {f.label}
                <select value={active[f.key] ?? ''} onChange={(e) => setFilter(f.key, e.target.value)}>
                  <option value="">All</option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ),
          )}
        </section>
      )}

      {panel === 'columns' && (
        <section className="card list-columns-panel row" aria-label="Columns">
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
        </section>
      )}

      {panel === 'save' && (
        <form
          className="list-save-view"
          onSubmit={(e) => {
            e.preventDefault();
            if (!viewName.trim()) return;
            storeViews(saveView(views, viewName, currentView));
            setPanel(null);
          }}
        >
          <input
            autoFocus
            type="text"
            maxLength={40}
            placeholder="Name this view, e.g. My open deals"
            aria-label="View name"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPanel(null);
            }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!viewName.trim()}>
            Save view
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel(null)}>
            Cancel
          </button>
          <span className="faint">Keeps this search, Mine/All and the filters, in this browser.</span>
        </form>
      )}

      {views.length > 0 && (
        <div className="list-views" aria-label="Saved views">
          <span>Views:</span>
          {views.map((v) => (
            <span key={v.name} className={`list-chip${v.query === currentView ? ' view-active' : ''}`}>
              <button
                type="button"
                className="view-apply"
                aria-pressed={v.query === currentView}
                onClick={() => applyView(v)}
              >
                {v.name}
              </button>
              <button
                type="button"
                aria-label={`Forget the view ${v.name}`}
                onClick={() => storeViews(views.filter((x) => x.name !== v.name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {tabs && (
        <nav className="list-tabs" aria-label={tabs.label ?? 'Narrow the list'}>
          {[{ value: '', label: tabs.allLabel ?? 'All', color: undefined as string | undefined }, ...tabOptions].map(
            (o) => {
              const on = (active[tabs.key] ?? '') === o.value;
              const count = tabCounts?.[o.value];
              return (
                <button
                  key={o.value || 'all'}
                  type="button"
                  className="list-tab"
                  aria-pressed={on}
                  // A CSS variable, not a raw value: the tab's own colour.
                  style={o.color ? ({ '--tab-color': o.color } as CSSProperties) : undefined}
                  onClick={() => setFilter(tabs.key, o.value)}
                >
                  {o.color && <span className="list-tab-dot" aria-hidden="true" />}
                  {o.label}
                  {count !== undefined && <span className="list-tab-count">{count}</span>}
                </button>
              );
            },
          )}
        </nav>
      )}

      {/*
        A filtered list used to look exactly like an empty one. Three rows out
        of four hundred with nothing on screen explaining why is how people
        conclude their data has gone missing. One chip per filter, each
        removable, and the way out of all of them.
      */}
      {(chips.length > 0 || debounced) && (
        <div className="list-chips" aria-label="What narrows this list">
          {debounced && (
            <span className="list-chip">
              Matching “{debounced}”
              <button
                type="button"
                aria-label="Clear the search"
                onClick={() => {
                  setSearch('');
                  setDebounced('');
                  setPage(1);
                }}
              >
                ×
              </button>
            </span>
          )}
          {chips.map((c) => (
            <span key={c.id} className="list-chip">
              {c.text}
              <button type="button" aria-label={`Remove ${c.text}`} onClick={c.clear}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}

      {selectable && selected.size > 0 && (
        <div className="list-bulk" role="region" aria-label="Mass actions">
          <span className="list-bulk-count">
            <strong>{selected.size}</strong> selected
            {selected.size >= MAX_SELECTED ? ` (the most at once)` : ''}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={bulk.clear}>
            Clear selection
          </button>
          <button type="button" className="btn btn-sm" onClick={exportSelected}>
            Export selected
          </button>
          {printPath && (
            <button type="button" className="btn btn-sm" onClick={printSelected}>
              Print selected
            </button>
          )}
          {bulkActions?.(bulk)}
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
            title={anyActive || debounced ? 'No matches' : emptyTitle}
            hint={anyActive || debounced ? 'Nothing here matches the current search and filters.' : emptyHint}
            /*
              An empty state that offers nothing is a dead end, and it is the
              first thing a new user sees on most of these screens. Falling
              back to the toolbar's own actions means every list gets its
              primary button here without thirty pages repeating it — and when
              the list is empty only because of a filter, no action is offered,
              because the answer then is to clear the filter, not to create
              something.
            */
            action={anyActive || debounced ? undefined : (emptyAction ?? actions)}
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                {selectable && (
                  <th scope="col" className="list-select">
                    <input
                      type="checkbox"
                      aria-label={headState === 'all' ? 'Untick every row on this page' : 'Tick every row on this page'}
                      checked={headState === 'all'}
                      ref={(el) => {
                        if (el) el.indeterminate = headState === 'some';
                      }}
                      onChange={toggleHead}
                    />
                  </th>
                )}
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
                  className={`${onRowClick ? 'clickable' : ''}${selected.has(rowKey(row)) ? ' selected' : ''}`}
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
                  {selectable && (
                    <td
                      className="list-select"
                      // The box is its own control: ticking it never opens the record.
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${rowLabel ? rowLabel(row) : 'this row'}`}
                        checked={selected.has(rowKey(row))}
                        disabled={!selected.has(rowKey(row)) && selected.size >= MAX_SELECTED}
                        onChange={() => toggleRow(row)}
                      />
                    </td>
                  )}
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

      {summaryLine && data?.summary && data.total > 0 && (
        <div className="list-totals" aria-live="polite">
          {summaryLine(data.summary, data.total)}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="pager">
          <span>
            {(data.page - 1) * data.pageSize + 1}–
            {Math.min(data.page * data.pageSize, data.total)} of {data.total}
          </span>
          <div className="row">
            <select
              style={{ width: 'auto' }}
              aria-label="Rows per page"
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

/** A day key as the app prints a date — local midnight, never `new Date('YYYY-MM-DD')`. */
function day(key: string): string {
  return formatDate(parseDay(key));
}

/**
 * A search-as-you-type filter: type, pick a result, and the list narrows.
 * The results are buttons, so ↓/Tab reach them and Enter picks one.
 */
function LookupFilter({
  def,
  value,
  label,
  onPick,
}: {
  def: LookupFilterDef;
  value: string;
  label: string | undefined;
  onPick: (option: ListOption | null) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ListOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The screen rebuilds its filter list on render; only the term should start a search.
  const search = useRef(def.search);
  search.current = def.search;

  useEffect(() => {
    if (!term.trim()) {
      setResults(null);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      search
        .current(term.trim())
        .then((r) => {
          if (!stale) {
            setResults(r);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!stale) {
            setResults([]);
            setFailed(true);
          }
        });
    }, 220);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [term]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setResults(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div className="list-lookup list-filter-field" ref={box}>
      <span id={`lookup-${def.key}`}>{def.label}</span>
      {value ? (
          <span className="list-chip">
            {label ?? 'selected'}
            <button type="button" aria-label={`Clear ${def.label}`} onClick={() => onPick(null)}>
              ×
            </button>
          </span>
        ) : (
          <input
            type="search"
            aria-labelledby={`lookup-${def.key}`}
            placeholder={def.placeholder ?? 'Type to search…'}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                box.current?.querySelector<HTMLButtonElement>('.list-lookup-results button')?.focus();
              } else if (e.key === 'Escape') {
                setResults(null);
              }
            }}
          />
        )}
      {!value && results && (
        <ul className="list-lookup-results">
          {results.length === 0 ? (
            <li className="faint">{failed ? 'Not available to you' : 'Nothing matches'}</li>
          ) : (
            results.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(o);
                    setTerm('');
                    setResults(null);
                  }}
                  onKeyDown={(e) => {
                    const items = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('.list-lookup-results button') ?? []);
                    const i = items.indexOf(e.currentTarget);
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      items[(i + 1) % items.length]?.focus();
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      items[(i - 1 + items.length) % items.length]?.focus();
                    } else if (e.key === 'Escape') {
                      setResults(null);
                    }
                  }}
                >
                  {o.label}
                </button>
              </li>
            ))
          )}
        </ul>
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
