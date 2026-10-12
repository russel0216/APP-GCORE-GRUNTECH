# Plan — the Forecast: the By period table whole, tick-box filters, and a comparison range (2026-10-12)

The owner's words: "1. Fix the By period table cut off on the right. 2. The
product group, sales personnel and team have tick box. 3. Create a
comparison range so I can compare for example current year versus previous
year."

Status: **planned, not built.**

## What is there today

- The Forecast page (`pages/sales/Forecast.tsx`, built 2026-10-12 on
  `docs/notes/P-forecast-breakdowns-2026-10-12.md`) draws four stat cards,
  then **By period** and **Weighted value by period** side by side in a
  `grid-2`, then the Breakdown panel (Salesperson · Team · Product group)
  and the consolidated list.
- **The cut-off**: By period is a four-column table (Period, Quotations,
  Value, Weighted) in HALF the page. At the owner's screen width the
  figures run wider than the half, the `table-wrap` scrolls sideways, and
  the Weighted column — the one the page is about — is the one hidden
  behind the edge (the screenshot of 2026-10-12 shows "₱7," cut at the
  panel's edge). The panel beside it draws the same weighted figures as a
  bar list.
- **The three filters are single selects**: Salesperson (`?ownerId=`),
  Team (`?teamId=`, an id or `none`) and Product group (`?group=`, a key
  or `none`) each take ONE value; `loadForecast()` in `routes/sales.ts`
  applies them one after another, and a group filter keeps only that
  group's share of each quotation.
- **No comparison**: the page shows one window. The owner cannot put this
  year beside last year, or this quarter beside the one before.
- The arithmetic is `shared/forecast.ts`, pure: `periodsBetween()` (clipped
  edges, `range` as one bucket), `rangePreset()`, `buildForecast()`,
  `breakdownOf()`. The rows are the OPEN quotations (OPEN / SUBMITTED /
  NEGOTIATION) by expected closing date, each at its own odds; a won or
  lost quotation is never a row.

## 1. The By period table whole

The two panels stop sharing a line. **By period takes the full width**,
and its Weighted column carries the bar: a `MiniBar` (`components/
charts.tsx`) beside each figure, against the window's peak, so the
"Weighted value by period" panel — the same figures drawn again — goes.
One panel says it all, the four columns fit at any width the app
supports, and nothing scrolls sideways. The row for a period keeps its
link, its "N past closing" note and the In the window / Outside it foot.

Alternative kept in reserve: keep both panels and stack them (By period
over the bar list). More page for the same figures — not the default.

## 2. Tick boxes on Salesperson, Team and Product group

Each of the three filters becomes a **pick-several box**: a button reading
"Everyone" / "Every team" / "Every group", or what is ticked ("Carter
Gasiong, Maria Santos" — "3 salespeople" past two), opening a panel under
it with one tick box per choice (and "No team" / "No group" where the
filter offers them today), a "Clear" link, Enter and Escape as the
`CustomerPicker` has them, `aria-expanded` on the button. One component,
`TickPicker` in `components/TickPicker.tsx` (`fieldControl`, so a `Field`
labels it), pure UI over `{ value, label, hint? }[]` — the Forecast is its
first user; a list's Filters panel could take it later.

- **URL**: the same keys, several values separated by commas —
  `?ownerId=a,b`, `?teamId=KATid,none`, `?group=omega-air,others` (a group
  key never holds a comma; an id never does). An old one-value link reads
  as before.
- **API**: `loadForecast()` takes each as a list (`listOf(query.ownerId)`,
  trimmed, empty dropped, each checked as today — an unknown team or group
  is a 400 naming it). A row passes a filter when its owner / team is any
  of those ticked; the group filter keeps a quotation with a line in ANY
  ticked group and **the sum of the ticked groups' shares** as its value
  (OMEGA AIR + MANN-FILTER ticked = the money in those two lines of every
  quotation, nothing else), so the breakdown by group under that filter
  lists just the ticked groups. `people`, `teams` and `groupChoices`
  still name everyone in scope.
- **The paper's filter line** names each list ("owners Carter Gasiong,
  Maria Santos"; "teams KAT, HIT"; "product groups OMEGA AIR, OTHERS").

## 3. A comparison range

**`?compare=`** puts a second window beside the first:

- `prev-period` — **the period before**: a window of the same length
  ending the day before `from` (1 Oct 2026 – 30 Sep 2027 against
  1 Oct 2025 – 30 Sep 2026).
- `prev-year` — **the same window a year earlier**: `from` and `to` each
  moved back one year (a 29 February lands on 28 February), so "this year"
  stands against "last year" month by month.
- `custom` with `compareFrom` / `compareTo` — any window the owner types.

`compareWindow(from, to, mode, custom?)` in `shared/forecast.ts`, pure,
is the one rule; the page's **Compare with** select (Nothing · The period
before · The same period last year · Custom, with two more date boxes for
Custom) writes it to the URL beside the range.

**How the two windows are read.** A forecast is open quotations at their
odds, and the previous year's quotations are mostly decided — read the old
way, last year would be a handful of overdue leftovers. So **while a
comparison is on, BOTH windows are read alike**: every quotation whose
expected closing date falls in the window, whatever its outcome — a won
one at its full value (odds 100), an open one at its own odds, a lost one
counted and valued but weighted at nothing (`outcomeOdds()` in
`shared/forecast.ts`: WON 100, LOST 0, else the quotation's own). The page
says so in one line under the cards ("Comparing: both windows count won
quotations in full and lost ones at nothing, so the years are read
alike"). With no comparison, nothing changes: open quotations only, as
today.

**What the page shows with a comparison on**:

- The four stat cards get the compared window's figure under their own,
  with the change ("₱8.1M · last year ₱6.4M · +27%"), through `Stat`'s
  `sub`.
- **By period** gains two columns, **Previous** (weighted; the value
  under it, smaller) and **Change** (the difference and the percentage,
  `−` or `+`, the warn tone when down), each period against the compared
  window's bucket in the SAME POSITION — October 2026 against October
  2025, Q1 against the Q1 before; the compared bucket's own label sits
  under the period's ("vs Oct 2025"). A window compared with a longer or
  shorter one aligns what it can and prints "—" past the end. The In the
  window foot compares the totals.
- **The Breakdown matrix** gains Previous and Change on each line's Total
  (a person, a team, a group against themselves a year ago); the period
  cells stay one figure, or the table doubles in width.
- The consolidated list stays this window's rows (won ones now among
  them, their stage pill saying Confirmed; lost ones too, Lost). The
  compared window's rows are figures only, never listed — the list is
  work to do, and last year's is done.

**CSV and PDF**: the CSV appends `Previous count`, `Previous value`,
`Previous weighted` and `Change` columns to each period row (appended,
never reordered); the By period and breakdown tables on the paper gain
the same two columns, and the DETAILS block names the compared window.
The paper goes landscape past seven columns as the engine already rules.

`compareForecasts(current, previous)` in `shared/forecast.ts`, pure,
pairs buckets by position and lines by id and returns the deltas, so the
page, the CSV and the PDF cannot disagree on a change.

## Files

- `web/src/pages/sales/Forecast.tsx`: By period whole with `MiniBar`, the
  bar-list panel gone; `TickPicker` on the three filters; Compare with
  and its date boxes; the Previous / Change columns and the cards' subs.
  `web/src/styles/forecast.css` for the bar in the cell and the change
  tone. `web/src/components/TickPicker.tsx` new. `lib/listUrl.ts`
  untouched (the Forecast keeps its own URL state).
- `api/src/shared/forecast.ts`: `compareWindow()`, `outcomeOdds()`,
  `compareForecasts()`, `ForecastCompare` on the response.
- `api/src/routes/sales.ts` (`loadForecast`): list filters, the
  comparison's second read (one more query under the same
  `quotationListWhere`, with `outcome` in every stage while comparing),
  the filters line, the CSV and PDF twins.
- `api/scripts/verify-sales.ts` (pure): `compareWindow` for all three
  modes (prev-period of a 366-day window; prev-year of 29 Feb 2028; a
  custom pair), won at 100 / lost at 0 / open at its odds, buckets
  aligned by position with a shorter window, deltas; several owners /
  teams / groups keep the right rows and the summed shares.
  `api/scripts/verify-pipeline.ts` (HTTP): `?ownerId=a,b` lists both
  people's rows; `?group=x,y` sums the two shares; a won quotation closing
  last year reaches the compared window at its value and is absent with
  no comparison; the CSV's appended columns; `?compare=custom` without
  dates and an unknown mode are 400s.
- CLAUDE.md Forecast section; this note marked built.

## Questions, with the defaults the build takes

1. **The By period bar chart**: drawn inside the table's Weighted column
   (`MiniBar`), the separate panel removed. Alternative: keep both,
   stacked.
2. **Several product groups ticked**: the quotation's value is the SUM of
   the ticked groups' shares. Alternative: the whole quotation once it has
   a line in any of them.
3. **How a comparison reads the windows**: both alike, won at full value,
   lost at nothing, open at its odds. Alternative: the current window
   stays open-only and the previous counts won only — then the two
   columns measure different things, and a year half gone reads small.
4. **Where the change shows**: the cards, By period per period, the
   breakdown per line total. Alternative: per period cell in the
   breakdown too (a matrix twice as wide).
5. **Comparison modes**: the period before, the same period last year,
   custom. Alternative: fewer.
6. **The compared window's quotations in the list**: not listed, figures
   only.

## Effort (Fable 5.1)

Medium — one push, about three and a half hours: the table and the bar
(~15 min), `TickPicker` with the list filters on both ends (~60 min), the
comparison's shared rules and their checks (~50 min), the route's second
read and the two twins (~40 min), the page's columns, cards and controls
(~45 min), CLAUDE.md and a screenshot (~15 min). No schema change, no new
permission.
