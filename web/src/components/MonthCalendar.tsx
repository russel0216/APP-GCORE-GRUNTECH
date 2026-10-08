import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Tone } from './ui';
import {
  addDays,
  addMonthsKey,
  isDayKey,
  isMonthKey,
  lastOfMonth,
  mondayOf,
  monthGrid,
  monthOf,
  parseDay,
  todayLocal,
  weekDays,
  windowFor,
} from '../lib/day';

/**
 * The one month grid.
 *
 * Sales activities, service visits and training sessions each wanted a month
 * view, and each would have drawn its own. This file knows nothing about any
 * of them: a caller hands it `CalendarEvent`s already bucketed on a local day
 * key and already toned through `statusTone()`, and gets back a grid that is
 * readable without colour (every chip carries its words), reachable from a
 * keyboard (one roving tab stop, arrows between days) and honest when empty.
 *
 * Position lives in the URL — `?view=&month=&week=` — so a reload keeps the
 * month, the browser's back button undoes a view switch, and a notification
 * can link straight to a day with `?date=`. Nothing is remembered in the
 * browser; a calendar that opens on the month you last looked at is a
 * calendar that opens on the wrong month.
 */

export interface CalendarEvent {
  id: string;
  /** Local day key 'YYYY-MM-DD' — the only thing the grid buckets on. */
  date: string;
  /** Epoch ms for ordering inside a day; undefined = all-day, sorts first. */
  sortAt?: number;
  /** DISPLAY label only ('09:00 AM'); null = all-day. */
  time?: string | null;
  /** Line 1. */
  label: string;
  /** Line 2, hidden under 860px. */
  detail?: string;
  /** The caller derives it with statusTone(status, extra) — never inline. */
  tone?: Tone;
  /** Dims the chip. */
  done?: boolean;
  /** Epoch ms of the end, for the time grid's block height; undefined = an hour. */
  endAt?: number;
  /** The activity type's own colour (#RRGGBB) — the chip's edge; the tone still says done or cancelled. */
  color?: string;
}

/** Day (2026-10-08, the time scale), week and month. */
export type CalendarView = 'day' | 'week' | 'month';

export interface CalendarNav {
  view: CalendarView;
  /** The views this page offers; the toolbar hides its switch when there is one. */
  views: readonly CalendarView[];
  /** 'YYYY-MM' (meaningful when view === 'month'). */
  month: string;
  /** Monday 'YYYY-MM-DD' (meaningful when view === 'week'). */
  week: string;
  /** 'YYYY-MM-DD' (meaningful when view === 'day'); otherwise the focus. */
  day: string;
  /** The roving-tabindex day, ALWAYS inside the current grid/week/day. */
  focus: string;
  /** Memoised on [view, month, week, day]; to = last grid day 23:59:59.999 local. */
  from: Date;
  to: Date;
  /** 'month:2026-09' | 'week:2026-09-21' | 'day:2026-09-23' — fetch effects depend on THIS, never on from/to. */
  windowKey: string;
  /** 'September 2026' | '21 Sep — 27 Sep 2026' | 'Wednesday, 23 September 2026'. */
  label: string;
  /** Pushes history; sets month = monthOf(focus) / week = mondayOf(focus) / day = focus. */
  setView(v: CalendarView): void;
  /** Replace history; ALWAYS write ?view= too. */
  prev(): void;
  next(): void;
  today(): void;
  /** React state only. */
  setFocus(day: string): void;
  goToWeekOf(day: string): void;
  /** Opens the day view on that day, where the page offers one; else the week's. */
  goToDay(day: string): void;
}

const ALL_VIEWS: readonly CalendarView[] = ['day', 'week', 'month'];

function isView(s: string | null, views: readonly CalendarView[]): s is CalendarView {
  return s === 'day' || s === 'week' || s === 'month' ? views.includes(s) : false;
}

function dayLabel(day: string): string {
  return parseDay(day).toLocaleDateString('en-PH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function weekLabel(monday: string): string {
  const days = weekDays(monday);
  const first = parseDay(days[0]);
  const last = parseDay(days[6]);
  return `${first.toLocaleDateString('en-PH', { day: 'numeric', month: 'short' })} — ${last.toLocaleDateString(
    'en-PH',
    { day: 'numeric', month: 'short', year: 'numeric' },
  )}`;
}

function monthLabel(month: string): string {
  return parseDay(`${month}-01`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
}

/**
 * URL-owned calendar state via useSearchParams: `?view=&month=&week=`.
 *
 * `?date=YYYY-MM-DD` is an alias resolved in the initial state (so the first
 * fetch is the linked window) and rewritten once on mount (replace). Invalid
 * values fall back to today. Params the hook does not own are preserved
 * untouched. `views` limits the switch: a page passing ['month'] gets no Week
 * tab and the URL never carries week=.
 */
export function useCalendarNav(opts: { defaultView?: CalendarView; views?: CalendarView[] } = {}): CalendarNav {
  const [params, setParams] = useSearchParams();
  const viewsKey = (opts.views ?? ALL_VIEWS).join(',');
  const views = useMemo<readonly CalendarView[]>(
    () => viewsKey.split(',').filter((v): v is CalendarView => v === 'day' || v === 'week' || v === 'month'),
    [viewsKey],
  );
  const defaultView: CalendarView =
    opts.defaultView && views.includes(opts.defaultView) ? opts.defaultView : views[0] ?? 'month';

  const today = todayLocal();
  const dateParam = params.get('date');
  const dateAlias = isDayKey(dateParam) ? dateParam : null;
  const viewParam = params.get('view');
  const view: CalendarView = isView(viewParam, views) ? viewParam : defaultView;

  const [focusState, setFocusState] = useState<string>(() => dateAlias ?? today);

  // The active view's key comes from the URL; the other views' keys are
  // derived from the focus, which is always inside the active grid.
  const monthParam = params.get('month');
  const weekParam = params.get('week');
  const dayParam = params.get('day');
  const activeMonth = dateAlias ? monthOf(dateAlias) : isMonthKey(monthParam) ? monthParam : monthOf(today);
  const activeWeek = dateAlias ? mondayOf(dateAlias) : isDayKey(weekParam) ? mondayOf(weekParam) : mondayOf(today);
  const activeDay = dateAlias ?? (isDayKey(dayParam) ? dayParam : today);

  const grid = useMemo(
    () => (view === 'month' ? monthGrid(activeMonth) : view === 'week' ? weekDays(activeWeek) : [activeDay]),
    [view, activeMonth, activeWeek, activeDay],
  );
  const focus = grid.includes(focusState) ? focusState : grid.includes(today) ? today : grid[0];

  const month = view === 'month' ? activeMonth : monthOf(focus);
  const week = view === 'week' ? activeWeek : mondayOf(focus);
  const day = view === 'day' ? activeDay : focus;
  const activeKey = view === 'month' ? month : view === 'week' ? week : day;
  const windowKey = `${view}:${activeKey}`;

  const { from, to } = useMemo(() => windowFor(view, activeKey), [view, activeKey]);
  const label = view === 'month' ? monthLabel(month) : view === 'week' ? weekLabel(week) : dayLabel(day);

  /** Every write names the view and the active key, and drops the other views' keys. */
  const write = useCallback(
    (v: CalendarView, key: string, replace: boolean) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('date');
          next.set('view', v);
          next.delete('month');
          next.delete('week');
          next.delete('day');
          next.set(v, key);
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );
  /** The key a view opens on from the focus: its month, its Monday, or the day itself. */
  const keyFor = useCallback(
    (v: CalendarView, d: string) => (v === 'month' ? monthOf(d) : v === 'week' ? mondayOf(d) : d),
    [],
  );

  // `?date=` is a link, not a home: resolve it once and move the URL onto the
  // state it stands for, so the next navigation has nothing stale to keep.
  const rewrote = useRef(false);
  useEffect(() => {
    if (rewrote.current) return;
    rewrote.current = true;
    if (dateAlias) write(view, activeKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setView = useCallback(
    (v: CalendarView) => {
      if (!views.includes(v)) return;
      write(v, keyFor(v, focus), false);
    },
    [views, focus, write, keyFor],
  );

  const step = useCallback(
    (dir: -1 | 1) => {
      const key = view === 'month' ? addMonthsKey(month, dir) : view === 'week' ? addDays(week, 7 * dir) : addDays(day, dir);
      if (view === 'day') setFocusState(key);
      write(view, key, true);
    },
    [view, month, week, day, write],
  );
  const prev = useCallback(() => step(-1), [step]);
  const next = useCallback(() => step(1), [step]);

  const goToday = useCallback(() => {
    const now = todayLocal();
    setFocusState(now);
    write(view, keyFor(view, now), true);
  }, [view, write, keyFor]);

  const setFocus = useCallback((d: string) => {
    if (isDayKey(d)) setFocusState(d);
  }, []);

  const goToWeekOf = useCallback(
    (d: string) => {
      if (!isDayKey(d)) return;
      setFocusState(d);
      if (views.includes('week')) write('week', mondayOf(d), false);
    },
    [views, write],
  );

  const goToDay = useCallback(
    (d: string) => {
      if (!isDayKey(d)) return;
      setFocusState(d);
      if (views.includes('day')) write('day', d, false);
      else if (views.includes('week')) write('week', mondayOf(d), false);
    },
    [views, write],
  );

  return {
    view,
    views,
    month,
    week,
    day,
    focus,
    from,
    to,
    windowKey,
    label,
    setView,
    prev,
    next,
    today: goToday,
    setFocus,
    goToWeekOf,
    goToDay,
  };
}

const VIEW_LABEL: Record<CalendarView, string> = { day: 'Day', week: 'Week', month: 'Month' };
const TODAY_LABEL: Record<CalendarView, string> = { day: 'Today', week: 'This week', month: 'This month' };

/**
 * ‹ Previous · This week|This month · Next › · label · spacer · children ·
 * Week/Month scope-switch (hidden when the page offers one view).
 */
export function CalendarToolbar({ nav, children }: { nav: CalendarNav; children?: ReactNode }) {
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = nav.views.indexOf(nav.view);
    const n = nav.views.length;
    const target = nav.views[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n];
    if (target !== nav.view) nav.setView(target);
  }

  return (
    <div className="cal-toolbar">
      <button type="button" className="btn btn-sm" onClick={nav.prev}>
        ‹ Previous
      </button>
      <button type="button" className="btn btn-sm" onClick={nav.today}>
        {TODAY_LABEL[nav.view]}
      </button>
      <button type="button" className="btn btn-sm" onClick={nav.next}>
        Next ›
      </button>
      <span className="cal-label cal-range" aria-live="polite">
        {nav.label}
      </span>
      <div className="topbar-spacer" />
      {children}
      {nav.views.length > 1 && (
        <div className="scope-switch" role="tablist" aria-label="Calendar view">
          {nav.views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={nav.view === v}
              tabIndex={nav.view === v ? 0 : -1}
              className={nav.view === v ? 'active' : ''}
              onClick={() => nav.setView(v)}
              onKeyDown={onTabKey}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const WEEKDAYS = [
  ['Mon', 'Mo', 'Monday'],
  ['Tue', 'Tu', 'Tuesday'],
  ['Wed', 'We', 'Wednesday'],
  ['Thu', 'Th', 'Thursday'],
  ['Fri', 'Fr', 'Friday'],
  ['Sat', 'Sa', 'Saturday'],
  ['Sun', 'Su', 'Sunday'],
];

function byDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      // All-day first, then by time, then by label so the order is stable.
      const ta = a.sortAt ?? -Infinity;
      const tb = b.sortAt ?? -Infinity;
      if (ta !== tb) return ta - tb;
      return a.label.localeCompare(b.label);
    });
  }
  return map;
}

function dayAria(day: string, count: number, noun: { one: string; many: string }): string {
  const d = parseDay(day).toLocaleDateString('en-PH', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  if (count === 0) return `${d}, no ${noun.many}`;
  return `${d}, ${count} ${count === 1 ? noun.one : noun.many}`;
}

export function MonthCalendar({
  nav,
  events,
  loading,
  maxPerDay = 3,
  itemNoun = { one: 'event', many: 'events' },
  emptyNote,
  onDayClick,
  onEventClick,
  onMoreClick,
}: {
  nav: CalendarNav;
  events: CalendarEvent[];
  /** aria-busy dim; the grid stays mounted. */
  loading?: boolean;
  /** Default 3, then '+N more'. */
  maxPerDay?: number;
  /** Used in the gridcell aria-label and the empty note. */
  itemNoun?: { one: string; many: string };
  /** Default `Nothing scheduled in ${nav.label}.` */
  emptyNote?: string;
  /** Enter/Space/click on a cell. */
  onDayClick?: (day: string) => void;
  onEventClick?: (e: CalendarEvent) => void;
  /** Falls back to onDayClick. */
  onMoreClick?: (day: string, hidden: CalendarEvent[]) => void;
}) {
  const grid = useMemo(() => monthGrid(nav.month), [nav.month]);
  const rows = useMemo(() => Array.from({ length: 6 }, (_, r) => grid.slice(r * 7, r * 7 + 7)), [grid]);
  const buckets = useMemo(() => byDay(events), [events]);
  const today = todayLocal();
  const focus = grid.includes(nav.focus) ? nav.focus : grid.includes(today) ? today : grid[0];

  const root = useRef<HTMLDivElement>(null);
  const movedByKeyboard = useRef(false);

  // Only keyboard moves pull DOM focus along; a toolbar click leaves the
  // person on the button they pressed, with exactly one cell waiting on Tab.
  useEffect(() => {
    if (!movedByKeyboard.current) return;
    movedByKeyboard.current = false;
    const cell = root.current?.querySelector<HTMLElement>(`[role="gridcell"][data-day="${focus}"]`);
    cell?.focus();
  }, [focus]);

  function moveTo(day: string) {
    // A key that lands where focus already is (Home on a Monday) changes no
    // state, so no effect would clear the flag — and a later toolbar click
    // would then pull DOM focus into the grid.
    if (day === focus) return;
    movedByKeyboard.current = true;
    nav.setFocus(day);
    if (!grid.includes(day)) {
      if (day < grid[0]) nav.prev();
      else nav.next();
    }
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    // Chips and '+N more' are buttons and handle their own Enter/Space.
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'gridcell') return;
    const dd = Number(focus.slice(8, 10));
    switch (e.key) {
      case 'ArrowLeft':
        moveTo(addDays(focus, -1));
        break;
      case 'ArrowRight':
        moveTo(addDays(focus, 1));
        break;
      case 'ArrowUp':
        moveTo(addDays(focus, -7));
        break;
      case 'ArrowDown':
        moveTo(addDays(focus, 7));
        break;
      case 'Home':
        moveTo(mondayOf(focus));
        break;
      case 'End':
        moveTo(addDays(mondayOf(focus), 6));
        break;
      case 'PageUp':
      case 'PageDown': {
        // From the month on show, not the focus's month: a focused trailing
        // day belongs to next month, and PageDown must still move one page.
        const m = addMonthsKey(nav.month, e.key === 'PageUp' ? -1 : 1);
        const last = Number(lastOfMonth(m).slice(8, 10));
        movedByKeyboard.current = true;
        nav.setFocus(`${m}-${String(Math.min(dd, last)).padStart(2, '0')}`);
        if (e.key === 'PageUp') nav.prev();
        else nav.next();
        break;
      }
      case 'Enter':
      case ' ':
        onDayClick?.(focus);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  const note = emptyNote ?? `Nothing scheduled in ${nav.label}.`;

  return (
    <div ref={root} className="mcal" role="grid" aria-label={nav.label} aria-busy={loading ? 'true' : undefined} onKeyDown={onKey}>
      <div className="mcal-weekdays" role="row">
        {WEEKDAYS.map(([long, short, full]) => (
          <div key={long} role="columnheader" aria-label={full}>
            <span className="mcal-wd-long" aria-hidden="true">
              {long}
            </span>
            <span className="mcal-wd-short" aria-hidden="true">
              {short}
            </span>
          </div>
        ))}
      </div>
      <div className="mcal-grid" role="rowgroup">
        {rows.map((row) => (
          <div key={row[0]} className="mcal-row" role="row">
            {row.map((day) => {
              const list = buckets.get(day) ?? [];
              const shown = list.slice(0, maxPerDay);
              const hidden = list.slice(maxPerDay);
              const isFocus = day === focus;
              const cls = [
                'mcal-cell',
                monthOf(day) !== nav.month ? 'outside' : '',
                day === today ? 'today' : '',
                list.length ? 'has-events' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={day}
                  role="gridcell"
                  className={cls}
                  data-day={day}
                  tabIndex={isFocus ? 0 : -1}
                  aria-label={dayAria(day, list.length, itemNoun)}
                  aria-current={day === today ? 'date' : undefined}
                  onClick={() => {
                    nav.setFocus(day);
                    onDayClick?.(day);
                  }}
                >
                  <div className="mcal-day">
                    <span>{Number(day.slice(8, 10))}</span>
                    {list.length > 0 && (
                      <span className="mcal-count" aria-hidden="true">
                        {list.length}
                      </span>
                    )}
                  </div>
                  {shown.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      className={['mcal-event', ev.tone ?? '', ev.done ? 'done' : ''].filter(Boolean).join(' ')}
                      // The type's own colour on the edge; a tone (done, cancelled) still wins through the class.
                      style={ev.color && !ev.tone ? { borderLeftColor: ev.color } : undefined}
                      tabIndex={isFocus ? 0 : -1}
                      title={ev.detail ? `${ev.label} — ${ev.detail}` : ev.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick?.(ev);
                      }}
                    >
                      {ev.time && <span className="time">{ev.time}</span>}
                      <span>{ev.label}</span>
                      {ev.detail && <span className="detail">{ev.detail}</span>}
                    </button>
                  ))}
                  {hidden.length > 0 && (
                    <button
                      type="button"
                      className="mcal-more"
                      tabIndex={isFocus ? 0 : -1}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onMoreClick) onMoreClick(day, hidden);
                        else onDayClick?.(day);
                      }}
                    >
                      +{hidden.length} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!loading && events.length === 0 && <div className="mcal-empty">{note}</div>}
    </div>
  );
}
