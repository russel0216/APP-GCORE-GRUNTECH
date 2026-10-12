/**
 * The list pattern's URL rules and filter shapes (rule 16), DOM-free so
 * verify-foundation can pin them without a browser.
 *
 * A list owns `?q=`, `?scope=`, `?page=` and one key per filter it DECLARES
 * (a date range declares two, its tab strip one). Every other key in the URL
 * belongs to somebody else — `new`, `customerId`, `visit`, `tab` — and is
 * left exactly as it was. Scope is written only when it differs from the
 * list's default, page only past 1, and a filter only when it differs from the
 * route's preset, so a menu entry keeps the path the registry declares.
 */

/** Mine · Team · All — `team` is offered only to a viewer whose employee record has a team (see `teamScope` on DataList). */
export type ListScope = 'mine' | 'team' | 'all';

export interface ListOption {
  value: string;
  label: string;
}

/** A dropdown: the value is one of `options`. */
export interface SelectFilterDef {
  key: string;
  label: string;
  type?: 'select';
  options: ListOption[];
}

/** Two dates, each 'YYYY-MM-DD', in two URL keys: `key` (from) and `toKey`. */
export interface DateRangeFilterDef {
  key: string;
  toKey: string;
  label: string;
  type: 'dateRange';
}

/**
 * A search-as-you-type pick from a list too long for a dropdown — a customer,
 * say. `search` answers a typed term; `describe` names a value that arrived
 * in the URL, so its chip reads as a name rather than an id.
 */
export interface LookupFilterDef {
  key: string;
  label: string;
  type: 'lookup';
  placeholder?: string;
  search: (term: string) => Promise<ListOption[]>;
  describe?: (value: string) => Promise<string | null>;
}

export type FilterDef = SelectFilterDef | DateRangeFilterDef | LookupFilterDef;

/** A strip of buttons over one key — SCORO's status bookmarks — each with its count. */
export interface TabsDef {
  key: string;
  /** What the strip is, for a screen reader: "Stages". */
  label?: string;
  /** The tab that clears the key. */
  allLabel?: string;
  /** The tabs before the first answer arrives; a list whose endpoint sends `summary.tabs` uses those. */
  options: (ListOption & { color?: string })[];
}

/** Every URL key a filter definition owns. */
export function filterKeysOf(filters: FilterDef[], tabs?: TabsDef | null): string[] {
  const keys = filters.flatMap((f) => (f.type === 'dateRange' ? [f.key, f.toKey] : [f.key]));
  if (tabs && !keys.includes(tabs.key)) keys.push(tabs.key);
  return keys;
}

export interface ListUrlState {
  q: string | null;
  scope: ListScope | null;
  page: number | null;
  filters: Record<string, string>;
}

/** The URL's view of a list: only the keys it owns, only when present. */
export function readListUrl(params: URLSearchParams, filterKeys: string[]): ListUrlState {
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const v = params.get(key);
    if (v) filters[key] = v;
  }
  const scopeRaw = params.get('scope');
  const pageRaw = Number(params.get('page'));
  return {
    q: params.get('q'),
    scope: scopeRaw === 'mine' || scopeRaw === 'team' || scopeRaw === 'all' ? scopeRaw : null,
    page: Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : null,
    filters,
  };
}

export interface ListState {
  q: string;
  scope: ListScope;
  page: number;
  active: Record<string, string>;
}

/**
 * The URL after the list's own state is written into `params`: every key the
 * list does not own kept as it was, the list's own keys rewritten.
 */
export function writeListUrl(
  params: URLSearchParams,
  state: ListState,
  opts: { filterKeys: string[]; defaultScope: ListScope; presets?: Record<string, string> },
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['q', 'scope', 'page', ...opts.filterKeys]) next.delete(key);
  if (state.q) next.set('q', state.q);
  if (state.scope !== opts.defaultScope) next.set('scope', state.scope);
  if (state.page > 1) next.set('page', String(state.page));
  for (const key of opts.filterKeys) {
    const v = state.active[key];
    if (v && v !== opts.presets?.[key]) next.set(key, v);
  }
  return next;
}

/**
 * The filters a list opens with (2026-10-11, the owner's call: "default view
 * of quotation, leads, sales order is year to date"): the route's presets,
 * then the screen's DEFAULTS only on a bare visit — a URL naming no search
 * and none of the list's filters — then whatever the URL says. A link that
 * filters (a dashboard tile, the Forecast's closing dates) is never narrowed
 * further by a default, so its count and the list's total stay one query.
 * Unlike a preset, a default is written to the URL like any filter the person
 * set, so removing its chip shows everything and Back returns to it.
 */
export function startFilters(
  url: Pick<ListUrlState, 'q' | 'filters'>,
  presets: Record<string, string> | undefined,
  defaults: Record<string, string> | undefined,
): Record<string, string> {
  const bare = !url.q && Object.keys(url.filters).length === 0;
  return { ...(presets ?? {}), ...(bare ? (defaults ?? {}) : {}), ...url.filters };
}

/** Year to date as a date range's FROM key: the first of January of `today`'s year ('YYYY-01-01', local). */
export function yearStartKey(today: Date): string {
  return `${today.getFullYear()}-01-01`;
}

/**
 * A saved view: the list's search, scope and filters as a query string — no
 * page, and nothing the list does not own. Kept per viewer in the browser.
 */
export interface SavedView {
  name: string;
  query: string;
}

export function viewQuery(state: Omit<ListState, 'page'>, filterKeys: string[]): string {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  p.set('scope', state.scope);
  for (const key of filterKeys) if (state.active[key]) p.set(key, state.active[key]);
  return p.toString();
}

/** A saved view read back: its search, scope (else the default) and filters. */
export function readView(query: string, filterKeys: string[], defaultScope: ListScope): Omit<ListState, 'page'> {
  const parsed = readListUrl(new URLSearchParams(query), filterKeys);
  return { q: parsed.q ?? '', scope: parsed.scope ?? defaultScope, active: parsed.filters };
}

/**
 * The views list after saving `name`: a view of the same name (case-blind) is
 * replaced in place, a new one goes last, and a blank name saves nothing.
 */
export function saveView(views: SavedView[], name: string, query: string): SavedView[] {
  const clean = cleanViewName(name);
  if (!clean) return views;
  const at = views.findIndex((v) => v.name.toLowerCase() === clean.toLowerCase());
  if (at >= 0) return views.map((v, i) => (i === at ? { name: clean, query } : v));
  return [...views, { name: clean, query }];
}

// ── Your own views (2026-10-12) ──────────────────────────────────────────────
// The owner's call: "custom column and save so this will be the one who always
// pops up during viewing of list by user". A view is kept on the person's
// account (`/api/saved-filters/:listKey`), carries the columns it hides beside
// the search, scope and filters, and one of them may be the list's OPENING
// view — applied on a bare visit, as `defaultFilters` are, and in their place.

/** A view as the list holds it: `query` is `viewQuery()`'s string. */
export interface ListView extends SavedView {
  id: string;
  /** The columns it hides; null keeps whatever columns the person has on. */
  hidden: string[] | null;
  isDefault: boolean;
}

/** A view's name as it is kept: trimmed, single-spaced, at most 40 characters. */
export function cleanViewName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * A bare visit: the URL names no search, no scope and none of the list's
 * filters — the menu entry, not a link. Only a bare visit opens on a view;
 * a link that says what it wants is never changed under it.
 */
export function isBareVisit(url: Pick<ListUrlState, 'q' | 'scope' | 'filters'>): boolean {
  return !url.q && !url.scope && Object.keys(url.filters).length === 0;
}

/** The view a list opens with: the person's opening view on a bare visit, else none. */
export function openingView<V extends { isDefault: boolean }>(
  url: Pick<ListUrlState, 'q' | 'scope' | 'filters'>,
  views: V[],
): V | null {
  if (!isBareVisit(url)) return null;
  return views.find((v) => v.isDefault) ?? null;
}

/**
 * The columns a view hides, kept to the list's own column keys — a column
 * since removed from the screen is dropped, never an error. A view that
 * would hide every column hides none (a table of nothing is not a choice).
 */
export function viewHidden(hidden: unknown, columnKeys: string[]): string[] | null {
  if (!Array.isArray(hidden)) return null;
  const known = new Set(columnKeys);
  const kept = [...new Set(hidden.filter((k): k is string => typeof k === 'string' && known.has(k)))];
  return kept.length >= columnKeys.length ? [] : kept;
}

/**
 * A filter a view took from the list's defaults is kept as the DEFAULT, not
 * its value of the day: a view saved on year to date is still year to date
 * next January, not 1 January of the year it was saved. `DEFAULT_TOKEN`
 * stands for it in the stored query; `fillDefaults` puts today's value back.
 */
export const DEFAULT_TOKEN = '@default';

export function keepDefaults(query: string, defaults: Record<string, string> | undefined): string {
  if (!defaults) return query;
  const p = new URLSearchParams(query);
  for (const [k, v] of Object.entries(defaults)) if (v && p.get(k) === v) p.set(k, DEFAULT_TOKEN);
  return p.toString();
}

export function fillDefaults(query: string, defaults: Record<string, string> | undefined): string {
  const p = new URLSearchParams(query);
  for (const [k, v] of [...p.entries()]) {
    if (v !== DEFAULT_TOKEN) continue;
    if (defaults?.[k]) p.set(k, defaults[k]);
    else p.delete(k);
  }
  return p.toString();
}

/** A view's query as the API keeps it (an object) and as the list compares it (a string). */
export function queryObject(query: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(query));
}
export function queryString(query: unknown): string | null {
  if (typeof query === 'string') return query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) if (typeof v === 'string' && v) p.set(k, v);
  return p.toString();
}

/** Filters set, for the Filters button's badge — the tab strip shows its own. */
export function countActiveFilters(active: Record<string, string>, filters: FilterDef[]): number {
  return filters.filter((f) => !!active[f.key] || (f.type === 'dateRange' && !!active[f.toKey])).length;
}

// ── Selection (mass actions, 2026-10-08) ─────────────────────────────────────
// A person ticks rows, page by page; the selection is a set of row keys and
// outlives a page change, but not a change of search, scope or filters — a
// selection of rows the list no longer shows would act on things off screen.

/** The most rows one selection may hold — the server's `ids` cap. */
export const MAX_SELECTED = 500;

/** The header box: none, some (indeterminate) or all of this page's rows ticked. */
export function pageSelection(pageKeys: string[], selected: ReadonlySet<string>): 'none' | 'some' | 'all' {
  const on = pageKeys.filter((k) => selected.has(k)).length;
  if (on === 0) return 'none';
  return on === pageKeys.length ? 'all' : 'some';
}

/**
 * The header box clicked: a page that is all ticked is cleared; otherwise
 * every row on it is ticked, up to MAX_SELECTED in all. Rows on other pages
 * are kept either way.
 */
export function togglePage(pageKeys: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (pageSelection(pageKeys, selected) === 'all') {
    for (const k of pageKeys) next.delete(k);
    return next;
  }
  for (const k of pageKeys) {
    if (next.size >= MAX_SELECTED) break;
    next.add(k);
  }
  return next;
}
