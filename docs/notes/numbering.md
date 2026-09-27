# P4 — numbering admin (item 6, admin half)

Files: `api/src/routes/admin.ts` (numbering routes), `api/scripts/verify-numbering.ts`
(new, 46 cases), `api/scripts/verify-foundation.ts` (+2 cases),
`web/src/pages/admin/Numbering.tsx`, `web/src/pages/admin/Company.tsx`,
`web/src/styles/numbering.css`.

## For the model doc §7 (numbering paragraph)

A counter has a **period** (yearly, monthly, or never) and a **scope**
(company-wide, or per employee). The pattern tokens are `{PREFIX}` `{TYPE}`
`{YYYY}` `{YY}` `{MM}` `{EMP}` `{SEQ}`; `{EMP}` is the author's employee number
reduced to its last run of digits and padded to three (`GT-EMP-2026-0007` →
`007`), `000` for a login with no employee record. The quotation follows the
house scheme `{EMP}{YY}{MM}{SEQ}`, padding 3, monthly, per employee — so
`0012609001` is employee 001's first quotation of September 2026 and employee
002's first that month is `0022609001`. Counter rows are keyed `2026`,
`2026-09` or `2026-09@001`; the template row is the `periodKey ''` row.

## For CLAUDE.md (Phase 1 note — numbering)

- **`nextNumber(documentType, tx, ctx)` takes a `NumberContext`**, never a bare
  `Date`: `{ at?, ownerId?, employeeNo? }`. Pass `ownerId` for anything whose
  pattern may carry `{EMP}`; `employeeNo` in hand skips the lookup and wins.
- **An existing database keeps its configured pattern.** The seed only creates
  a template that is missing; `PUT /numbering/:type` is the only thing that
  changes one. A dev database that predates the house scheme still issues
  `GT-QT-…` until an administrator sets the quotation pattern once in
  Admin › Numbering — verify scripts use throwaway types so they are green
  either way.
- **Changing period or scope starts a fresh run and keeps the old counters.**
  `PUT` updates every row of the type (pattern, period, scope, padding) but
  deletes none; a row keyed for a period the type no longer uses simply stops
  being matched. That is the record of what was issued under it, so never
  "clean them up".
- **"Issued this period" is a sum.** `issuedThisPeriod(rows, type, current)`
  in `routes/admin.ts` adds every counter row whose key is the current period
  key or `<current>@<emp>` — one row for a company-wide counter, one per author
  for a per-employee one. For a NONE counter the current key is `''`, which is
  the template row itself (company-wide) or the `@007` rows hanging off it
  (per employee). The screen's figure must equal that sum;
  `verify-numbering.ts` asserts it over HTTP for every row.
- **Three collision rules are enforced when a pattern is saved**, as zod issues
  on `pattern` so the form can show them: per employee needs `{EMP}` (two
  people would share a number), monthly needs `{MM}` and a year token (January
  repeats December), yearly needs `{YYYY}` or `{YY}` (next year repeats this
  one). `nextNumber` refuses the first again at issue time as a backstop; the
  other two it cannot distinguish from a deliberate choice, so the PUT is the
  only guard. `scope` defaults to `GLOBAL` when a caller omits it.
- **The samples on Admin › Numbering carry the viewer's own `{EMP}` digits**
  (`previewNext(type, { employeeNo | ownerId })`, resolved once per request).
  The response says whose: `previewFor: { employeeNo, linked }`. A template
  that cannot issue (per employee, no `{EMP}` — only reachable by editing the
  database) is shown with `problem` set and an empty `preview` rather than
  failing the whole screen; the administrator is the one who can fix it.
- **The Company Settings prefix hint no longer promises every number.** A
  pattern without `{PREFIX}` — the quotation's — ignores the prefix, and the
  hint says so.
- **Raw pixels**: the Numbering and Company pages carry none; their classes
  live in `web/src/styles/numbering.css` (tokens only, so the day theme needs
  no second block).

## Verify

```bash
cd api && npx tsx scripts/verify-numbering.ts     # API must be running (says so if not)
cd api && npx tsx scripts/verify-foundation.ts
```

`verify-numbering.ts` imports `issuedThisPeriod` from `src/routes/admin.ts`
(an export from a router module, like `verify-sales.ts` importing
`routes/sales`); its fixtures are the `ZZNUM` types, employees whose last name
starts with `ZZNUM`, logins at `@verifynum.local` and roles `zznum_*`, cleaned
at start and end.
