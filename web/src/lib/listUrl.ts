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

export type ListScope = 'mine' | 'all';

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
 * A search-as-you-type pick from a list too long for a dropdown — a client,
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
    scope: scopeRaw === 'mine' || scopeRaw === 'all' ? scopeRaw : null,
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
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) return views;
  const at = views.findIndex((v) => v.name.toLowerCase() === clean.toLowerCase());
  if (at >= 0) return views.map((v, i) => (i === at ? { name: clean, query } : v));
  return [...views, { name: clean, query }];
}

/** Filters set, for the Filters button's badge — the tab strip shows its own. */
export function countActiveFilters(active: Record<string, string>, filters: FilterDef[]): number {
  return filters.filter((f) => !!active[f.key] || (f.type === 'dateRange' && !!active[f.toKey])).length;
}
