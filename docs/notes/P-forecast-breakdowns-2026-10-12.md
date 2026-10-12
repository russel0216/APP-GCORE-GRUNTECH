# Plan — the Forecast by salesperson, by product group and by team (2026-10-12)

The owner's words: "on forecast /g-ops/forecast I want to maximize this to:
1. Forecast of Sales Person, 2. Forecast by Product Group, 3. Forecast by
Team."

Status: **planned, not built.**

## What is there today

- `GET /pipeline/forecast` (`loadForecast()` in `routes/sales.ts`) reads the
  open quotations through the quotation list's own query, values each with
  `quotationValue()`, and `buildForecast()` in `shared/forecast.ts` (pure)
  puts every row in exactly one period bucket, `earlier`, `later` or
  `undated`. The page draws By period, Weighted value by period, a small
  "by salesperson" table (`owners`: count, value, weighted — the whole
  window, no periods) and the consolidated list. The owner picker
  narrows the whole page to one person.
- A quotation's team is `quotationTeamOf()` (its tag, else its author's) in
  `shared/team.ts`; a quotation's product groups are `groupShares()` in
  `shared/pipeline.ts` (the value revision's lines split in centavos, the
  rule Sales Analytics' "By group" uses). Neither reaches the Forecast.
- The CSV and the PDF print the periods and their rows.

## What is built

**One breakdown, three dimensions.** Each row carries, beside its owner,
its `team` (`quotationTeamOf`; a lead's is its assignee's team; null is
"No team") and its `groups` (`groupShares(value, lines)`; a lead, or a
quotation with no priced line, is one share "No group"). `buildForecast`
returns three **matrices** of the same shape — `byOwner`, `byTeam`,
`byGroup` — each a list of `{ id, name, count, value, weighted, overdue,
periods: { [bucketKey]: { count, value, weighted } }, earlier, later,
undated }`, sorted largest weighted first:

- **Salesperson** and **Team**: a row belongs to one line; the lines add up
  to the forecast's own buckets and totals, centavo for centavo.
- **Product group**: a quotation is split across its groups by its line
  amounts — a ₱140,000 quotation that is 70% OMEGA AIR and 30% services
  puts ₱98,000 under OMEGA AIR and ₱42,000 under GRUNTECH SERVICES, each
  at the quotation's odds, in the quotation's own period. Counts count a
  quotation once per group it touches, so the count column says "N
  quotations with lines in this group"; value and weighted still add up
  to the forecast's totals (verify-pipeline asserts all three
  dimensions).

**The page**: under the By period panel, a **Breakdown** panel with a
switch — *Salesperson · Team · Product group* (`?by=owner|team|group`,
default owner) — drawing a matrix: one row per line, one column per period
in the window (the weighted figure, the value in small type under it, "—"
when nothing), then Before / After / Undated / **Total**; a footer row
adds up to the forecast; a `BarList` of the weighted totals beside it for
reading at a glance. A salesperson's row links to the quotation list
filtered to them (`?ownerId=`), a period cell to that person's closing
dates (`ownerId` + `closingFrom`/`closingTo`); a team row to the list's
Team view where it is the viewer's team, else no link; a group row has no
link (the list has no group filter). The old small "by salesperson" table
goes — the matrix replaces it.

**Two more filters** beside the owner picker, in the URL like the rest:
**Team** (`?teamId=`, the active teams; narrows the rows to that team
through `quotationTeamWhere` / the lead's assignee's team) and **Product
group** (`?group=`, the active groups — narrows to the quotations with a
line in that group and shows ONLY that group's share of each, so "the
OMEGA AIR forecast" is the OMEGA AIR money, not the whole quotations).
`filters` names them on the paper. The Team filter is offered to a viewer
on Mine · Team · All alike (it is a category, not a right); a team not on
file is a 400, as is an unknown group.

**CSV and PDF**: the chosen breakdown's matrix is a second table after the
periods (the CSV appends columns, never reorders: `Breakdown`, `Line`,
then one column per period); the PDF prints it landscape when the window
has more than seven periods (the engine's rule).

**Nothing is stored** (the Forecast keeps its "no table" rule) and the
list, the board and the Forecast still value a quotation one way.

## Files

- `api/src/shared/forecast.ts`: `ForecastRow.team`, `ForecastRow.groups`;
  `ForecastLine`, `ForecastMatrix`; `byOwner`, `byTeam`, `byGroup` on
  `Forecast`; the owner matrix replaces `owners`.
- `api/src/routes/sales.ts` (`loadForecast`): include the team and the
  value revision's lines, `quotationTeamOf`, `groupShares`; `teamId` and
  `group` filters; the CSV and PDF twins.
- `web/src/pages/sales/Forecast.tsx`: the Breakdown panel and switch, the
  two pickers, `?by=`, `?teamId=`, `?group=`; `styles/pipeline.css` for the
  matrix (`.fc-matrix`, sticky first column, the small value under the
  weighted figure).
- `api/scripts/verify-sales.ts` (pure): a group split's shares add up; a
  quotation with no priced line is "No group"; the three matrices add up to
  the totals on random rows. `api/scripts/verify-pipeline.ts` (HTTP): the
  owner matrix's cell equals the quotation list filtered to the person and
  the period's closing dates; the team of a tagged quotation; `?group=`
  shows the share only; the CSV's appended columns.

## Questions, with the defaults the build takes

1. **Group split**: a quotation across its groups by line amounts (Sales
   Analytics' rule), counted once per group it touches. Alternative: the
   whole quotation under its largest group.
2. **The matrix's figure**: weighted, value in small under it. Alternative:
   a switch Weighted / Value.
3. **Default breakdown**: Salesperson.
4. **The old "by salesperson" table**: replaced by the matrix.
5. **Team of a lead**: its assignee's team.

## Effort (Opus 5.5)

Medium — one push, about two hours: the shared arithmetic and its checks
(~40 min), the route's rows, filters and the two twins (~30 min), the page
(~40 min), CLAUDE.md and a screenshot (~15 min). No schema change, no new
permission.
