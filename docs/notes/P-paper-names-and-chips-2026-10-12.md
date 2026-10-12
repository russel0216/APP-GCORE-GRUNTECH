# Plan — a standard file name for every paper saved, and filter chips that take a second line (2026-10-12)

The owner's words: "1. On saving to local workstation make the file name
have a standard file name (for example Document Numbering, Author,
documents date). 2. On filter when the space for 1 line is not enough make
it 2 line, just prioritize the space at the 1st line."

Status: **planned, not built.**

## 1. The file name a paper is saved under

### What is there today

- Every PDF route already names its file in `Content-Disposition`
  (`inline; filename="0062602018-R0.pdf"`, `SO-4720.pdf`, `sales-forecast.pdf`
  through `sendListPdf`) — the number alone, in a shape each route chose
  for itself (the sales order prefixes `SO-`, the quotation adds `-R<n>`,
  the list papers are words).
- **None of it reaches the person.** `openPdf()` in `lib/api.ts` (the ONE
  way a screen opens a paper, rule of 2026-10-10) fetches the bytes with
  the bearer token and opens a `blob:` URL in a new tab. A blob URL has no
  name, so the browser's Save as / Ctrl+S offers its random id
  (`3f9c2a1e-…pdf`) or `download.pdf`, and the server's name is thrown
  away. That is what the owner sees. `downloadBlob()` (an `.ics`, a CSV)
  names its file, but opens nothing.

### What is built

**One name rule, `paperFileName()` in `api/src/shared/paperName.ts`**
(pure, verify-foundation):

```
<Kind> <Number> - <Author> - <YYYY-MM-DD>.pdf
Quotation 0062602018 R0 - Carter Gasiong - 2026-10-08.pdf
Sales Order 4720 - Carter Gasiong - 2026-05-30.pdf
Costing GT-CE-2026-0012 - Juan dela Cruz - 2026-09-14.pdf
Sales Forecast - Carter Gasiong - 2026-10-12.pdf          (a list: who printed, today)
```

- `Kind` is the document's name as its paper prints it (the title
  `renderDocument` / the designed layout draws); `Number` the document's
  number, a revision as ` R<n>`; `Author` the person who prepared it (the
  owner, the requester, the filer — the same person the paper's first
  sign-off names), a list paper the person printing it; `Date` the
  document's own date (`createdAt` for a quotation, the order date, the
  claim date…) on the Manila day, a list paper today. Characters a file
  system refuses (`/ \ : * ? " < > |`, control characters) become `-`,
  runs of spaces one space, the whole kept under 150 characters; a
  missing author drops its part rather than printing "undefined".
- **Every PDF route uses it** (the 25 or so `Content-Disposition` lines
  above, and `sendListPdf`, which takes `{ kind, author }` beside the
  bytes) — the number is still in the name, so nothing is lost; `SO-`
  and `-R0` give way to the one shape.
- **The name reaches the browser.** `openPdf()` stops opening a nameless
  blob: it asks the server for a **print ticket** — `POST /api/print-tickets
  { path }` answers a one-use token good for two minutes, an HMAC over
  `userId.path.issuedAt.nonce` with the JWT secret (the liveness
  challenge's rule in `shared/liveness.ts`: stateless, a small set of spent
  nonces) — and opens the REAL URL in the new tab, `path?ticket=…`. The
  `authenticate` middleware takes a valid ticket in place of a bearer on a
  GET whose path and query are exactly the ticket's, spends it, and
  resolves the same user; every permission check, guard and audit row runs
  as before. The tab is then a plain `GET …pdf` with the server's
  `Content-Disposition`, so Chrome, Edge and Firefox title the tab and
  Save as with the standard name. A ticket reused, expired, on another
  path or by another login is a 401, never a paper. Nothing else changes
  how a paper is fetched: `PdfButton` and every `openPdf` caller (eight
  screens) stay as they are.
- `downloadBlob()` callers (the `.ics`, the CSV twins, the attendance
  sheet) keep their names; a CSV's name is not in the ask.

## 2. Filter chips on a second line when the first is full

### What is there today

- Since 3d47e7b the chips sit on the toolbar line after Filters, with
  Clear all, and the ⋯ menu at the far right. The toolbar is one
  `flex-wrap: wrap` row, so when the chips run out of room the browser
  wraps whatever comes next — a chip, Clear all, or the ⋯ menu itself —
  onto a second line in no order of its own, and the search box (which has
  `flex: 1`) shrinks to nothing first.

### What is built

- **The chips are one flex item of their own** (`.list-chips-inline`,
  `flex: 1 1 auto; min-width: 0`, wrapping INSIDE itself) between Filters
  and the ⋯ menu. The first line is used up first — the search box keeps a
  sensible width (`flex: 0 1 280px`, its `min-width` 190) instead of
  giving way, the chips fill what is left of the line, and only the chips
  that do not fit go to a second line, which starts under the first chip
  (right of Filters) so the eye reads them as one list. The ⋯ menu never
  leaves the first line (`align-self: flex-start`). Clear all stays the
  last chip.
- Below about 640px (a phone) the toolbar still wraps as it does today.
- A screenshot at 1400 and at 1100 with four chips and a search term, as
  on 2026-10-12, proves the line order.

## Files

- `api/src/shared/paperName.ts` (new), every PDF route's
  `Content-Disposition`, `shared/listPaper.ts` (`sendListPdf`),
  `api/src/shared/printTickets.ts` (new: issue, verify, spend),
  `api/src/auth/middleware.ts` (the ticket door), one route `POST
  /print-tickets` in `routes/workspace.ts`.
- `web/src/lib/api.ts` (`openPdf` through a ticket), `web/src/styles.css`
  (`.list-toolbar`, `.list-chips-inline`, `.list-search`).
- `api/scripts/verify-foundation.ts`: `paperFileName` (the shape, the
  refused characters, a missing author, the length); verify-workspace
  (HTTP): a ticket opens the quotation paper once, with the standard name
  in `Content-Disposition`; reused, expired, another path, another login
  each a 401; a POST with a ticket refused. verify-sales / the record
  scripts that read `Content-Disposition` (if any) updated to the shape.
- CLAUDE.md: the name rule and the ticket under "Shared seams".

## Questions, with the defaults the build takes

1. **The shape**: `<Kind> <Number> - <Author> - <YYYY-MM-DD>.pdf`.
   Alternative: the number first (`0062602018 - Quotation - …`), or
   underscores instead of spaces.
2. **The date**: the document's own date, not the day it was printed
   (a list paper: today). Alternative: always the print day.
3. **The author**: who prepared the document. Alternative: who is
   printing it.
4. **How the name reaches the browser**: a one-use print ticket so the
   tab is the real URL. Alternative: a G-CORE viewer page with its own
   Save button (the browser's own Ctrl+S would still save under a blob
   name).
5. **Where overflow chips go**: a second line under the first chip,
   right of Filters, the ⋯ menu staying on line one. Alternative: a full
   second row under the whole toolbar.

## Effort (Fable 5.1)

Small to medium — one push, about two hours: the name rule and its
checks (~25 min), the ticket (shared, middleware, route, `openPdf`,
checks) (~55 min), the 25 route names and `sendListPdf` (~25 min), the
chips' CSS and two screenshots (~15 min), CLAUDE.md (~10 min). No schema
change, no new permission.
