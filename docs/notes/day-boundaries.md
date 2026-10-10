# Day boundaries — where "today" is still the UTC date (audit)

2 October 2026, at `a9444c6`; line numbers below are as they were then.

**Status:** the owner chose to fix all four groups. Groups 1, 2 and 4 are fixed
in "Day boundaries: today is Manila's date", and group 3 in its own commit,
"Day boundaries: G-OPS and Insights ranges count from Manila midnight", so it
can be reverted alone.

The evaluations fix (`d5fe56b`, on branch `Gasiondev/infallible-mclean-13a25e`,
not yet on master) moved `manilaDate()` into `api/src/shared/day.ts` and made
evaluations count from Manila's date. This note covers every other place the API
takes "today", or the edge of a date range, from the UTC date.

## The fault

Manila is UTC+8 all year, with no daylight saving. From 00:00 to 08:00 Manila
the UTC date is still yesterday's. The API picks up the UTC date in three ways:

1. **`dayKey()`** in `shared/finance.ts`, `shared/aftermarket.ts` and
   `shared/insights.ts` reads `getUTC*`. (Finance's is commented "The local
   date", which it is not.)
2. **A bare `new Date()` written to, or compared with, a DATE column.** Prisma
   binds it as a DATE and the time is dropped, leaving the UTC date. Checked on
   the dev database: `Invoice.dueDate < V 23:00Z` matched exactly the rows that
   `< V 00:00Z` did.
3. **`@default(now())` on a DATE column.** The column default is
   `CURRENT_TIMESTAMP`, and the database session runs in UTC: at 07:00 Manila
   on 2 October, `now()::date` returned `2026-10-01`. Nothing in `deploy/` sets
   a time zone, so production is the same.

That causes two kinds of damage:

- **A write** stores yesterday's date for good. The date prints on the
  document, sets the default due date, and in one case decides warranty.
- **A read** shows yesterday's position until 08:00, then corrects itself.
  Something is not overdue yet, a warranty is still running, or "this month"
  still means last month.

What the real functions return at **07:00 Manila on 1 October** (pure calls,
nothing written):

|   | Expression | Returns | Manila's answer |
|---|---|---|---|
| A | `dayKey(now)` (finance) | 2026-09-30 | 2026-10-01 |
| B | G-FIN dashboard `monthStart` | 2026-09-01 | 2026-10-01 |
|   | `yearStart`, at 07:00 on 1 Jan 2026 | 2025-01-01 | 2026-01-01 |
| C | Invoice due 30 Sep: overdue? days overdue | no, 0 | yes, 1 |
| D | Warranty ended 30 Sep: `expiryState()` | EXPIRING, 0 days | EXPIRED, −1 |
| E | `periodWhere` 1 Oct → 1 Oct on `createdAt` | 08:00 → 23:59 | 00:00 → 23:59 |
| F | `parseRange` 1 Oct → 1 Oct on a timestamp | 08:00 → 07:59 on 2 Oct | 00:00 → 23:59 |
| G | `monthsBack(3)` | Jul, Aug, Sep | Aug, Sep, Oct |
|   | `monthKey()` of a quotation won 06:30 on 1 Oct | 2026-09 | 2026-10 |
| H | Borrow slip due 1 Oct, seen at 09:00 on 1 Oct: row flag / list filter | overdue / not overdue | not overdue / not overdue |

## 1. Dates stored as yesterday (permanent)

### Reached every time: the screen sends no date

| What someone does | Field stored | Server | Screen | What they'd see |
|---|---|---|---|---|
| Marks a cheque cleared | `Payment.clearedAt` | `routes/finance.ts:1839` | `Receivables.tsx:1126` and `:1293` post no body | Cleared yesterday. A cheque cleared at 07:30 on the 1st counts as last month's collection, both in "Collected this month" and in the cash-flow actuals. |
| Invoices a completed job order | `Invoice.invoiceDate`, and `dueDate` unless typed | `routes/finance.ts:450` | `JobOrders.tsx:1158` sends no invoice date | Invoice dated yesterday, and due a day early. |
| Receives goods against a PO | `Receiving.receivedDate` | `routes/warehouse.ts:250` | `Orders.tsx:1503` | Receiving dated yesterday. |
| Issues stock to a job | `StockIssue.issueDate` | `routes/warehouse.ts:501` | `Warehouse.tsx:366` | Issue slip printed with yesterday's date. |
| Lends tools | `BorrowSlip.borrowedAt` | database default (`warehouse.ts:818` sets none) | `Warehouse.tsx:868` | "Out" yesterday. |
| Takes the last tool back | `BorrowSlip.returnedAt` | `routes/warehouse.ts:919` | server only | Returned yesterday, and the clearance item that reads the slip shows that date. |
| Raises a purchase order | `PurchaseOrder.orderDate` | database default (`procurement.ts:1154`) | server only | PO printed with yesterday's date. |
| Raises a progress billing | `ProgressBilling.billingDate` | database default (`progress.ts:701`) | server only | Billing printed with yesterday's date. |

The warehouse rows are the likeliest to happen, because crews collect materials
and tools before 08:00. A document number takes its `{YYYY}`/`{MM}` from the
server clock, so on 1 January the number and the date also name different
years.

### Reached only when the date is left out: the form sends `todayLocal()`

| Field | Server default | Form |
|---|---|---|
| `invoiceDate` (invoice from a billing) | `finance.ts:322` | `Receivables.tsx:343` |
| `billDate` | `finance.ts:817` | `Payables.tsx:374` |
| `claimDate` | `finance.ts:1245` | `Expenses.tsx:271` |
| `paymentDate`, and `clearedAt` of a non-cheque payment | `finance.ts:1752`, `:1766` | `Receivables.tsx:829` |
| `requestDate` (cash advance) | `advances.ts:252` | `CashAdvances.tsx:283` |
| `installedAt` (turnover) | `aftermarket.ts:416` | `ProjectWorkspace.tsx:2664` |
| `performedAt` (service report) | `aftermarket.ts:1603` | `Reports.tsx:375` |
| `Job.startDate` and the planned scope dates | `jobs.ts:534` (bare `new Date()`) | `Projects.tsx:308`, reached only if the field is cleared |

Nobody using the screens would see these, but any script or new form that
leaves the date out would hit them. `performedAt` matters most: it decides
`underWarranty` (and from it the default `billable`). Approval then copies it to
the visit, to the job order's `completedAt`, and, on commissioning, to the
asset's `commissionedAt` and default `warrantyEndsAt`. The
`dayKey(new Date())` fallback in `refreshAdvance()` (`shared/finance.ts:293`)
cannot be reached, because a released advance always has its release payment.

**Fix.** Wherever the server picks the date, use `manilaDate(new Date())`. For
the three database defaults, set the field in the route instead. The schema
default can stay as a backstop, so no migration is needed.

Rows already stored are left alone: an invoice or PO that went out carries the
date it was printed with. A read-only script can list the rows that show the
fault's signature (stored date = UTC date of `createdAt`, one day before its
Manila date) if you want to review them.

## 2. "Today" one day behind until 08:00 (self-correcting)

Nothing stored is wrong here, but the screen is. Between 00:00 and 08:00 Manila:

| Where | Lines | What they'd see |
|---|---|---|
| A/R and A/P lists: "Overdue" filter, days overdue | `finance.ts:99, 127, 687, 711` | Anything due yesterday is not overdue yet. |
| A/R and A/P aging (default as-of), liquidations overdue | `finance.ts:1997, 2067, 2145` | Every bucket is one day short. |
| G-FIN dashboard | `finance.ts:2407` → `financePosition()` | Overdue receivable and payable leave out yesterday's. **On the 1st, "Collected this month" (`Reports.tsx:320`) shows all of last month plus today**, and on 1 January the "this year" figures are last year's. |
| G-FIN cash flow | `finance.ts:2176`, `:2242` | On the 1st the current month's column is missing. Yesterday's dues sit in "Next 7 days", not "Overdue". |
| Cash advances | `advances.ts:57, 100` | Liquidation not overdue yet. |
| Insights overview and brief | `routes/insights.ts:100`, `shared/insights.ts:557` | The same overdue figures. **On the 1st, Insights' "Collected this month" (`Overview.tsx:508`) also shows all of last month plus today.** |
| Insights cash forecast and its CSV | `routes/insights.ts:916, 1014` | Yesterday's dues sit in "Next 7 days", and the Days column is one higher. |
| Insights trend; inventory months | `shared/insights.ts:35–46`; `routes/insights.ts:255, 1043` | On the 1st the current month's column is missing. |
| Installed base, contracts, renewals | `aftermarket.ts:120, 532`; `shared/aftermarket.ts:95, 334` | A warranty or contract that ended yesterday still reads as running ("Expiring, 0 days"). |
| Service visits: overdue flag, days until due, "due" filter, calendar | `aftermarket.ts:880–886, 922, 1030, 1050, 1071` | Yesterday's visit is not overdue yet. |
| Aftermarket dashboard | `aftermarket.ts:1852` | On the 1st, "N more due this month" (`Templates.tsx:541`) reads 0. |
| The sweep that expires contracts and misses visits | `shared/aftermarket.ts:407` | It runs up to 8 hours late, never early, so nothing is closed wrongly. |
| Job-order PDF, warranty line | `jobOrders.ts:664` | Printed before 08:00 on the day after expiry, it says "to 30 Sep" rather than "Expired 30 Sep". This one ends up on paper. |
| Job-order cover preview with no date picked yet | `jobOrders.ts:194` | Preview only. The form sends the requested date once there is one. |
| G-CHAIN borrow slips overdue: dashboard tile, warehouse tile, list filter | `shared/chain.ts:66`; `warehouse.ts:1109, 699` | `dueAt < new Date()` is bound as the UTC date, so these lag the same way. |
| Borrow-slip row flag and days overdue | `warehouse.ts:743–746` | The opposite fault. It compares in JavaScript, so a slip is flagged overdue **from 08:00 on its own due day**. For 24 hours the row says "overdue" while the "Overdue" filter and both tiles leave it out. |
| Slow movers | `shared/insights.ts:264, 281` | At most one day out against a 30–730-day threshold. No practical effect. |

**Fix.** One change carries most of this: make the three `dayKey()`s return
`manilaDate(at)`.

- Every "today" becomes Manila's: `dayKey(new Date())`,
  `daysBetween(x, new Date())` and `expiryState()`'s default. Month and year
  starts derived from them follow.
- Every other argument is a stored DATE or a parsed `'YYYY-MM-DD'`. Those
  arrive as UTC midnight, which is 08:00 Manila on the same day, so
  `manilaDate()` hands them back unchanged.
- Where the argument is a real timestamp (`dayKey(lastMovedAt)`), the Manila
  date is the right answer anyway.
- The verify scripts import these same `dayKey`s, so they follow automatically.

A few sites don't go through `dayKey` and change by hand:

- The four borrow-slip sites: compare `dueAt` with `manilaDate(new Date())`
  everywhere, so that the row flag, the filter and both tiles agree.
- `monthKey` becomes `manilaMonthKey`, which gives the same result for DATE
  values. `monthsBack()` counts from Manila's month.
- `parseRange()`'s default start of year moves to Manila's year.

## 3. Range edges on timestamp columns

Both range functions compare a DATE column correctly. They don't compare a
timestamp correctly.

**G-OPS `periodWhere()`** (`shared/gops.ts:41`) feeds the G-OPS dashboard and
the Insights brief's G-OPS line.

- `from` is UTC midnight, which is 08:00 Manila. `to` ends at 23:59:59.999 on
  the server clock, which is right on a Manila server.
- So leads, quotations and costings raised (`createdAt`) between 00:00 and
  08:00 on the range's first day are never counted in that range. That's
  1 January in the default year-to-date view, or the 1st of the month for a
  month.
- PM accomplished (`performedAt`, a DATE) is correct, and it's what
  `verify-aftermarket` pins.

Fix:

- For `createdAt` only, `from` becomes Manila midnight:
  `` `${from}T00:00:00+08:00` ``.
- `performedAt` must keep `new Date(from)`. As a DATE parameter, Manila
  midnight (16:00Z the day before) would be read as the previous day.
- Pinning `to` to `+08:00` as well changes nothing on a Manila server, and
  keeps it right on any other.

**Insights `parseRange()`** (`shared/insights.ts:68`).

- For a timestamp column the window runs from 08:00 on the first day to 07:59
  on the day after the last.
- Affected: quotations won or lost (`decidedAt`, `routes/insights.ts:132–133`),
  and leads and quotations by `createdAt` (sales analytics `:450`, pipeline
  CSV `:682`, industry report `:1185`).
- Anything won or raised between midnight and 08:00 counts on the previous day,
  which on the 1st means the previous month.
- The trend buckets `decidedAt` and `JobCostEntry.occurredAt` by UTC month
  (`routes/insights.ts:299–303`), with the same effect.
- Billings, receipts, completions and PM are all DATE columns, and are correct.

Fix: `parseRange()` also returns Manila-midnight edges (`fromAt`, `toAt`) for
the four timestamp filters, and the DATE filters keep `from`/`to`. The trend
buckets with `manilaMonthKey`.

This group reverses two recorded decisions: "G-FIN / G-CHAIN use Insights' UTC
day", and `periodWhere`'s boundary being "deliberately left alone". It also
moves any figure whose range starts on a day that has early-morning records.
These would change with it:

- CLAUDE.md's Insights notes ("A range is Manila's days, with a pair of edges for each kind of column")
- the Insights hand-off note's day conventions (that note was merged into
  CLAUDE.md's Insights notes and removed on 2026-10-10)
- the comments at `shared/insights.ts:420` and `shared/gops.ts:35`
- the brief's caption (`Overview.tsx:418`), which could then simply say that
  every range counts on Manila's day

## 4. Two small web ones

- **Academy passport** (`Passport.tsx:576`, `:636`): the "Completed" picker's
  maximum is the UTC date, so before 08:00 nobody can pick today. The server
  is already on `manilaDate` and would accept it. Fix: `todayLocal()`.
- **CSV export filename** (`DataList.tsx:279`): carries yesterday's date before
  08:00. Cosmetic. Fix: `todayLocal()`.

## Checked and fine

- **G-HR.** `shared/hr.ts`'s `dayKey` uses the server clock, which is Manila if
  the server is set to Manila. Numbering's `{YYYY}`/`{MM}` and `periodWhere`'s
  `to` assume the same thing. Worth confirming once on the server:
  `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`
  should print `Asia/Manila`.
- **Already on Manila's day:** evaluations (`d5fe56b`), the Academy
  (`manilaDate`), and the sales board (`manilaDayKey`, `shared/pipeline.ts:310`).
- **A timestamp compared with the current instant** (meetings, academy
  sessions, invitations, account links): no day is involved.
- **`dayKey()` normalising a stored date** (`planSchedule`, `coverageFor`,
  `jobs.ts:424`, the `asDate()` helpers): unchanged by the fix above.

## Recommendation

Groups 1, 2 and 4 are plain bugs with no judgement involved, and I recommend
fixing them. Group 3 is also a fix, but it reverses a recorded decision and
moves a few G-OPS and Insights figures, so it's the owner's call, and it should
be its own commit.

Once the owner decides:

1. Bring `d5fe56b` onto this branch first, so `manilaDate()` has one home in
   `shared/day.ts`.
2. Commit groups 1, 2 and 4 together, and group 3 separately so it can be
   reverted on its own.
3. Verify:
   - Pure helpers get pinned-instant cases at 00:30 and 23:30 Manila, as
     `d5fe56b` did.
   - HTTP checks assert stored dates against `manilaDayKey(new Date())`. These
     only catch the fault when run between 00:00 and 08:00.
   - Add a `periodWhere` case: a quotation created at 00:30 Manila on the
     from-day is counted.
   - `verify-insights-brief`'s year start, which `d5fe56b` left on finance's
     UTC year, moves to Manila's year.
4. Update CLAUDE.md and the notes above in the same commits.
