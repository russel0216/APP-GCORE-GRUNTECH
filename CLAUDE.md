# G-CORE — notes for AI agents

Integrated business operations platform for Gruntechnology Corp
(`gruntech.gcore.tech`). Node + Express + TypeScript + Prisma + PostgreSQL API,
React + Vite + TypeScript web app, one database.

## Read first

`docs/BUSINESS-OPERATIONS-MODEL.md` is the specification, not background
reading. Before adding a table, screen, form or workflow, check whether an
existing business entity already carries the concept (model §2.9). The whole
point of this rebuild is that the previous implementation was four apps with
four databases and four copies of "customer".

## The rules that are easy to break

1. **The permission registry drives the menu.** `api/src/permissions/registry.ts`
   generates both the `Permission` rows and the navigation. Adding a screen means
   adding a registry entry — never hard-code a menu item, and never check a
   permission string that the registry does not define. The converse holds
   too (2026-10-10): **never mint an action nothing checks.** A box on Admin ›
   Roles that does nothing is a promise the app does not keep; 109 were
   trimmed (Export on lists anyone may print, Approve where the workflow's
   roles decide, Delete on documents that are cancelled), the presets are
   `OWNED`, `OWNED_KEPT`, `SHARED`, `SHARED_KEPT`, `READ`, `REPORT` and
   `SETTINGS`, and verify-foundation reads the source and fails on a key no
   route or screen checks (the two view keys always count — `canView()`
   puts the screen in the menu with them). Only three approve rights remain:
   CAD dispatch, progress reports and training certificates. **A cancelled
   document may be deleted** (2026-10-11, the owner's call, reversing the
   trim for five of them): job orders, CAD J.O., projects and expenses
   carry `delete` again (`OWNED`, CAD's list plus `delete`), and budget
   requests and sales orders already did. Each `DELETE /:id` takes ONLY a
   cancelled one (a draft too for the sales order and the budget request),
   the holder of the delete right who raised it or may edit all, refuses
   while money stands behind it (an invoice on the job order; payment
   allocations on the claim or the request; for a project an invoice,
   bill, PR, PO, stock issue, claim, advance or a budget request past
   draft), runs through `deleteOrRefuse()` in `http/kit.ts` (a foreign key
   that still points at it is a 400, nothing deleted), removes its files
   with `deleteAttachmentsOf()` after the commit, and writes one DELETED
   audit row. On the page it is ⋯ › **Delete**, last and red, asked in
   the confirm bar — the sales order's item, word for word. **A purchase
   request is cancelled too** (2026-10-11): `POST /purchase-requests/:id/
   cancel { reason }` — its requester or edit_all, a draft, a pending one
   (withdrawn through `cancelOpenRequest`, refused if a decision landed
   first) or an approved one with no PO and no live canvass, releasing the
   budget an approved direct-to-job request committed; the reason goes on
   its notes. Its Delete takes a draft, a rejected or a cancelled one.
   **So is a canvass / RFQ** (2026-10-11; canvass is `OWNED` now):
   `POST /canvasses/:id/cancel { reason }` — its opener or edit_all, an
   OPEN one or an AWARDED one with no live PO from the winner on its
   request (refused naming the order otherwise), claimed on the status it
   read, the reason on its notes; a cancelled canvass no longer blocks the
   request's own cancel, and the request may be canvassed again. `DELETE
   /canvasses/:id` takes only a cancelled one, its supplier rows and quotes
   cascading with it.
2. **Never invent a second approval path.** Every document type routes through
   `api/src/shared/approvals.ts`. Call `submitForApproval(...)`, subscribe with
   `onApprovalSettled(...)`, and when a document moves on before anybody
   decides — superseded, or cancelled — withdraw its request with
   `cancelOpenRequest(documentType, documentId, tx, reason, actorId)` in the
   same transaction, never by writing to `approvalRequest` yourself. Do not
   write per-module routing, notification or history. `act()` claims a request
   with a conditional update, so a decision is never written over a withdrawal
   or over another approver's decision. **Two places reach that one path**
   (2026-10-06): My Work's queue, and the Approval panel on the document
   itself (`DocumentApproval`), where the approval notification lands — it
   offers Approve / Return / Reject only when `GET /approvals/history/…` says
   `canAct` (computed with `approversForStep`, never the requester), and posts
   to the same `POST /approvals/:id/act`. Never add a module's own approve
   route.
3. **A requester can never approve their own document.** Enforced in `act()`,
   before the eligibility check, and for super admins too. The one thing
   that looks like an exception is not a decision: on a route with
   `preparerSigns` (2026-10-12) the ENGINE signs, at submit, the steps whose
   role the preparer holds — never a button they press (see "The routing
   sheet of 2026-10-12").
4. **Cost posts only when every step has approved.** Overtime is the live
   example: supervisor *and* HR. Subscribe to the settled event; never post on an
   intermediate approval.
5. **Numbers come from `nextNumber(documentType, tx, ctx?)`.** Never format a
   document number by hand. Pass the caller's transaction so a rollback does not
   burn a number, and pass `{ ownerId }` in `ctx` for anything whose pattern may
   carry `{EMP}` (the quotation's does). `ctx` is a `NumberContext`
   (`{ at?, ownerId?, employeeNo? }`), never a bare `Date`.
6. **Every printable document goes through `renderDocument(...)`.** Uniform PDFs
   across all menus is an explicit requirement. A module supplies sections; it
   never draws a letterhead, sign-off block, strapline or page number.
   **One dress for every document** (2026-10-10, the owner's call, closing
   "pattern other PDF output to the quote template" of the day before): the
   house dress (14pt margins, slate head band, the company block in the
   footer, one-line sign-offs) is gone, and `renderDocument` draws the
   quotation template's dress and nothing else, matched to
   `STANDARD_QUOTATION_DESIGN` to the point — 36pt margins; the letterhead
   top-left (the logo, the registered name — else the trading name — in 15pt
   purple capitals, then the address, "Tel No.: … | Fax No.: … | Email: …",
   "Website: www.…", "TIN: … | REG NO: …", a part whose fields are empty
   dropping out of its line); the document's name in 24pt regular purple
   top-right, wrapped in its 185pt box when long, "# number" in bold green
   under it, a 1.5pt green rule; a DETAILS block (Date, Reference, a Revision)
   in bold 9.5 kept to the template's 41pt box, so every document's first
   table starts where the quotation's does; 8.5pt purple capitals for section
   titles and table heads (capitals, one rule UNDER the head), 30pt rows with
   bold titles over #555 descriptions, 9.5pt regular green subheading rows
   (no tint — `shade` is gone; a `table`'s `headingSpan` says how many
   leading columns a subheading spans); a `totals` box 231.8 wide at the
   right, the final row 11pt bold purple over a 2pt rule, every figure drawn
   whole and never wrapped; side-by-side sign-offs (the role in purple
   capitals wrapping to two lines at most, the NAME in bold 10pt, the phone,
   the email, the date or "Pending"; no position — `Signatory.position` is
   not printed) kept to the foot of the last page; the strapline (the tagline
   in green capitals, else the website, never both) over a 0.75pt rule along
   the foot of every page; "Page n of m" bottom-right on a multi-page
   document and a running header from page two. The engine does its own
   line breaking (the designed engine's rule — PDFKit never wraps a cell),
   so a row taller than a page is split under a repeated head, and a section
   title is never left alone at the foot of a page. A table that names no
   `widths` is sized from its content (`autoWidths`: a column's floor is its
   longest word, the room over the floors goes to the columns whose cells run
   longer), and a document with more columns than portrait can hold prints
   whole on landscape pages with `landscape: true` on the spec (the sales
   order's rule) — verify-foundation renders a ten-column list both ways. A
   trailing landscape `gantt` section is an appendix drawn after the
   sign-offs. Every string
   reaches the page through `pdfSafe`; what the dress sets in capitals goes
   through `caps()` (capitals first — 'µ' would otherwise become a Greek
   capital outside WinAnsi). verify-foundation measures the margin, pins the
   60-row fixture at 4 pages, and proves the letterhead, the strapline (and
   its website fallback, the real tagline stashed in a Setting meanwhile), the
   sign-offs, the running header and the continuation start.
   **Give every signatory an `at`**, so a document dates its own sign-offs. For
   anything routed through the approval engine,
   `approvalSlots(documentType, documentId)` returns one slot per step — the
   name, phone and email of whoever signed, or who is assigned — and
   "Pending" prints where nothing has happened, which is the truth, rather
   than borrowing the document's date.
   **Money is `formatMoney`, which prints `PHP 1,562.20`** — the currency code,
   not `₱`. U+20B1 is outside WinAnsiEncoding, so a standard PDF font draws it
   as `±`. Never put a non-Latin-1 character in a PDF without embedding a font.
   `companyCurrency()` (one indexed read per print, never cached) is the code a
   route names in a table head or a total; `statusLabel()` is how an enum
   prints ("Pending approval"); `formatDate` is a record's date ("October 9,
   2026"), `formatShortDate` a list's (MM/DD/YYYY); a quantity is `formatQuantity` ("4,704", "0.5" — thousands separators, three decimals at most, no trailing zeros), on the quotation and sales order papers and in both designed samples.
   **The quotation, the sales order and the costing are designed
   documents** (the costing since 2026-10-13). Each
   layout is DATA — boxes on an A4 page that an administrator places in
   Admin › PDF Templates — and prints through `renderDesigned(design, data)`
   in `shared/pdfDesign.ts`, the same engine's other door. The module still
   draws nothing: `quotationPrintData()` / `salesOrderPrintData()` /
   `costingPaper()` supply fields, rows, totals and signatories; the engine places every box, keeps
   the dated sign-offs, and puts every string through `pdfSafe`. A layout
   carries its `orientation`: the sales order's standard is LANDSCAPE, in the
   quotation template's dress, because the cost and margin columns do not
   fit portrait. The standard layout (`STANDARD_QUOTATION_DESIGN`) is the
   owner's Quotation_Template (36pt margins, purple #5B2A8C heads, green
   #2E9A4B number and subheadings, light #D9D9D9 rules, totals flush right,
   sign-offs side by side, the strapline on every page, a running header
   after page one, no Conforme); table figures are `formatAmount`, because
   the currency is named in the head and the total — the rule every
   document's table follows. See "Quotation PDF template" below.
7. **Record ownership is real.** Use `canEditRecord(user, module, sub, ownerId)`.
   "Only the author can edit the quotation, super admin can edit all."
8. **Audit through `audit(...)`**, and keep `redact()` in front of anything
   holding a password hash or a cost rate.
9. **Every list screen uses `web/src/components/DataList.tsx`.** Same toolbar,
   same scope switch, same export, everywhere. The toolbar has two weights
   (2026-10-08, after SCORO's list of quotes): the screen's `actions`, search,
   Mine/All and one **Filters** button on the left; one **⋯ menu**
   (`components/Menu.tsx`, the board's menu moved there) with Columns, Export
   CSV, Print (`printPath`, sent the list's own query), Save view and Refresh
   on the right. Never put a tool button back on the toolbar line. Filters open
   in a panel and show as removable chips ON the toolbar line, after Filters
   (2026-10-12): the chips are one block that fills what is left of the line
   and wraps inside itself, the search box keeps its 280px, and the ⋯ menu is
   pinned to the line's right end (`.list-lead`, `.list-chips-inline`,
   `.list-toolbar-main`); a filter is a select, a
   `dateRange` (two keys) or a `lookup` (`search` + `describe`).
   **No tab strip and no totals row** (2026-10-08, the owner's call: "remove
   this line in all, not necessary" / "instead it become a summary card at
   the top of list like in SCORO"): what the strip filtered is an ordinary
   Filters select on the same key (`stage`, `status`, `industry`,
   `category`), so every old link still narrows the list, and the endpoint's
   `summary` is drawn as **summary cards** over the table — `summary` on
   `DataList` returns `Stat` tiles (`components/charts.tsx`) into a
   `kpi-grid list-summary`: the count, the sum, the margin, and on the
   quotation list **a card per team** (2026-10-09, the owner's call: "there
   should be 8 cards, separate card by team" — KAT, HIT, UIT, GIB, SIT from
   `summary.teams`, each its value over its count, `teamCards()`; a
   quotation whose owner has no team is said on the Quotations card, never
   a ninth card). Eight across: the list's cards take a smaller figure
   (`.list-summary .kpi-value`, `nowrap`) so a sum never breaks mid-number.
   The leads and sales order lists draw the same cards (a lead's share is
   its estimated value, an order's its booked total): `teamShares()` in
   `shared/team.ts` is the one split, `teamCards()` / `noTeamNote()` in
   `components/charts.tsx` the one drawing, and verify-sales asserts each
   list's shares add up to its own total. A screen that
   learns from the summary (the stage names, the categories on file) still
   takes `onSummary`. Never a totals line, under or over, again.
   `defaultScope` is where the scope switch starts when the URL says
   nothing; the switch is **Mine · Team · All** where `teamScope` is on —
   Team for a viewer whose employee record has a team (`me.user.team`,
   `shared/team.ts`: the Team IS `Employee.industryId`), on the quotation,
   lead and sales order lists, and the API's `?scope=team` falls back to
   Mine for a viewer with none. **A list screen is its title and the list**:
   no paragraph under the title, and the primary button is "+ New …" on
   every one of them (the owner's call, 2026-10-08). **Saved views are the
   person's own, on their ACCOUNT** (2026-10-12, the owner's call: "custom
   column and save so this will be the one who always pops up during viewing
   of list by user"): `SavedFilter` rows through `/api/saved-filters/:listKey`
   (GET answers `mine`; a colleague's view is never theirs to change), each
   holding the search, scope and filters AND the columns it hides
   (`hiddenColumns`, null keeps the person's own), and at most one per person
   per list is the **opening view** (`isDefault`, ★ on its chip; "Open this
   list with it" on Save view, or "Save as my view…" in the Columns panel) —
   making one the opening view clears the other in the same transaction. A
   BARE visit (no `?q=`, `?scope=` or declared filter in the URL —
   `isBareVisit()` / `openingView()` in `lib/listUrl.ts`) opens on it in
   place of `defaultFilters`, and its rows wait for the views so nothing
   flashes; a link that filters is never changed under it. A filter the view
   took from the list's defaults is stored as `@default`
   (`keepDefaults`/`fillDefaults`), so year to date stays year to date next
   January. Views kept in the browser before (`gcore_views_<listKey>`) move
   to the account once, by name. Loose column choices stay per browser in
   localStorage (`gcore_cols_<listKey>`); a view's columns win when it is
   applied. **Mass actions** (`selectable`): tick boxes and a bar over the
   table with Export selected, Print selected (`printPath` with the ticked
   keys as `?ids=` — so a `printPath` endpoint must honour `ids` through
   `idsFilter()` in `api/src/http/kit.ts`, ANDed with its visibility rule,
   at most 500, and `rowKey` must be the record id) and the screen's own
   `bulkActions(ctx)`. A screen's own tools (the customer list's Import) go
   in the ⋯ menu through `menuItems`; a record's paper opens from its row
   through `PdfButton` (`components/ui.tsx`, a `PDF` column at the row's end
   on the quotation and sales order lists — SCORO's icon: the paper without
   opening the record; the click and the keys stop at the cell, so the row
   never opens with it); `onSummary` hands a screen each fetch's
   summary (never set state from inside `summary`, which runs in render). A selection outlives a page change, never a change of
   search, scope or filters; the rules are `pageSelection` / `togglePage` in
   `lib/listUrl.ts`. A ticked row's box never opens the record. **Never a
   bulk delete** — a record is deleted from its own page, with its own
   refusals. **Every chart uses
   `web/src/components/charts.tsx`** — `Stat`, `BarList`, `Funnel`, `Donut`,
   `Meter`, `MiniBar`, `Panel`. There were three hand-rolled bars before that
   file and none of them looked alike. Two rules they hold to: a chart is
   readable without colour (every series carries its own number), and an empty
   series says "nothing yet" rather than drawing a frame that looks like a
   failed load.
9a. **A menu entry must open what its label says.** Both halves of that: the
   path in the registry has to have a route (G-OPS Purchase Requests had none
   and fell through to "No screen at this address"), and the screen has to show what the
   label promises ("Progress & Billing" showed progress reports only). Run the
   label-to-component map before adding a menu entry, not after.
10. **Money is `Decimal` in Prisma**, converted with `Number()` only at the API
    boundary. Never do arithmetic on a float and store it back.
11. **Spacing, type and colour come from tokens in `web/src/styles.css`.** Use
    `var(--s-1..--s-8)` for spacing, `var(--fs-xs..--fs-2xl)` for type. Do not
    write a raw pixel value in an inline `style`; the app carried 537 of them
    across fourteen different margin values, and that is what the tokens exist
    to stop. `--faint` is the *lowest* readable text colour at 4.6:1 — nothing
    dimmer.
12. **One status pill: `StatusBadge` from `components/ui.tsx`.** `statusTone()`
    takes an `extra` map for a module's own statuses. Do not write a tenth local
    `tone()`; there were nine and they had already drifted.
13. **Every interactive thing is reachable from a keyboard.** A `<div onClick>`
    that opens a record is a bug. Use a `<Link>` or a `<button>`, or give it
    `tabIndex` and an Enter/Space handler. `:focus-visible` is global — do not
    remove an outline without replacing it.
14. **The menu is two levels, and both come from `SubmoduleDef.group`** in
    `api/src/permissions/registry.ts`, carried through `menuFor()`. The sidebar
    lists a module's SECTIONS; the section you are in opens its screens on a
    second line across the top. A module whose entries declare no group renders
    flat with no second line. `group` takes no part in permission keys — adding
    or renaming one leaves `allPermissions()` byte-identical. Never hard-code a
    grouping in `Shell.tsx`, and keep a section to roughly six screens: ten on
    one line is what the two levels exist to avoid.
15. **A menu path must be a path the app actually renders.** Three aftermarket
    entries used to `<Navigate>` to `/g-ops/service-reports?kind=…`, a URL the
    registry does not declare — so the menu could highlight nothing, and the
    `?kind=` was never read, leaving all three menus showing every report. One
    screen serving several menu entries takes `initialFilters` on `DataList` and
    keeps each entry's own path.
16. **A DataList's state lives in the URL, and only for keys it declares.**
    `?q=`, `?scope=`, `?page=` and `?<key>=` for every key in the screen's
    `filters` (both keys of a date range) and its `tabs` are read on mount and
    written back with `replace` — the rules are `web/src/lib/listUrl.ts`,
    DOM-free and pinned by verify-foundation; `scope` is written only when it
    differs from `defaultScope`; undeclared keys
    (`new`, `customerId`, `visit`, `tab`…) are left untouched, so a list never
    eats another screen's deep-link parameter. The URL beats `initialFilters`,
    and a value equal to the route's preset is not written, so a preset menu
    entry keeps the path the registry declares (rule 15). The API query still
    says `search=`; only the browser URL says `q=`. A link such as
    `/g-fin/ar?overdue=true` filters only if that DataList **declares**
    `overdue` — link to declared keys only, and when a dashboard tile links to a
    list, the tile's count and the filtered list's total must come from the same
    query (the G-CHAIN "awaiting delivery" tile and `?awaiting=true` are asserted
    equal). A page mounting two DataLists at once passes `urlState={false}` on
    one of them, or they share `?page=`.
    **A default is not a preset** (2026-10-11, the owner's call: "default
    view of quotation, leads, sales order is year to date"):
    `defaultFilters` on DataList fills a BARE visit only — no `?q=` and none
    of the list's filter keys in the URL (`startFilters()` in
    `lib/listUrl.ts`, pinned by verify-foundation) — and is written to the
    URL like any filter the person set, so removing its chip shows
    everything and Back returns to it; a link that filters (a dashboard
    tile, the Forecast's closing dates) is never narrowed by it, so its
    count and the list's total stay one query. The Quotations and Leads
    lists open on `createdFrom` = 1 January of this year, Sales Orders on
    `dateFrom` (`yearStartKey()`), the summary cards and the printed list
    following. A preset (`initialFilters`) stays what a menu entry IS and
    is never written.

17. **Every numeric input is `components/NumberInput.tsx`** (2026-10-06, the
    owner's call) — never `<input type="number">`, never a hand-rolled
    `inputMode` text box. It takes `kind`: `money` / `quantity` / `percent`
    (commas, at least 2 decimals), `count` (commas, whole), `decimal` (commas,
    its own decimals) or `plain` (a year: no commas). It shows the plain number
    while focused, accepts typed commas, refuses a keystroke that cannot be
    part of a number, and hands `onChange` `{ target: { value } }` with the
    commas removed — so a handler written for a number box works unchanged.
    `min`/`max` go through `setCustomValidity`, so `checkValidity()` still
    sees them; the arrows step by `step`. A value is never rounded for
    display (a 3-dp quantity shows its third decimal). The rules are
    `lib/number.ts`, DOM-free and pinned by verify-foundation. `Field` wires
    its label to it because it carries a static `fieldControl`.

18. **The word is "customer", never "client"** (2026-10-08, the owner's call) —
    on every label, column, filter, placeholder, message and PDF heading, in
    every module. Only the leads list's URL key `clientId` keeps the old word,
    because it is a link key, not a label (rule 16). "Client" in a code comment
    about the HTTP client or the Prisma client is a different word and stays.

19. **One button grammar on every screen** (2026-10-09, the owner's call:
    "consider always the uniformity of button location — modify, delete,
    back; if a button is not necessary in a module, remove it").
    - **Back** is drawn by the Shell alone on the first line of every page
      deeper than its menu entry ("← Back to Quotations"). No page draws a
      Back button or a breadcrumb; lineage (the project, the request it came
      from) is a link in the header's `meta` line. A page whose way back is
      elsewhere says so with `useBackLink(to, label)` (`components/
      Navigation.tsx`): an editor goes back to its record, a progress report
      to its project.
    - **Every record page's header is `RecordHeader`**: KIND • NUMBER, the
      status pill, the title, one `meta` line, the amount — and the buttons
      ALWAYS in this order: **[next steps…] [Print] [⋯] [Modify]**. Next
      steps (`actions`) move the record on — exactly one `btn-primary`.
      Print (`print`, the record's `/api/…/pdf`) is one word everywhere.
      The ⋯ menu (`more`) holds the rarer actions and, last and in red
      (`danger`), the destructive ones — Cancel <document>, Mark lost,
      Delete. Modify (`modify`: an editor path or a handler) is always the
      right-most button, and the only entry to the editor.
    - **Nothing destructive happens without asking**, and asking is ONE
      thing: `useConfirm()` (`components/Confirm.tsx`) — a bar under the
      header that says what will happen, takes a reason where the document
      keeps one, and offers "Keep it" and the action; a refusal from the
      server shows in the bar. A ⋯ item with `confirm` opens it; a page
      passes the same `confirm` to `RecordHeader` for its own buttons. Never
      `window.confirm`/`prompt`, a cancel modal or a hand-built confirm bar.
    - **Every modal footer is `ModalFoot`** (`components/ui.tsx`):
      [Delete] … [Cancel] [Save] — Delete only on a record edited in that
      modal with no page of its own, and it asks in the foot. Titles say
      "New <thing>" (opened by "+ New <thing>") or "Modify <thing> <id>";
      a part of a record (a line, a contact, a location) is "+ Add <part>"
      and is removed with "Remove" in its modal. A modal asks before
      Escape, an outside click or ✕ throws away typed changes, and only the
      top-most modal reacts to Escape.
    - **A page editor** (`/new`, `/:id/edit`) has Save top-right and again
      at its foot, no Back or Cancel of its own, and holds unsaved edits
      with `useUnsavedChanges(dirty)`: every in-app link asks first in one
      leave bar, and the browser asks before the tab closes.
    - **Labels**: "+ New …", "Modify", "Save", "Cancel" (a read-only
      modal: "Close"), "Submit for approval", "Print", "Delete". Never
      btn-ok, never btn-sm in a header. A button that duplicates another
      way to the same place, or leads somewhere that no longer fits, is
      removed — never the only way to perform an action, which moves into
      ⋯ instead.
    - **Two button sizes, one per place** (2026-10-10, the owner's call:
      "make the button sizes uniform in all cards"): the page's `.btn`
      (`--btn-h`, 35 tall, `--fs-base`) on a `.page-head`, a `RecordHeader`,
      a page editor's Save (`.qe-actions`, `.qe-foot`, `.page-foot`), the
      confirm bar and a modal; the card's `.btn-sm` (`--btn-h-sm`, 29 tall,
      `--fs-sm`) everywhere INSIDE a card — its head, its body, its foot
      (`.card-foot`, `.panel-foot`), a table cell, a list toolbar, a
      calendar's own toolbar, the pager. Both are fixed boxes, so a flex
      parent cannot stretch one against a taller sibling and a card's 13pt
      body cannot shrink one; `.btn-icon` is the same box square (the ⋯ in
      a record head is a 35 square). `ExportButton` takes `small` inside a
      card. The clock's `clock-btn` is the one deliberately bigger button;
      the scope-switch pills and the calendar grid's own controls are not
      buttons in this sense.
    - **One table row** (2026-10-10, the owner's call: "make the table row
      spacing uniform in all cards"): every `table.data` row is at least
      `--row-h` (56 — "Table row height" in Modify layout), its cells
      padded 8 × 12 and centred vertically, 13px at 1.4. A line of text, a
      status pill, a `.btn-sm`, a title over its caption or a 38px text box
      all make the same row; before, the same table read 45, 48, 54, 61 or
      65 depending on what the first cell held. A cell whose content really
      runs longer (a description, a stack of three) still grows — that is
      content, not spacing — and a line table whose descriptions run long
      (`.qe-lines`, `.quote-lines`, `.meeting-invitees`)
      keeps `vertical-align: top` by its own rule. The head is 41 on every
      table (the list's tick box is a block, so it no longer takes the
      line's descender room with it); a select pads 9 × 12 so it is the
      text box's 38 and not 40. Never give a module's cells a padding or a
      row height of their own.
    - **One text box** (2026-10-10, the owner's call: "make the form input
      sizes uniform in all cards"): every text box and select is
      `--field-h` tall (38 — "Text box height" in Modify layout) at
      `--fs-md`, padded sideways only, so a date, a time, a search box or a
      select — each with its own idea of content height — is the same box
      as a text box, in a card, a modal, a table cell or a list toolbar
      alike. Before: 38 in most cards, 39 at 14pt in a list's search, 37 at
      12pt in the pager, 36 and 28 in the quotation editor, 40 for a date,
      42 for a time, 11pt on the forecast. A textarea is as tall as its
      rows and takes the same type. The quotation editor's line boxes pad
      8 sideways instead of 12 (the quantity and price boxes are narrow),
      and the Ctrl+K palette's box is deliberately bigger; nothing else
      sets a control's height, padding or type of its own.

20. **One way to pick, one way to state a fact** (2026-10-09, rule 19's
    content half: the editors of every module read alike, not only their
    buttons).
    - **A person** (a login): `components/People.tsx` — `usePeople(holding)`
      / `loadPeople(holding)` is the ONE fetch of `/users/lookup`, cached a
      minute per holding key, so ten forms asking for project managers make
      one request; `PersonSelect` is the one single-person control (a native
      select grouped by department, "— none —" unless required, `current`
      keeping someone on the record who has since left the list, `self`
      marking the viewer's row "(you)"); several people are `PeoplePicker`
      fed by `toPerson()`. Never a hand-written
      `/users/lookup` fetch or a `<select>` of users — verify-foundation reads
      the source and fails on one. `/employees/lookup` (an employee, who may
      have no login) is another list and keeps its own pickers.
    - **A customer**: `CustomerPicker` wherever a form picks one, unless the
      choice is deliberately narrower (a job's customer is its costing's; a
      requestor without `gops.customers.view_all` picks from the job-order or
      CAD form's own options). "Add as a new customer" is offered only to a
      `gops.customers.create` holder and where the form allows it
      (`allowCreate` — not on Modify of a registered machine). The lead form
      keeps its own lookup: its text is the lead's company name, saved
      whether or not a customer is linked.
    - **A supplier** (2026-10-10, the owner's call: "separate Customer to
      Supplier"): `SupplierPicker` (`components/SupplierPicker.tsx`), the
      customer picker's twin on `GET /suppliers/lookup?q=` — the purchase
      order, the canvass's "+ Add supplier" (`exclude` keeps the ones already
      asked off the list), the supplier bill, the item master's preferred
      supplier and "+ New partner › An existing supplier". "Add … as a new
      supplier" files one by name through the ordinary `POST /suppliers` for
      a `gchain.suppliers.create` holder; `disabled` shows a supplier the
      document has decided (an order from an awarded canvass, a bill on an
      order). The quotation editor's provider cell stays its own narrower
      list (`/quotations/providers`, readable by sales without the supplier
      right). The seeded `finance` and `accounting` roles hold
      `gchain.suppliers.view_all`, or the bill form could name nobody.
      **Both pickers say why nothing is listed** — "could not be listed"
      when the lookup failed, "no … matches" once it answered — and offer
      the quick-add only after the lookup has answered for what was typed.
    - **A contact person** (2026-10-12, the owner's call: "allow to add
      contact person; if it's not on the database allow also add"):
      `ContactPicker` (`components/ContactPicker.tsx`) on the quotation
      editor, its Modify page and the sales order editor — the chosen
      customer's contacts as it is typed, and **add "X" as a new contact**
      for a `gops.customers.edit_all` holder, which opens a panel under the
      box (name, position, mobile, email — never a dialog) and files them
      through the ordinary `POST /customers/:id/contacts`. That route
      refuses a name the customer already has (trimmed, single-spaced,
      case-blind; 409), under a lock on the customer's row. Under the box,
      the contact's number and email — what the Attention line prints
      (`Mobile: {{contact.mobile}} | Email: {{contact.email}}` under
      `Attention:` on both standard layouts; `contact.mobile` is the
      mobile, else the phone; a saved layout keeps its own boxes).
      `ContactSelect` is gone.
    - **Every text box of the two editors remembers** (2026-10-12, the
      owner's call: "in all of the input, even description, allow memory
      suggestion of previous input"): `MemoryInput` (`components/
      MemoryInput.tsx`, `multiline` for a textarea, a `fieldControl`) asks
      `GET /quotations/suggest/fields?field=` (brand, productType, subject,
      delivery, paymentTerms, terms, notes, lostReason, description, unit)
      or `GET /sales-orders/suggest/fields?field=` (comment, paymentMethod,
      description, unit) — values only, from documents the caller may
      read, newest first (Brand and Product type alphabetical), each text
      once case- and space-blind, the very text typed never offered back
      (`shared/memory.ts`); an unknown field is a 400. A description under
      the line's brand, product type or part number comes first. Numbers,
      dates, money, PR No. and PO No. never remember. Inside the line
      table a suggestion list opens IN the cell (`.qe-table-wrap
      .lookup-menu`), because the table scrolls sideways and would cut a
      floating one off.
    - **All three are `fieldControl`s**, like `NumberInput`: inside a `Field` the
      label, the hint and the error reach the control, and a control marked
      `required` puts the asterisk on its label.
    - **Read-only facts**: `<dl className="kv">` with dt/dd pairs — the
      quotation page's look: the label in a 10rem column beside its value,
      one size for both, the label told apart by weight, stacked on a phone.
      `.m-details`, `.qd-row`, `.cs-fact`, `.sales-row` and `.act-rows` wrap
      their pairs differently and share the same rules in `styles.css`; no
      new pattern. A section inside a form is headed `.svc-subhead` (or
      `.m-section-head`, the same look).
    - **Forms**: a page editor puts labels BESIDE values (`.qe-rows`, SCORO's
      way); a modal puts them above (`Field`, `.grid-2`) so it stays narrow.
    - **Every record has a page at `/:id`**; a modal is for a form. Payments
      were the last record opened as a modal over their list: `/g-fin/
      payments/:id` (readable with payments, A/R or A/P view rights, as the
      API allows; Mark cleared, and Delete in ⋯ for a delete right), and an
      old `?payment=` link redirects there.

## Verification

```bash
cd api && for s in foundation masters sales costing pipeline calendar numbering partners delivery chain hr plantilla meetings evaluations academy finance aftermarket cad insights insights-brief workspace accounts; do npx tsx scripts/verify-$s.ts; done
```

**4,194 assertions across twenty-two scripts** (counted 2026-10-13, after
the one dress, the sign-off and money rules, the printed lists, the
permission trim, the face clock-in upgrade and its review, the liveness
check, the SCORO archive's removal, which took verify-archive and two
foundation checks with it and added nine — the removal's once-only rule —
the series that follows a typed quotation number with its review — the
parser's two bounds and the walk that fits a transaction — 16 on sales and
33 on numbering, the one creation of an employee with their login, 22
on accounts, and the SCORO quotes import — 33 on sales, with the lines
export and the summary line's replacement, and 10 on masters for the
UTF-16 decoding, the tab delimiter and the grouping of rows, and one on
foundation for the quantity formatter, and 6 on sales for the imported
quotation that needs no approval until it is changed, and 11 on sales
and 3 on masters for the capitals, the group the SCORO import asks
about, a deleted group, the group refused at save and the customer's
address, and 7 across cad, finance, delivery and aftermarket for deleting
a cancelled document, and 2 on chain for cancelling a purchase request, and 4 on sales for
the routes by who prepared the document, and 5 on sales for the
quotation's own currency and the order paper's margin %, and a net one on
foundation for the approvals as a one-row table, and one for the short
order on one page, and one on sales for a subheading worded in
line_comment, and 24 on workspace for the Help box's tickets and who
receives them, and one on sales for a row the database refuses, and 2 on
foundation for the sales lists' year-to-date default, and 5 on sales for
the team the SCORO import tags its quotations with, and 4 on foundation
and 4 on workspace for the views on the person's account, and 3 on
foundation for the teams Back Support supports, and 2 on workspace for
deleting a role, and one on accounts for the team picked on a user, and 3 on sales for
the team picked on a quotation and followed by its sales order, and one
on sales for old quotations taking their author's team, and 16 on
foundation and 22 on sales for the routing sheet of 2026-10-12 — the
preparer's own signature, the stand-in and the team's leader, and 4 on
foundation and 4 on sales for the sales order paper of the owner's slide, and
17 on sales for the contact person on the paper, its quick-add and the boxes
that remember, and 2 on foundation and 9 on sales for the attachments printed
behind the quotation and the sales order, and 9 on sales and 9 on pipeline
for the Forecast's breakdowns and its date range, and 7 on sales and 12
on pipeline for its tick-box filters and the comparison range, and 6 on
foundation and 5 on workspace for the paper's file name and the print
ticket, and 7 on foundation, 2 on costing, 5 on chain and 4 on delivery for
the routing sheet of 2026-10-13 and one signature per person, and 3 on
accounts for a login email already in use, and 2 on sales for one name
per person on the quotation's paper, and 5 on accounts for the admin's
address moving once, and one on workspace for a print ticket reopened by
a viewer extension, and 5 on sales for the supplier kept as a note, the
selling roles' supplier right and Hold and Cancel's rules, 23 on costing for
the Project Costing paper, the preloaded scope, the fixed price and the
schedule of values, and 8 on pipeline for the board without its forecast
column and Hold and Cancel's round trip, and for the owner's six of the
evening of 2026-10-13: 2 on delivery for the S-curve's ticks, 6 on costing
and 3 on delivery for Mon–Sat and the start and finish dates, 14 on
meetings and 2 on calendar for the minutes and the map links, 17 on
delivery and one on cad for the Request for Approval, 4 on costing for the
costing's PDF template and 37 on hr for People Flow, and 2 on foundation
for the Technical Manager on the preparer's team, and one on foundation
for Back Support's own team, and 3 on foundation and 13 on chain for the
purchase requisition page, and one on foundation and 9 on chain for the
purchase order page, and one on foundation and 5 on costing for a line's
supplier and note, and one on chain for an approved request not counted
twice against its budget, and 2 on foundation for the owner's order of the
divisions and G-CHAIN's strips, and 20 on chain for the Request for
Quotation, and 8 on chain and one on foundation for the canvass sheet,
and 19 on chain for Incoming and Outgoing on approval, and 15 on chain for
borrow requests, and 17 on chain for pull-out slips, and 2 on chain for the
inventory board, and one on chain for the purchase order's paper, and one on chain for goods received without a purchase order and 4 on meetings for the attendees agreeing the minutes, and 2 on chain for the stock states and the automatic reorder, and 7 on chain for Outgoing as the requestor's receive proof):
foundation
373, masters 92, sales 608, costing 197, pipeline 121, calendar 98, numbering
79, partners 120, delivery 171, chain 317, hr 468, plantilla 123, meetings
115, evaluations 152, academy 120, finance 317, aftermarket 259, cad 101,
insights 98, insights-brief 50, workspace 82, accounts 133. The
verify scripts share
`scripts/lib/paper.ts` for reading a PDF's text and checking a list's
paper. A check must not depend on what the database
already holds: count only the script's own TAG (verify-cad's lead queue), and
build the fixture a check needs (verify-insights' uninvoiced billing). They cover permission resolution, numbering
concurrency and the per-employee counters, the approval engine, the overtime
two-step rule, amount bands, the audit trail, the PDF engine and the sign-offs,
margins and money it prints, CSV parsing, the import contract, Phase 3's money
paths (contract amount, schedule-of-values reconciliation, VAT both ways,
revision immutability), Phase 6's HR arithmetic and the face clock (the
engine on the vendor's demo photographs, `decideFace` at its edges, the
quality gates, enrolment, refusals, sample routes and guards), Phase 7's
tax, aging and allocation arithmetic, Phase 8's schedule dates and template
versioning, Phase 9's reconciliation between the reports and the records, and
Phase 10's rules listed below.

**Only `verify-foundation`, `verify-masters` and `verify-sales` run without the
API** (and the SMTP half of `verify-accounts`, which talks to a fake mail server
it starts on 127.0.0.1). The other nineteen check route guards and responses over HTTP against
`http://localhost:5100`, and say so loudly — a failed "API is not reachable"
line — rather than skipping them if the API is down or restarting (under
`tsx watch` an edit elsewhere restarts it mid-run; rerun that script). All create
their own records and clean up. Run them after touching anything in
`api/src/shared/` or `api/src/permissions/`. Add cases when you add a shared
service — the services have no click-path to test them, which is exactly why
these scripts exist. A script that needs a module's `onApprovalSettled`,
`registerSearch` or `registerSchedule` side effect imports that route module
(`verify-academy` imports `routes/academy`, `verify-numbering` imports
`issuedThisPeriod` from `routes/admin`).

**Cleaning up includes what a script told real people.** A document submitted
through a seeded workflow notifies whoever really holds the role, and deleting
the test users leaves those notifications behind — about 4,900 on the laptop's
sandbox users by 2026-10-02. Every subject a script submits carries its TAG,
and `cleanup()` deletes the notifications whose title contains it (or whose
link points at its records, as verify-evaluations and verify-plantilla do). A
tag is letters only: a Prisma `contains` passes `_` and `%` through as LIKE
wildcards, which is why verify-foundation's subjects carry `ZZFOUNDATION`
rather than its `__verify__` TAG.

`npx tsx scripts/audit-workflows.ts` is a separate read-only check: it reports
any workflow step routed to a role nobody holds, or to the role that normally
raises that document. Two seeded workflows shipped with that second fault and
were found one at a time by documents refusing to submit — run this instead.

`verify-sales.ts` checks the STANDARD designed layouts' wording, so it sets an
administrator's saved quotation AND sales order layouts aside for the run
(`pdfTemplate.<type>.__verify__`, Settings of their own) and `cleanup()` —
which also runs first — puts them back; `verify-costing.ts` does the same
with the costing's (`pdfTemplate.costing.__verify__`). `verify-finance.ts` does the same
with the finance rules (`finance.rules.__verify__`): it changes the
liquidation days to prove which rule a deadline read, and a run that dies
leaves the stash for the next run's `cleanup()` to restore. `verify-hr.ts`
does the same with the HR rules (`hr.rules.__verify__`): the liveness check
defaults on, so the run switches `faceLiveness` off for the face checks that
are not about it and its liveness section switches it on; it also
sets the stored face threshold and removes `seed.faceEngineMigrated` to prove
the once-only migration, and puts both back in a `finally`; it also deletes
the FILES of its uploads (a face sample, a clock capture, an account photo),
because their rows cascade with the uploader and the files on disk do not,
and it proves a refused capture is not kept by looking for its exact bytes
among the new files, so another script's upload cannot fool the count.

`verify-sales.ts` imports `src/routes/sales` purely for its side effect, because
that import is what registers the quotation's `onApprovalSettled` subscriber. If
a test ever needs an approval outcome to do something, it must import the module
that subscribes — otherwise the approval settles into the void, and the engine
warns about exactly that.

## Local development

```bash
docker compose up -d
```

Postgres is on host port **5433**, not 5432, so it cannot collide with an
existing local install. Then `cd api && npm run dev` and `cd web && npm run dev`.

Seeded admin: the seed creates `gcore@gruntechnology.com` / `ChangeMe!2026` (or
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) **only on a database with no super
admin at all** — never because the configured address is not on file, which
would leave a second super admin on the known password. **The admin's address
moved once** (2026-10-13, the owner's call): `moveAdminEmail()` in
`shared/adminEmail.ts`, run by the seed on every deploy, gives the super admin
signing in as `admin@gruntech.com` (or the old `SEED_ADMIN_EMAIL`) the address
`gcore@gruntechnology.com` — same login, password and history, audited, marked
in `seed.adminEmailMoved`; it waits, unmarked, while another login holds the
new address. The local dev database's admin password has since been changed,
so that pair will not sign in here; use
`npx tsx scripts/reset-password.ts gcore@gruntechnology.com` if you need in.

Re-running `npm run seed` is safe, and the rule it follows is worth knowing
before you change it:

- Permissions are refreshed from the registry and stale ones removed.
- A role/permission pair the seed has **never offered** is granted. This is how
  a permission introduced by a later phase reaches existing roles — without it,
  every new screen stays invisible until someone ticks it by hand.
- A pair it **has** offered before is left alone, because its absence now means
  an administrator revoked it deliberately.

The record of what has been offered lives in the `seed.offeredRolePermissions`
setting. Deleting that row makes the next seed re-grant every role its full
starting set, overriding any revocation.

## Decided, do not relitigate

- **Single tenant.** Gruntech only. Gas Ion keeps its own deployment. Company
  details still live in Settings because configurable PDF branding is a stated
  requirement — that is not tenancy work.
- **G-FIN is operations-driven only** — AR, AP, expenses, payments, cash flow,
  budget vs actual. No general ledger, payroll, fixed assets or tax filing.
- **Billing is VAT 12% + EWT 2%**, rates configurable. Downpayment recoupment and
  retention are deferred, with nullable columns reserved on `Job` and
  `ProgressBilling` so either can be switched on without migrating history.
- **EWT is withheld at source.** Invoiced ≠ collectible. A/R aging must never
  report withheld EWT as overdue.
- **Master data starts clean** — nothing migrates from the gasiontech apps.
  Phase 2 still ships a CSV import per master so a bulk load stays possible.

## Deployment — the hard constraint

The production server is **shared with a safety-critical system**
(`gasion-vision`, live hospital oxygen-plant monitoring). Careless restarts have
taken it down three times.

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). A `//FI "WINDOWTITLE eq ..."` filter does
  not make it safe — background processes have no window title, so the filter
  matches nothing and any `||` fallback runs the unfiltered kill.
- **Never** stop or reconfigure the `Cloudflared` Windows service.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup` on that host.
- Restart only by PID, by port, or via G-Core's own service entry.

In production the API serves `web/dist`, so there is one origin and one tunnel.

**The scripts are in `deploy/`.** `preflight.ps1` is read-only and reports what
would collide; `install.ps1` runs once and refuses if the preflight fails;
`rebuild.ps1` / `rebuild.sh` are every deploy after that — and since
2026-10-08 the server runs them itself: `autodeploy.ps1 -Register` makes the
`GCoreGruntechDeploy` task, which every five minutes fetches `origin/master`
and rebuilds when it moved (`data/logs/deploy.log`, outcome in
`deploy-last.txt`), so **a push to master is a deploy**. The rebuild builds
the new code BEFORE it stops the running site (a commit that does not build
leaves the site as it was), asks no questions (`--ff-only`,
`GIT_ASK_YESNO=false`), and holds `data/rebuild.lock` so two cannot run at
once. The task runs as the administrator who registered it, because the pull
needs their saved GitHub login. G-Core owns
`C:\G-CORE-GRUNTECH`, port **5100**, the **`GCoreGruntechApi`** scheduled task,
the **`gcore-gruntech-db`** container on **5435**, and the **`gcore-gruntech`**
tunnel — nothing else on that machine.

**A task made by `schtasks /Create` stops after 3 days** (Windows' default
`ExecutionTimeLimit` PT72H, plus "stop on battery power", which a UPS on USB
trips), and schtasks has no switch for either. The tunnel task, which no
deploy restarts, died that way twice (Error 1033, 30 Sep and 4 Oct 2026).
`deploy/tasks.ps1 -Ensure api|tunnel|deploy` lifts both from G-Core's own
three tasks (it refuses any other name); install and both rebuilds call it, and the
rebuilds then start the tunnel if it stopped and prove `APP_URL` answers from
outside. Any new G-Core task goes through it too.

Two traps worth knowing before you edit those scripts:

- **The repository's root `docker-compose.yml` must never run on that server.**
  It publishes 5433, which is already `gasion_db`. `deploy/docker-compose.prod.yml`
  uses 5435 and its own volume.
- **`node.exe` reports the same executable path for every node process on the
  box**, so an ownership check on `Process.Path` would judge our own API a
  stranger and refuse to free the port on every rebuild. `Test-OurProcess`
  matches on the *command line*, which is why `start-api.cmd` launches with an
  absolute script path. Do not "simplify" either half.

## Known advisory

`npm audit` flags `deepmerge-ts` (high) reached through the Prisma **CLI**'s
config loader — a dev-time dependency that only parses our own schema, not in the
server's runtime path. Prisma 7 drops it but adds an unused `mysql2` advisory, so
the tree is pinned to Prisma 6.19.3. Re-evaluate when Prisma 7 stabilises.

## Build order

**All ten phases are built.** The sequence in
`docs/BUSINESS-OPERATIONS-MODEL.md` §11 is complete; Phase 10 added depth across
every division (hire-to-separate, cash advances, job orders, the pipeline board,
partners, the numbering house scheme and more — see "Phase 10 notes" below and
model §4.7).

What is left is not more phases. It is: deploying to the server under the
constraints below, assigning the seeded roles to real people (run
`scripts/audit-workflows.ts` — approvals route to roles, and an unheld role
means documents stall), entering real master data, and the two open questions
in model §14 (retention/downpayment, and whether Gruntech withholds from
suppliers) plus the Phase 10 decisions listed there. Treat further work as
changes to a live system rather than as
phases: add a case to the matching `verify-*.ts` for anything that touches
`api/src/shared/`.

Every phase has landed, so the web no longer knows phases (2026-10-10):
`SHIPPED_PHASE`, the "soon" menu branches and the `P<n>` tags on the Roles and
Users screens are gone. The registry's `phase` field stays as history; nothing
reads it. A path under a module that no screen answers renders `NotFound` in
`App.tsx` ("No screen at this address", with the module's first screen and the
launcher as the way out) — never a stale phase sentence.

## Phase 2 notes worth carrying forward

- **Employee vs User.** `Employee` is the person; `User` is the login, linked
  1:1 and optional — and created together since 2026-10-10 (see "Accounts and
  sign-in"). The reporting line lives on `User`, not `Employee`, because
  the approval engine routes by user and two places to record "who approves for
  me" is one too many.
- **Pay data** (`dailyRate`, `burdenMultiplier`, statutory numbers) is stripped
  server-side unless the caller holds `ghr.employee_rates.view_all`. Never hide
  it in the UI alone. Projects are charged the burdened rate, never the wage.
- **Cost categories are system rows.** The five cannot be deleted; the ledger
  groups by them. Labels are editable.
- **Deleting a master** is fine today because nothing references them. From
  Phase 3 onward, a customer with quotations or a supplier with POs must be
  deactivated, not deleted — commercial history cannot lose its counterparty.

## Phase 3 notes worth carrying forward

- **ScopeSection is both the scope of work AND the Schedule of Values.** One
  record, deliberately. Phase 4 reports progress against these sections, bills
  against them and draws the S-curve from their durations. Do not add a parallel
  SOV table.
- **The SOV must total the contract value.** `POST /costings/:id/sections/
  distribute` reconciles it, putting the rounding remainder on the last section
  so the sum is exact rather than a centavo out.
- **A phase's value is spread, declared or priced from cost** (2026-10-13,
  the owner's call: "the scope of work value editable to declare the value;
  the materials cost is allocated to purchasing of materials, the equipment
  cost to purchasing of equipment"). `ScopeSection.valueSource` — SPREAD
  (the default, as before), DECLARED (typed, kept) or CATEGORY with
  `costCategoryIds` (those buckets' cost priced as the sheet prices it:
  cost × contract ÷ total cost, so the buckets together come to the
  contract value) — and `scheduleOfValues()` in `costingMath.ts` (web
  mirror, pinned by verify-costing) is the ONE rule: with the spread on,
  what the declared and cost-priced phases leave is spread over the SPREAD
  ones, exactly, and more than the contract holds is refused at save;
  with it off, only cost-priced phases are worked out. `spreadSections()`
  writes it on every save, the distribute route and a PATCH of the price;
  a bucket on two phases is a 400. On the sheet each phase has a "Value"
  select (Spread / Declared / From cost) with a `TickPicker` of buckets,
  and typing a figure in a spread phase declares it. The preload's
  PLANNING & ENGINEERING takes Materials and Equipment (`valueFrom` codes
  in `SCOPE_PRELOAD`), its purchase tasks being where that money goes.
- **No Opportunity entity.** The requirements treat the opportunity as the lead
  until a quotation exists, so the pipeline is a view over leads + quotations.
  Do not introduce a third record to keep in step.
- **A revision leaves DRAFT and never comes back.** Approved, rejected and
  superseded revisions reject edits at the route. Raise a new revision instead —
  that is what revision control is for.
- **Only one revision per quotation may be APPROVED**; approving supersedes any
  earlier approved one, inside a transaction.
- **A costing marked FINAL rejects edits** except the status change that reopens
  it. An approved quotation and, in Phase 4, a project budget derive from it.
- **`vatRate` is snapshotted onto each revision** so an old revision still prints
  the tax it was issued with after Settings change. Same principle will apply to
  billing in Phase 7.

## Phase 4 notes worth carrying forward

- **`JobScopeItem` is a SNAPSHOT of the costing's `ScopeSection`**, not a
  reference. A costing can be reopened and edited; if progress were measured
  against live costing rows, every reported percentage would shift underneath
  the reports that recorded it. Covered by a test.
- **All cost reaches a job through `JobCostEntry`.** Never edit a stored budget
  total — write a ledger row with a `sourceType`/`sourceId`. Budget Monitoring is
  a view over that table.
- **Available = budgeted − committed − incurred.** CONSUMED is reported but NOT
  subtracted: stock issued to a job was already counted as incurred when it was
  received, and subtracting both charges the same peso twice.
- **Phase 5 writes COMMITTED (approved PR → issued PO), INCURRED (receiving) and
  CONSUMED (stock issuance).** Phase 6 writes INCURRED for posted overtime. The
  columns already exist and are already displayed.
- **Margin is reported as EXPECTED margin**, from the budget. Margin computed
  from spend-so-far reads 100% on a job that has not spent anything, which is
  true and useless. `grossMarginPct` is still returned but only means something
  near completion.
- **A progress report is a chain.** Only one may be open at a time, each carries
  the previous to-date percentages forward, and an approved one cannot be edited.
- **Billing covers only the increment.** It compares the report's to-date
  percentage against the highest already billed per scope line, so re-billing
  the same work is arithmetically impossible rather than merely discouraged.
- **EWT is withheld on the gross, not on the VAT.** Net collectible = gross + VAT
  − EWT. Invoiced ≠ collectible, and A/R must never read the withheld part as
  overdue.
## Phase 5 notes worth carrying forward

- **The two purchase kinds must stay disjoint.** DIRECT_TO_JOB charges the job
  at receiving and does NOT build stock. STOCK_REPLENISHMENT builds stock and
  charges a job only at issuance. Adding a direct-to-job receipt to inventory
  would let the same material be charged twice — a bug that shipped briefly and
  is now covered by a test.
- **Every handover releases what came before.** PR approval commits at estimate
  → PO issue releases that and commits the agreed price → receiving releases
  that and incurs. Use `releaseCommitment()`; it posts a negative row rather
  than deleting, so the ledger stays a history.
- **Moving weighted average**: a receipt recomputes it, an issue takes it as
  given. Issuing must never change the cost of what remains.
- **Borrowing does not charge job cost.** It moves stock out of *available*
  while leaving it owned. Only configure an internal rental rate if Gruntech
  actually charges projects for tool time (model §4.3).
- **The budget guard** blocks a direct-to-job PR that exceeds a category's
  available budget, unless `procurement.blockOverBudget` is set to false in
  Settings. Default on.
- **The S-curve's three lines share a time basis** — billed is plotted against
  the period its progress report covers, not the date the billing was raised.
  Otherwise comparing the lines is meaningless.
- **The S-curve's date scale is labelled by TIME** (2026-10-13, the owner's
  report: the labels overlapped): `curveTicks()` in `web/src/lib/sCurve.ts`,
  DOM-free — the first and last dates always, evenly spaced dates between,
  a label within 56 chart units of another dropped (the last date wins),
  the year added when the span crosses one. Never one label per point:
  progress reports cluster. verify-delivery pins it.

## Phase 6 notes worth carrying forward

- **The descriptor is computed on the server.** `describeFace()` in
  `src/shared/face.ts` takes the photo bytes; the browser posts a picture and
  nothing else. If you ever move that into the page for speed, you have handed
  the client the right to assert who it is. The photo is stored on every clock
  entry, whatever the method — it is the evidence, the match is the convenience.
- **Refuse a photo with more than one face.** Picking the largest is how you
  clock in a colleague who is not there, and such a frame is never retried.
  Covered by a test against the sample group photo. Under the SSD detector
  every demo `sampleN.jpg` is a group (sample2, which the old tiny detector
  read as one face, holds three); verify-hr's single face is the demo's
  `screenshot-webcam.png`, its second person a face cut out of sample6.
- **The face engine is a version string, and two engines' descriptors are
  never compared** (2026-10-10, the owner's report: "sometimes they matched
  other account faces"). `FACE_ENGINE` (`'ssd-l68-level-1'`, defined in
  `shared/faceEngine.ts` — a module importing nothing, so `shared/hr.ts`, the
  seed and every script that only needs the string never load sharp or the
  models — and re-exported by `shared/face.ts`) is stored on every
  `FaceEnrollment.engine` beside its `quality`, and `matchFace()` reads only
  rows of that engine with a readable descriptor (`isUsableSample`, the one
  test for counting, matching and Face health alike); anything else is
  LEGACY — counted, listed, never matched. One photo through the old and the new
  pipeline lands ~0.1 apart (0.3 at worst), a fifth of the threshold. Change
  anything that alters a descriptor — detector, landmark net, working size,
  levelling, retry — and change the string.
- **The pipeline**: SSD MobileNet v1 (minConfidence 0.5), the FULL 68-point
  landmark net and the recognition net, on the image EXIF-turned and fitted
  inside 960×1280, never enlarged. **The eyes are levelled**: at a 3° slope
  or more the frame is turned back and described again, the levelled
  descriptor kept only when exactly one face is found again — face-api crops
  along the landmarks but never rotates, and in the benchmark a tilted head
  was the main road to a wrong-account match. **The contrast retry**
  (`normalise()`) runs once, only when the plain pass found NO face, and only
  for `purpose: 'clock'` — never `'enrol'` (a sample that needs rescuing is
  no sample) nor `'rederive'`; `describeFace(image, { purpose })` throws
  without one. No L2-normalising, no flip-averaging: both measured worse.
  **One face at a time**: the engine is WebAssembly on the API's own thread,
  on a host shared with gasion-vision, so `describeFace` runs one capture
  after another with at most eight waiting, and answers 429 ("The face clock
  is busy …") past that — a dozen at once used to stall every request for
  six seconds; `'rederive'` always waits its turn. On top, `/clock` and
  `/clock/enroll` take twelve attempts a minute per person
  (`shared/throttle.ts`, the password reset's brake, checked before the
  upload is written).
- **Quality is measured, then judged by purpose.** `describeFace` returns
  `quality` (confidence, eye distance in the original's pixels, face
  brightness, yaw, tilt before levelling, `levelled`, `contrastRetry`,
  `frameScale`); `faceQualityProblem(quality, purpose)` answers null or words
  the person can act on at the camera ("Come closer to the camera — …", "It
  is too dark …", "Look straight at the camera."). Enrolment is strict; the
  clock refuses only what makes a descriptor unreliable, because the
  decision's own threshold and margin refuse an uncertain match; `rederive`
  has no gate. The limits carry their benchmark figures in `face.ts` — tune
  them there.
- **The decision is `decideFace()`** (`shared/hr.ts`, pure): a person is as
  near as their nearest CURRENT sample; a face is accepted only when its
  claimed owner is within the threshold (HR Settings, **0.55** default) AND
  leads every colleague by `FACE_MARGIN` (0.05), both edges inclusive.
  Otherwise `not_this_account` (a colleague within the threshold and nearer,
  or the owner not within it), `unsure` (within, but a colleague inside the
  margin) or `not_recognised`. **The words never name the colleague** — "That
  face does not match the one enrolled on this account." — because telling
  the person at the camera whose account a face opens is the leak; the audit
  row's `after` names them, for HR (below).
- **Three samples before the face clock opens, five at most**
  (`MIN_FACE_SAMPLES`, `MAX_FACE_SAMPLES`). A face clock with fewer is
  refused ("Face clock-in needs 3 samples of your face — you have N. …"), the
  fallback staying open; the Clock page stays in enrol mode until three
  (straight, slightly left, slightly right). `/clock/me` sends `faceSamples`
  (current only), `legacySamples`, `samplesNeeded`, `maxSamples`, `enrolled`.
- **A sample must look like its owner and like nobody else.**
  `POST /clock/enroll` takes the strict gate, refuses a sixth current sample,
  refuses one further than threshold + margin from the person's own samples
  (consistency: someone else's face on this account) and one within threshold
  + margin of ANY other active employee's (collision: the fault that let one
  face open two accounts). Only a `ghr.employees.edit_all` holder is told
  whose face it came close to (and, enrolling somebody else, "the samples
  already on <name>'s record"); anyone else is told to use the fallback and
  tell HR. Both refusals are audited (`employee`, REJECTED), the name and the
  distances in `after` only. **Enrolments are decided one at a time**: the
  count, the match and the insert run in one transaction under
  `pg_advisory_xact_lock(hashtext('face_enrollment'))` (the face is described
  before it, so the lock is held for milliseconds) — two first samples sent
  at once used to put two faces on one account, and two at the cap were
  both refused. The photo is filed first and deleted again if no sample is
  written. Consistency is measured against the NEAREST sample on file, so
  Face health also flags an account whose two furthest samples are further
  apart than that (`mixedAccounts`).
- **Every face refusal at the clock is audited, and its capture deleted** —
  too few samples, no face, several faces, an unreadable file, a replay, the
  quality gate and each `decideFace` reason: `attendance` / REJECTED on the
  employee's id, `after.faceRefusal` the key (`FACE_REFUSAL_REASONS`,
  `shared/faceSamples.ts`). **The one-line summary says the reason and
  nothing else** ("Face clock-in refused — Looked like another employee's
  face"); their own distance and the nearest colleague's NAME and distance
  are in `after`, because the refused person reads their own trail on My
  Work (`/my-work` sends `recentActivity` as id, at, action, entityType,
  entityId and summary — never before/after), and `GET /audit/:type/:id` is
  the audit trail's (`admin.audit.view_all`) except a project's history for
  the project readers and a customer's for `gops.customers.view_all`
  (`HISTORY_READERS` in `routes/admin.ts`). The capture is described first,
  so even "too few samples" records whose face it was. The file multer
  wrote is unlinked (`discardCapture`, CAD's `discard()` rule); only an
  accepted capture is kept, its distance in `timeInScore`/`timeOutScore`.
- **A picture sent before is refused (`replay`)**: the upload's bytes equal
  one of the person's sample photos or earlier clock captures (SHA-256,
  compared by size first), or it lands within 0.01 of a sample — two camera
  frames differ by 0.05 and more.
- **A live person is told from a picture of one by a CHALLENGE** (2026-10-10,
  the owner's call: "a printed photo or a phone screen held to the camera
  must not pass"; `shared/liveness.ts`, `faceLiveness` in HR Settings,
  default ON). G-Core has no liveness model: the person does what the ring
  asks — blink once, or turn the head slightly left and right — and the
  server verifies it from a short burst of frames with the 68-point
  landmarks it already runs. `GET /clock/challenge` (behind the clock's own
  twelve-a-minute brake, issued whether or not the setting is on) answers
  `{ challenge, kind, seconds: 2.5, expiresAt }`: the kind is RANDOM, the
  token an HMAC over `userId.kind.issuedAt.nonce` with the JWT secret —
  stateless, the caller's alone, good for 90 seconds and ONCE (a set of
  spent nonces, which a restart forgets; `verifyChallenge` spends it before
  the frames are read). The capture (`POST /clock`, `POST /clock/enroll`)
  carries it as `challenge` beside the still (`photo`) and 8–24 `frames`
  (`MIN_FRAMES`, `captureUpload`); the gate runs AFTER the replay and
  quality gates at the clock, so a refused photo's audit row still says how
  near the face came, and BEFORE the quality gate at enrolment (a photo is
  refused as a photo, not for its light). **The verdict is `livenessVerdict`,
  pure**: fewer than eight readable frames `too_few_frames`; the eye aspect
  ratio AND the yaw both still across every frame (`STILL_EAR_RANGE` /
  `STILL_YAW_RANGE`, 0.02 — identical frames read exactly 0.000, a live face
  jitters by 0.03) `not_live`; a blink is the lowest EAR under `BLINK_RATIO`
  (0.7) of the median with the eyes seen open two frames before and two
  after — the ratio is PHYSIOLOGY, not the fixture: an open eye sits at
  0.25–0.35 and a closed one under 0.15 (Soukupová & Čech, 2016), so a blink
  halves it; a turn is the yaw swinging `TURN_RANGE` (0.1) with both sides of
  the median reached — the figure comes from the FORESHORTENING fixture
  (one half of the face squashed to 60%, what a turned head looks like to
  the camera, swings the yaw by 0.18; real people in the enrolment benchmark
  turned to 0.28). `checkLiveness` measures each frame through the landmark
  net ALONE on the still's face box padded by `CROP_PADDING` (0.2 —
  measured: at 35% the net loses the turn, at 0–10% the alignment runs off
  the crop), and describes the FIRST and LAST usable frames: a face more
  than `SAME_FACE_DISTANCE` (0.5) from the still's at either end is
  `not_live` — a photo swapped for a face mid-burst (a stranger pasted over
  the frame reads 0.80; the still itself 0.13). The frames are NEVER kept
  (`discardCapture`); every refusal is audited as `liveness` with
  `after.liveness.{kind, reason, frames, usable, sameFace, ms}` (reason
  `missing` when no challenge or no frames came, `challenge` when the token
  was refused) and the words are `LIVENESS_MESSAGES` / `CHALLENGE_MESSAGES`
  ("No blink was seen — blink once, clearly, while the ring runs.", "That
  liveness check was already used", "Not your liveness check"). Face health
  counts them. **The accepted limit**: a VIDEO of the person performing the
  movement, played to the camera, can pass — the random challenge makes a
  prepared one unlikely to match, not impossible; the kept still is what HR
  checks a doubtful entry against. **The fixtures are
  `scripts/lib/faceFixtures.ts`** (sharp only): `turnFrames` is the one that
  passes; `shearFrames` (the nose pushed off the eye line) and `eyesShut`
  (skin-toned patches over the eyes) are NEGATIVE fixtures BY DESIGN — the
  net regularises the nose onto the faces it knows (±0.18 of shear reads as
  0.02–0.04 of yaw) and places the eye points where an eye should be
  (painted lids drop the EAR by 8–18%), so neither passes, and verify-hr
  asserts the refusal; a passing blink cannot be built from a still, which
  is the point. verify-hr switches the setting off for the face checks that
  are not about it (`hr.rules.__verify__`), and its challenges are issued in
  the script with the same secret, since each ask at the route is one of
  the person's twelve knocks.
- **The owner's three decisions of 2026-10-10 on the face clock**: (1) face
  SAMPLES are readable only by the person and HR with
  `ghr.employees.edit_all`, and a supervisor sees their DIRECT REPORTS' clock
  captures only — never another team's; (2) the liveness check was wanted
  and is built (above); (3) the 0.55 threshold is to be RE-CHECKED against
  Face health after a month of real use — not tuned on the benchmark again.
- **The entry is claimed before its photo is filed**: IN writes a new day's
  row (`createMany … skipDuplicates`) or claims one with no time in, OUT
  claims the row with no time out (`updateMany`); the capture is saved only
  once that stands, so the losing tap of a double tap keeps nothing. A
  fallback's reason is kept at both ends of the day — `notes` the
  clock-in's, `Attendance.timeOutNotes` the clock-out's — and the register
  shows each beside its punch.
- **Samples have routes of their own**, above any `/:id`:
  `GET /clock/enrollments?employeeId=`, `DELETE /clock/enrollments/:id` and
  `DELETE /clock/enrollments?employeeId=` (start over) — the person, or HR
  with `ghr.employees.edit_all` (not `view_all`: finance holds that for
  labour rates), audited, the photo going with its sample.
  `GET /clock/face-health` (`ghr.settings.view_all`) is HR Settings' Face
  health panel: who is ready, partly enrolled, legacy-only or not enrolled
  (and the legacy-only by name, `unprotected` — the clock cannot refuse a
  colleague enrolling their face until they add new samples), pairs of
  people within threshold + 0.10 (closest first, 20 at most), samples unlike
  their owner's others, `mixedAccounts`, 30 days of refusals by reason, and
  the latest 20 refusals one by one (`recentRefusals`, clock and enrolment)
  with whose face each came near — the only screen that names them. The
  screens are the Clock page's "Your face samples", the employee record's
  Face samples tab (`edit_all`) and that panel, whose links to that tab show
  only for `edit_all` (an executive reads the panel, not the tab).
- **Face photos have attachment guards.** `face_enrollment` (a sample's
  photo) is read by the employee's own login, `ghr.employees.edit_all` or a
  super admin; `attendance` (a clock capture) by the employee,
  `ghr.employees.edit_all`, `ghr.attendance.view_all`, a super admin, and a
  `ghr.dashboard.view_all` holder for their OWN direct reports only
  (`captureReader()` in `routes/hr.ts` — the register sends a photo's id
  only where it would open). A `write` guard refuses both on the generic
  attachment routes for everyone, super admins included — a sample's photo
  leaves with its sample, a capture is evidence. Deleting an employee
  deletes both kinds of photo.
- **An account photo is never a face sample's photo.** Every account photo
  is read by everyone signed in, and a sample's own bytes posted back to the
  clock used to clock its owner in at distance 0. An enrolment gives the
  person a picture CUT from the capture — the face, square, at 96 px
  (`accountPhotoFrom()` in `face.ts`; SSD finds no face in it, even blown
  back up) — filed as a `user` attachment captioned with its sample's id
  (`setAccountPhotoFromSample()`); removing or resetting that sample clears
  the picture (`dropAccountPhotoFromSamples()`). At boot,
  `separateAccountPhotos()` gives every account still pointing at a sample's
  capture a picture of its own (idempotent, audited once).
- **A sample's photo is never deleted to make room for an account photo.**
  Enrolling, and uploading or removing a photo on My Account, go through
  `setAccountPhoto()` / `deletePhotoIfUnused()`, which keep any attachment
  that is a sample's `photoPath` or anybody's account photo. Until
  2026-10-10 each enrolment deleted the previous account photo — usually the
  previous sample's — and so did every change of account photo.
- **Legacy samples are re-derived at boot, where their photo survives.**
  `rederiveFaceSamples()` runs after `warmUpFaceModels()` in `index.ts`,
  never awaited and never fatal: each legacy row whose photo file still exists
  is described again (`'rederive'`), CLAIMED with a conditional `updateMany`
  on the engine AND the quality it was read with (two processes never both
  write it, a failure or a success) and stored with the current engine and
  its quality, one audit row per run that changed anything. A photo with no
  face or several records `{ rederiveFailed, engine }` and is not retried
  under that engine — and so does one that comes out within threshold +
  margin of ANOTHER employee's current samples (the reason names nobody):
  enrolment refuses that collision, and re-derivation must not let it in by
  the back door. A missing file leaves the row as it is. **Most old samples cannot be re-derived**:
  the old Clock page stopped after one sample, and the photo deletion above
  took every earlier sample's photo (and the last one's at the next change of
  account photo). So nearly everybody has at most one current sample after
  the upgrade, and the Clock page asks for the rest ("Face recognition was
  upgraded — add N new samples to use it again").
- **The threshold moved from 0.6 to 0.55 once.** `migrateFaceThreshold()`
  (`shared/faceSamples.ts`, called by the seed on every deploy) rewrites a
  STORED 0.6 — face-api's default, written by every seed — to 0.55, marked
  by the `seed.faceEngineMigrated` setting and audited. Any other stored
  value is an administrator's choice and stays, as does 0.6 set again
  afterwards. Lower is stricter.
- **Prior approval moves no money.** `overtime_prior` settles to
  `PRIOR_APPROVED` and writes nothing to the ledger. Only `overtime_request` —
  the actual filing, through the seeded two-step supervisor → HR workflow —
  posts INCURRED, and at the ACTUAL hours, never the estimate.
- **A leave balance is spent on approval, not on filing.** Pending days are
  reported separately (`remainingAfterPending`) so nobody over-commits, and
  cancelling an approved request gives the days back. Filing must never be able
  to cost somebody an entitlement.
- **Absence is derived, never stored.** The dashboard infers it from active
  employees with no attendance row and no approved leave. A nightly job writing
  absence rows would be wrong the moment someone clocked in late.
- **A fallback always carries a written reason.** The fallback is the weak door;
  an unexplained one is all an audit would have to go on.
- **Overtime's job lookup is `/overtime/chargeable`, not `/jobs/lookup`.**
  Naming the job you worked on is not the same right as project-management
  access. It returns numbers and names only. Note the route order — it must sit
  above `/:id` or the `:id` route swallows it.
- **Burdened, never the wage.** A project is charged
  `dailyRate × burden ÷ hoursPerDay × premium`. Nobody sees a colleague's salary
  on a project screen; `ghr.employee_rates.view_all` gates the rate itself.
- **The Sales strip is the sales flow** (2026-10-08, the owner's call):
  Sales Pipeline, Forecast, Leads, Quotations, Sales Orders, Customers,
  Partners, Calendar — the registry's order, pinned by verify-foundation like
  Project Management's.
- **The menu highlights the longest matching path.** A module dashboard lives at
  the module root (`/g-hr`, `/g-chain`), so a plain prefix test lights it up on
  every screen in that module. `Shell.tsx` picks the most specific match.

## Phase 7 notes worth carrying forward

- **Outstanding is measured against NET COLLECTIBLE, never the invoice total.**
  `settleable()` and `refreshSettlement()` in `src/shared/finance.ts` are the
  only places that decide it. An invoice paid to its net collectible is PAID;
  measuring against the invoice total would leave every customer permanently
  short by the withheld EWT and make them all look like late payers.
- **EWT is withheld on the gross, not on the VAT** — on both sides. Same rule as
  Phase 4's billing, in the other direction for supplier bills.
- **A supplier bill matched to a receiving posts NO job cost.** The receiving
  already incurred it (Phase 5); posting again charges the project twice.
  `bill.receivingId !== null` is the whole test. A bill with nothing received
  behind it — subcontract certificate, service call, utility — is the first time
  that cost appears, so that one does post, at the SUBTOTAL because input VAT is
  recoverable. Covered by a test that asserts exactly one of two bills reaches
  the ledger.
- **A payment must be fully allocated, and cannot over-apply.** Every allocation
  is checked against `outstanding` before anything is written. Settled totals are
  RE-DERIVED from the allocation rows, never incremented, so deleting a payment
  cannot leave a stale balance behind.
- **Cleared money only.** Cash-flow actuals count payments with a `clearedAt`. A
  cheque is recorded on the day it is written and stays uncleared until somebody
  says otherwise — a position that counts promises is the one that bounces.
- **An invoice is raised FROM a billing and carries its figures.** Both rates,
  both tax amounts and the line breakdown are copied, never recomputed, so an
  invoice raised months later still prints the tax the work was billed under.
  `progressBillingId` is unique, which is what makes double-invoicing impossible
  rather than merely discouraged.
- **The supplier-bill workflow must not route to finance.** Finance receives the
  supplier's invoice, so finance raises it — the third seeded workflow to ship
  with that fault. `audit-workflows.ts` now knows the typical requester for it.
- **Finance owns its own rules** (`gfin.settings`), the same way HR owns the
  working day. Payment terms, supplier withholding and the aging buckets live
  there; VAT and EWT stay on the company record because they print on documents
  from three other modules.

## Phase 8 notes worth carrying forward

- **A service contract IS a job of type SERVICE_CONTRACT** (model §4.5). Its
  costing, budget, schedule of values and progress billing are the Phase 3/4
  machinery unchanged. `ServiceContract` is a 1:1 extension carrying only what a
  job cannot: what is covered, how often, and until when. Do not give it a
  second commercial record to drift out of step.
- **Service Costing is the costing list narrowed to service jobs**, via
  `?jobType=SERVICE_CONTRACT`. A service costing is a costing whose job happens
  to be a contract — it is not a different table. Its menu entry is `hidden`
  since 2026-10-10 (C3 of the review), as are "Employee Pay Rates" (the
  Employees screen) and "Document Templates" (the Report Templates screen):
  three labels that opened a screen another label already opened. The
  routes, the permission keys and the links stay; verify-foundation lists
  the hidden entries.
- **The first PM visit falls one interval AFTER cover starts**, not on day one;
  a visit that would fall past the end date is dropped, not clamped. `addMonths`
  clamps to the month end, so three months after 31 January is 30 April.
- **Regenerating a schedule only rewrites SCHEDULED and CANCELLED visits.**
  COMPLETED and MISSED ones are a record of what happened and must survive.
- **A template that has been used is immutable.** Editing publishes a new
  version under the same key and flips `isCurrent`; reports keep pointing at the
  exact version row they were filled in on. That is the only reason an old
  report still renders the way it was signed.
- **A visit completes when its REPORT is approved**, not when the engineer
  leaves site — otherwise the schedule counts visits nobody has checked. A
  rejected report leaves its visit open.
- **Warranty is a fact, not a tick box.** `underWarranty` is decided from the
  asset's dates against the date the work was done, at the moment the report is
  created. A commissioning report is what starts a warranty running.
- **A report cannot be submitted half-filled or unsigned**, but saves as a draft
  freely — it is written on site, often on bad signal, and a form that refuses to
  save gets filled in afterwards from memory instead.
- **Expiry and missed visits are swept on read**, in `sweepOverdue()`, called
  when the aftermarket screens load. G-Core has no scheduler (its one timer
  sends calendar reminders — see "Sales: board, calendar, costing"), and a
  status that is only correct when a cron job ran is worse than one derived on
  read.
- **The renewal pipeline has two sources**: contracts ending, and warranties
  lapsing on equipment with no active contract. The second is the one nobody
  sees and usually the larger opportunity.
- **The three report menus are one screen.** Commissioning, PM and Inspection
  are `kind` filters over `ServiceReport`; what differs between them lives in
  the template, which is data.

## Phase 9 notes worth carrying forward

- **Insights adds NO tables, and must never acquire one.** Every figure is read
  off documents the other phases record. The moment a report keeps its own copy
  of a number, it gains the ability to disagree with the document behind it —
  which is the whole failure mode this layer exists to avoid. The router ends
  with a middleware that refuses any non-GET request, and there is a test for it.
- **Where a report disagrees with a module screen, the report is wrong.**
  `verify-insights.ts` asserts profitability against the ledger read directly,
  and the company overview against the sales report. Add a reconciliation
  assertion whenever you add a figure that also appears somewhere else.
- **A quotation's value is its latest APPROVED revision, else its latest** —
  `quotationValue()` in `shared/pipeline.ts`, and nothing else. The overview
  briefly counted only approved ones and showed an open quotation as worth
  nothing while Sales Analytics showed its real value. Two screens disagreeing
  is the bug this module is most prone to; there used to be five inline copies
  of this rule.
- **Say when a number is not yet meaningful.** `tooEarly` flags a job that has
  spent under 20% of its budget, because its running margin is ~100% and that is
  true and useless. Screens lead with EXPECTED margin, which comes from the
  budget and means something on day one.
- **Slow-moving stock ranks by VALUE, not age.** A thousand idle washers matter
  less than one idle compressor, and sorting by age buries the compressor.
- **The cash forecast counts what is waiting on US** — approved billings nobody
  invoiced, and issued purchase orders nobody has billed us for. A forecast
  built only from invoices flatters the position on both sides.
- **Performance is about output, never attendance.** Lateness and leave stay in
  G-HR behind HR's permissions. Aggregating them into a management league table
  would turn a payroll record into a surveillance tool without anybody deciding
  to. The approval-bottleneck view is the useful half anyway.
- **Every report has a `.csv` twin, and the export is audited before the bytes
  go out.** An export that failed to be logged should not have happened.
- **Each role gets the cross-cutting view its job needs**; only `executive` sees
  all of them, because Insights aggregates margin.

## Phase 10 notes worth carrying forward

Phase 10 added depth to every division rather than a new one. The rules below
are grouped by area; the model doc carries the business version (§4.1, §4.5,
§4.6, §4.7, §7, §13).

### Shared seams

- **Manila calendar keys live in `shared/day.ts`** (`manilaDayKey`,
  `manilaMonthKey`). Deep links and forecast columns bucket on these, never on
  the host clock, because the server's clock is not the business's day.
  Numbering keeps its local-getter `{YYYY}`/`{MM}`.
- **The work week is Mon–Sat** (2026-10-13, the owner's call): Sunday is
  the one day off (`DAY_OFF`, `isWorkingDow()` in `shared/day.ts`), for the
  costing's plan, a project's dates, "Plan from costing" and a job order's
  working days alike — `workingDaysBetween()` and `workingDayDate()` read it,
  and `web/src/lib/day.ts` mirrors them on day keys (`workingDaysBetween`,
  `workingDayKey`), pinned equal on every start in a month by verify-costing.
  No holidays yet. Leave days (`leaveDays()` in `shared/hr.ts`) are HR's
  own rule and still skip both weekend days. The project Gantt shades
  Sunday alone (`.gantt-day.is-off`).
- **A project's dates tally with its scope** (2026-10-13): `createJobRecord()`
  places each scope item on the costing's own plan (`scopeDates()` in
  `routes/jobs.ts` — `planTasks` put on working days from the start, both
  ends inclusive; an unplanned phase sits on the day the phase before it
  ends; a costing with no plan at all gives each phase one working day) and
  takes the plan's last day as `targetEndDate` when none is given; POST
  /jobs starts on the costing's `plannedStart` when the form names none,
  and the form's hint names the finish. A target typed by hand is kept:
  `GET /jobs/:id` sends `schedule` (`scheduleTally()`: `planFinish`,
  `planDays`, `targetDays`, working days from the start) and the overview's
  Schedule card shows both, saying where they differ.
- **Today, for a DATE column, is `manilaDate(new Date())`** (`shared/day.ts`).
  Until 08:00 in Manila the UTC date is still yesterday's, and it arrives
  unasked three ways: `getUTC*`; a bare `new Date()` written into, or compared
  with, a `@db.Date` column (Prisma binds it as a DATE and drops the time); and
  a DATE column's `@default(now())`, which the database evaluates in UTC — so a
  route sets that column itself. **`dayKey()`, `daysBetween()` and
  `addDays()` live once, in `shared/day.ts`** (2026-10-10): `dayKey` IS
  `manilaDate()`, and finance, aftermarket, insights and HR re-export it —
  HR's own copy read the server clock, which is not the business's day. A stored
  DATE or a parsed `'YYYY-MM-DD'` is UTC midnight, 08:00 in Manila, and comes
  back unchanged. A DATE compared in JavaScript is compared with that day, never
  with the instant — a borrow slip once flagged itself overdue at 08:00 on the
  day it was due. `docs/notes/day-boundaries.md` has the audit.
- **"Today" in My Work is a timestamp window**, local midnight to the next, not
  `dayKey()`. `dayKey()` is a key for `@db.Date` columns (UTC midnight of the
  local date) and would put the boundary at 08:00 Manila. A provider comparing a
  DATE column to that window asks for a padded range and filters in code, because
  comparing a DATE to a timestamp truncates the edges.
- **`registerSchedule(fn)` in `routes/workspace.ts` is the seam for "today"**;
  Meetings, the Academy and the Service Schedule register from their own
  modules. The `/my-work` row contract is `{ id, kind, title, subtitle?, when?,
  overdue?, link }` with `link` starting `/` — a new source of work adds a query
  and a mapper, never a new section shape.
- **"My team" is `teamOf(userId)` / `teamMembers(teamId)` in `shared/team.ts`**
  (2026-10-08): the Industry row on the viewer's employee record, nothing
  else — a login with no employee, or an employee with no team, has none.
  `listQuery` parses `scope=team`; `quotationListWhere`, `leadListWhere` and
  `salesOrderListWhere` take the team id and narrow to its members' records
  (`owner` / `assignedTo`), and their summaries carry `team: { count, value
  }` — the team's share of the set for the "My team" card — and `margin` only
  where the caller may see every listed record's cost (edit-all, costing
  rights, own-scope, or the set is their own): `revisionsMargin()` sums the
  rows' own margins through one GROUP BY, never a figure a row would not
  show. `/auth/me` sends `user.team`.
- **Search providers may declare `permission: string[]` and `ownWhere(user)`**;
  own-scope narrowing applies only when the caller holds none of the provider's
  non-`view_own` keys. A provider without it shows every record to a `view_own`
  holder.
- **`GET /users/lookup?q=&holding=` is the people picker** — authenticated only,
  names only, declared above `/:id`. Never feed a picker from the admin-gated
  `/users`; the salesperson or engineer using the form cannot read it.
  `/employees/lookup` answers at most 50 rows — a picker that needs everyone adds
  a search box, as the Academy's does.
- **HR lists are Settings, whitelisted by route**: `GET/PUT
  /hr-settings/lists/:key` for `hr.clearanceChecklist` and
  `hr.evaluationCriteria`, each with its own zod row schema. A screen renders
  settings from the merged `GET /hr-settings`, never the raw row, because the
  seed's `update: {}` means an existing install has none of the newer keys
  stored. A settings card PUTs only the keys it edits — sending the whole object
  it loaded writes stale keys back over another card's save.
- **`redact()` strips `dailyRate, burdenMultiplier, sssNo, philhealthNo,
  pagibigNo, tin`.** Anything that audits an employee goes through it.
- **A `recordLink()` of null prints text, never a link** — a link that lands on
  "No screen at this address" is worse than none. An entityId of `list` (the
  printed lists' EXPORTED audit rows) opens the list itself, never a record
  page that would ask the API for a record called "list" (found by the link
  crawl of 2026-10-10; verify-foundation pins it).
- **`openAttachment()` in `components/Attachments.tsx` is the one way to open a
  stored file** outside the Attachments card (bearer token → blob; a
  spreadsheet opens the viewer, see "Spreadsheet attachments"). The
  attachment routes check authentication only, not per-record visibility — an
  open owner decision (model §14), not something to paper over per screen.
- **The deploy scripts seed after `prisma generate`**, not straight after
  `db push`: the seed runs through the generated client, and that is the first
  point where the client matches the schema.
- **The seed's numbering loop creates with `dt.defaults ?? STOCK_NUMBERING` but
  updates only `{ label }`**, so an administrator's pattern is never
  overwritten. Industries are seeded like cost categories (`isSystem`). The
  new `trainer` role and every Phase 10 role/permission pair reach existing
  installs through the never-offered rule above.
- **`audit-workflows.ts` knows the typical requester** of `cash_advance`,
  `job_order`, `clearance`, `evaluation` and `training_certification`, and also
  reports an HR step on a document HR sometimes raises while only one person
  holds `hr` — the HR-typed version of the single-holder fault.
- **Cancelling a document withdraws its request through `cancelOpenRequest`**
  (2026-10-02): leave, overtime (whichever of `overtime_prior` and
  `overtime_request` is open), clearance, evaluation, expense claim, cash
  advance, budget request and sales order, each passing `cancelled by <name>[: <reason typed>]` and the
  canceller's id. The routes used to set the request CANCELLED by hand, which
  told nobody and audited nothing on it. Now the open step's approvers are
  told, and the requester too when somebody else cancelled (a clearance's
  leaver, when HR cancels it). **Both CANCELLED audit rows are kept**: the
  engine's names the step and the reason, the module's is the document's own
  — the pairing submission already makes — so a cancelled draft leaves one
  row and a cancelled pending document two. The engine files under the
  approval's type: an expense claim's withdrawal is under `expense` (its own
  row under `expense_claim`), a prior approval's under `overtime_prior`.
  **A decision that lands after a cancel changes nothing.** The withdrawal
  only covers a cancel that wins the race; a final decision committed a
  moment before reaches the subscriber after the document reads CANCELLED. So
  every cancellable document's subscriber applies its outcome only while the
  document is still pending — leave (`PENDING_APPROVAL`), overtime (`PRIOR`,
  then `ACTUAL_FILED`) and clearance (`PENDING_APPROVAL`) claim it with a
  conditional `updateMany`, as the quotation does, and expense, advance and
  evaluation check the status first — and otherwise write "… after it was
  cancelled — not applied" to the trail. Unguarded, a cancelled leave came
  back APPROVED and drew its days, cancelled overtime posted its cost, and a
  cancelled clearance closed the leaver's login.
- **Employee routes live in `routes/employees.ts`, the employee import in
  `routes/imports/employees.ts`.** `imports.ts` exports `Registered`, so a module
  (the Academy's `courseImport`) is wired into `REGISTRY` with one line.
- **A paper is saved under ONE name** (2026-10-12, the owner's call: "a
  standard file name — document numbering, author, document's date";
  `docs/notes/P-paper-names-and-chips-2026-10-12.md`):
  `<Kind> <Number> R<n> - <Author> - <YYYY-MM-DD>.pdf` ("Quotation
  0062602018 R0 - Carter Gasiong - 2026-10-08.pdf"), `paperFileName()` in
  `shared/paperName.ts`, pure — the author is who prepared the document
  (the owner, requester, filer: the paper's first sign-off), the date the
  document's own on the Manila day; a list paper (`sendListPdf`) is its
  kind, who printed it and today. Refused characters become "-", a missing
  part drops out, `contentDisposition()` sends an ASCII `filename` and the
  exact name in `filename*`. Every PDF route names its file through them;
  never write a `Content-Disposition` for a PDF by hand. CSV and `.ics`
  names are unchanged.
- **The name reaches the browser through a PRINT TICKET**
  (`shared/printTickets.ts`): `openPdf()` opened a nameless `blob:` URL,
  so Save as offered a random id. Now it opens a tab inside the click,
  asks `POST /api/pdf/tickets { path }` (a paper's address only: a `/pdf`
  or `.pdf` path under /api) and points the tab at `path?ticket=…`.
  The ticket is the liveness challenge's design — an HMAC with the JWT
  secret over `userId.path.issuedAt.nonce`, two minutes, spent at its
  first use (a map of spent nonces) and reopened only within
  `TICKET_REUSE_MS` (a minute) after it — 2026-10-13, a user's report: the
  WPS PDF extension fetches the tab's paper a second time itself and read
  "Document Loading Failure" off a one-use ticket — the path compared in one spelling (`ticketPath()`, the
  `ticket` parameter taken out). `authenticate` takes it in place of a
  bearer on a GET of exactly that path, then every guard and audit row
  runs as for a bearer; a second router under the same prefix keeps the
  user the ticket resolved. Reused, expired, another path, another login
  or a non-GET is a 401, and `errorMiddleware` answers a ticketed GET with
  a small page saying why, never JSON. Reloading such a tab after the
  minute is refused (the ticket is spent): print again from G-CORE.
- **Shared web pieces from Phase 10**: `PeoplePicker` (pure UI over
  `{ id, name, sub?, group? }[]`), `MeetLink`, `SettingListCard` (the
  `/hr-settings/lists/:key` editor), `RecordHeader`'s `statusExtra`,
  `openPdf(fullPath, onError)` and `downloadBlob(apiPath, filename)` in
  `lib/api.ts` — the ONLY way a screen opens or saves a file (five hand-rolled
  copies went on 2026-10-10; a refusal shows the server's own reason). One
  copy of each small helper: `toLocalInput` and `daysBetween` in `lib/day.ts`;
  `formatTime` (en-PH; `{ hour12, seconds }` for the clock and the attendance
  table), `formatSpan` (a start and an end as one phrase), `durationLabel`
  (SCORO's "1h 30min") and `initials` (the Avatar's two letters) beside
  `formatDate` in `components/ui.tsx`; `CostPanel` typed once in
  `lib/quotationMath.ts`. Admin › Categories is one `CategorySpec` per
  reference list in `masters/Reference.tsx` — a new list is a spec and one
  line, never an eighth modal. A package's own styles go in one file under
  `web/src/styles/`, imported from `main.tsx` after `styles.css`, tokens only.

### Numbering

- **An OWNER-scoped counter keys its rows `2026-09@007`**; the template row is
  `periodKey ''`. `{EMP}` is the last run of digits in the employee number padded
  to three, `000` for an unlinked login; `Employee.employeeNo` wins over
  `User.employeeNo`.
- **An existing database keeps its configured pattern.** The seed only creates a
  missing template; `PUT /numbering/:type` is the only thing that changes one. A
  dev database older than the house scheme still issues `GT-QT-…` until an
  administrator sets the quotation pattern once — verify scripts use throwaway
  types so they pass either way.
- **Changing period or scope starts a fresh run and keeps the old counters.**
  Rows keyed for a period the type no longer uses stop being matched; they are
  the record of what was issued, so never "clean them up".
- **Three collision rules are enforced when a pattern is saved** (zod issues on
  `pattern`): per employee needs `{EMP}`, monthly needs `{MM}` and a year,
  yearly needs a year. `nextNumber` refuses the first again at issue time; the
  other two it cannot tell from a deliberate choice, so the PUT is the only
  guard.
- **"Issued this period" is a sum** — `issuedThisPeriod()` in `routes/admin.ts`
  adds the current key and every `<current>@<emp>` row. The screen's figure must
  equal it; `verify-numbering.ts` asserts it for every type.
- **Samples on Admin › Numbering carry the viewer's own `{EMP}` digits**, and a
  template that cannot issue shows a `problem` instead of failing the screen —
  the administrator is the one who can fix it.
- **The quotation count runs through the YEAR and restarts each January**, as
  SCORO's did (`0012609059` is employee 001's 59th quotation of 2026); the month
  is printed, never counted. The seed's default is `{EMP}{YY}{MM}{SEQ}`, YEAR,
  OWNER — an installation seeded before that keeps MONTH until an administrator
  changes it in Admin › Numbering.
- **A counter is never lowered by a seed.** The counters the past SCORO
  imports raised (`<YYYY>@<code>`, keyed per CODE, so a number issued under a
  colleague's code stays unissuable) stay raised after the archive's removal
  (2026-10-10); only ever raising a counter is what keeps a number from being
  issued twice.

### Masters and partners

- **Industry is the TEAM master, a reference row like `CostCategory`**
  (2026-10-08, the owner's call: "there will be KAT, HIT, UIT, GIB and
  SIT"). `TEAMS` in `shared/team.ts` seeds the five as `isSystem` rows —
  Key Account Team, Healthcare Industry Team, Utility Industry Team,
  General Industry & Building Team, Special Industry Team — undeletable and
  never recoded, because the quotation list's "Quotes by team" and the Team
  view key on them. The first five industries (HI, BI, UI, GI, SI) were the
  teams' first names: `retireFirstIndustries()` moves their people (and the
  customers still carrying one) to the successor — HI→HIT, UI→UIT, GI and
  BI→GIB, SI→SIT — and switches the old rows off, never deleting them;
  once, marked in the `seed.teamsMigrated` setting so a row an
  administrator turns back on stays on. Admin › Categories calls the card
  **Teams** (people, not customers, in its count); the routes stay
  `/reference/industries`, the audit type `industry`.
- **A customer has an ADDRESS of its own, and it is what a quotation
  prints** (2026-10-11, the owner's call: "this is the default on
  quotation shown; site can be selected if needed"). `Customer.address`
  (free text, the customer form and Customer 360, the import's `Address`
  column — else its Site Address and Site City joined; a blank cell never
  clears one). `documentAddress(customer, site?)` in
  `shared/customerAddress.ts` is the one rule: the site's address and
  city when the document names a site, else the customer's address — the
  quotation's and the sales order's `customer.address` field both read it.
  The editor's "Address" row shows the customer's address, and offers
  "Site: …" only where the customer has sites, the hint saying what will
  print. `backfillCustomerAddresses()` (the seed, once, marked by
  `seed.customerAddressBackfilled`) gave every customer with none its
  first active site's address, so a quotation printed before prints the
  same.
- **A customer carries no industry any more — a SUB-INDUSTRY, optional**
  (2026-10-08, the owner's call: "remove the customer industry; later they
  manually input which sub-industry the customer falls on"). `SubIndustry`
  (`shared/subIndustries.ts`: `SUB_INDUSTRIES`, **the owner's twenty-six
  since 2026-10-09** — Commercial Building and Land Development, Aerospace,
  Agriculture … Water Utilities, in his order, replacing the eleven of the
  day before: `RENAMED` moves Hospital → Healthcare and Building →
  Commercial Building and Land Development in place, keeping the row and
  its customers, and `RETIRED` switches the other seven off, never deleting
  them — seeded as `isSystem` rows, case-blind one per spelling;
  `/reference/sub-industries`, `admin.categories.*` to change, anyone
  signed in to read) is `Customer.subIndustryId`, nullable: the form offers
  "— not stated —", a blank import cell is none, the quick-adds (the lead
  form, `CustomerPicker`, the installed-base register) file a customer by
  name alone. **A customer also has a TEAM, open until somebody sets it**
  (2026-10-09, the owner's call: "a Team who will handle the Customer
  (KAT, UIT, HIT, SIT, GIB) … later user will categorize"): `Customer.
  industryId` is the Industry (team) master again, nullable, written by
  `POST`/`PATCH /customers` (`activeTeam()` refuses an inactive one), the
  form's "Team" select ("— open —"), the list's Team column (code, "Open"
  while none) and `?team=` filter (an id or `none`), a Team column on
  the printed list (`GET /customers/pdf`), the mass action
  **Set team** beside Set sub-industry (the same `PATCH` per row), and
  Customer 360's Company card. Nothing classifies a customer automatically — the owner
  asked for an online classification where possible, and it is not
  possible from the app, so both fields stay open for hand editing.
  Reclassifying never regenerates the customer code — identifiers do
  not move under the quotations and invoices that print them. A lead's
  sub-industry is its customer's; do not add one to Lead, it would be a
  second copy that drifts. Sales Analytics' "By industry" is **"By
  sub-industry"** (`subIndustries` rows keyed by id, Unclassified last; the
  CSV's appended column is `Sub-industry`), the customer search hit names
  it, the printed customer list prints it.
- **A partner IS a supplier with `isPartner`**, set and cleared only through
  `/api/partners` so "who made this a partner" is audited in one place.
  Removing a partner keeps the supplier and its resources; `DELETE
  /suppliers/:id` refuses while `isPartner` is true, because the cascade would
  drop catalogues G-CHAIN never shows.
- **Partner links are http(s) only** (`safeHttpUrl()` on the server, and the
  client only ever turns an http(s) string into an `href`). That is what keeps
  `javascript:` out of a link a salesperson clicks.
- **The price list is prices, never costs.** `partnerPriceList()` uses a strict
  `select`, never `include`, and `verify-partners.ts` asserts the response bytes
  contain neither `standardCost` nor `lastCost`. Switching to `include`
  reintroduces the leak.
- **Customer 360 and Supplier 360 are a window, never a way around.** Each
  collection loads only when the caller holds the list permission of the screen
  it comes from, and arrives as `[]` otherwise. Add a collection the same way —
  never unconditionally.
- **The customer list is the quotation list's layout** (2026-10-08): the
  sub-industry as a filter (`?subIndustry=`, an id or `none`; the counts and
  names come as `summary.tabs` / `tabCounts` — every active sub-industry,
  an inactive one still holding a customer, and "Not stated" only while
  somebody is — from `customerListSummary()`), summary cards (customers,
  inactive). Filters:
  status, added by, Added (Manila days), Open quotation (one OPEN /
  SUBMITTED / NEGOTIATION) and Project; Code, Sub-industry, Open quotes and
  Projects columns; the printed list `GET /customers/pdf` (above `/:id`,
  audited, no credit limits); `customerListWhere()` feeds rows, summary and
  paper. The master is shared, so the list opens on **All for everyone** —
  Mine is "customers I added". Mass actions (for `gops.customers.edit_all`):
  Set sub-industry and Active / Inactive, each the ordinary
  `PATCH /customers/:id` per row — the code never moves with the
  sub-industry, and an inactive sub-industry is refused by the PATCH.
  Import moved into the ⋯ menu.
- **The partner list is the quotation list's layout** (2026-10-08): "What
  they supply" as a filter (`?category=`) whose choices are every category
  on file under the other filters, matched **trimmed and case-blind**
  (`equals`, insensitive), the first spelling naming it, and "Not stated"
  while any partner has none (`partnerListSummary()` sends `summary.tabs`,
  which the screen's `onSummary` turns into the filter's choices and the
  bulk box's suggestions). Inner spaces are NOT folded: the filter cannot
  fold them, and a choice must show exactly what its count says
  (verify-partners asserts it for every one). The rule is
  `categoryTabs()` / `categoryTabWhere()` in `shared/supplierCategories.ts`,
  shared with the supplier list — partners and suppliers are one record. Filters: status,
  Publishes (a catalogue / price list / software / links), Priced items,
  Partner since (a DATE); the summary cards count partners, those publishing
  a price list and priced items; `GET /partners/pdf` (above `/:id`, counts only —
  never a price or a cost; audited) and Print selected. The master is
  shared, so All for everyone. Mass action (`gops.partners.edit_all`): Set
  what they supply — the ordinary `PATCH /partners/:id` per row, the box
  suggesting the categories on file; clearing one is done on the partner's
  own page, never in bulk. Import moved into the ⋯ menu.
- **The supplier list is the same layout** (2026-10-08): the same "What
  they supply" filter (`categoryTabs()`), Filters (status, Partner, added by,
  Added — Manila days — and Purchase orders: awaiting delivery / ordered
  from / never), Orders and Awaiting columns, summary cards (suppliers,
  Sales partners, inactive, with an order awaiting delivery), `GET
  /suppliers/pdf` (above `/:id`, no TIN, audited, `?ids=`) and mass actions
  for `gchain.suppliers.edit_all` — Set what they supply and Active /
  Inactive, each the ordinary `PATCH /suppliers/:id`. `supplierListWhere(me,
  q, mayOrders)` in `routes/masters.ts` feeds rows, summary and paper.
  "Ordered from" counts orders actually placed (ISSUED, PARTIALLY_RECEIVED,
  RECEIVED — never a draft); "awaiting" is the PO list's `?awaiting=true`.
  **Order figures are Supplier 360's window**: only for a caller holding
  `gchain.purchase_orders.view_all` — otherwise the row counts are null, the
  summary leaves "awaiting" out (never 0), the paper drops the columns
  and the filter is a 403. The master is shared, so All for everyone.
- **A partner's "Sizing app" is "Software"** (2026-10-08, the owner's call) —
  on the filter, the column, the cards, the PDF head, search and the import
  template's `Software URL` header, which still accepts the old `Sizing App
  URL`. The stored kind stays `SIZING_APP`; nothing migrates. `humanKind()`
  in `shared/partners.ts` is the one label.
- **A partner's other sites are LINKS** (2026-10-08, the owner's call: "add
  resources so I can put a link for other sites of the partner"): resource
  kind `LINK`, the **Links** tab on the partner page after Software — a
  support portal, an e-shop, training, downloads, each a card with "Open
  link ↗". **A link is a url and never a file**: `checkResourceSource(kind,
  url, hasFile)` in `shared/partners.ts` is the one rule for the create and
  the modify route (a LINK without an address is a 400, a file alone will not
  do; every other kind still takes a file or a link), and the form offers no
  file box for it. The list and its paper count them (Links column,
  "Publishes: links to other sites"), the partner page's `counts.links`, the
  search labels it "Link", and the CSV import takes one in `Other Site URL`.
- **An import that matches on a non-unique name refuses rather than guesses** —
  the items import's Preferred Supplier matching two suppliers (a principal and
  its distributor sharing a brand) is an error, not a silent pick.

### Forecast (2026-10-08)

- **The Forecast is a separate menu after the Sales Pipeline** (the owner's
  call): every open quotation by the closing date its salesperson expects,
  consolidated weekly, monthly, quarterly or annually. `gops.forecast.*`
  (READ; sales, sales managers and executives hold it), `/g-ops/forecast`,
  `pages/sales/Forecast.tsx`; `GET /pipeline/forecast?period=week|month|
  quarter|year&from=&to=&scope=&ownerId=&leads=` with `.csv` and `.pdf` twins
  (`gops.forecast.export`, audited under `pipeline` / `forecast`). **No
  table, and it must never acquire one**: the rows are the open quotations
  (OPEN / SUBMITTED / NEGOTIATION) read through `quotationListWhere()` — the
  list's visibility rule and Mine · Team · All — each valued by
  `quotationValue()` at its own probability, and, when `leads=true`, the
  open leads with no quotation at their estimate through `leadListWhere()`.
  verify-pipeline asserts a month's bucket against the quotation list
  filtered to the same closing dates.
- **The bucketing is `shared/forecast.ts`, pure** (verify-sales): weeks start
  on Monday and are keyed by ISO week (`2026-W41`, '5–11 Oct 2026', across a
  month '26 Oct – 1 Nov 2026'), months `2026-10`, quarters `2026-Q4`
  ('Q4 2026 (Oct–Dec)'), years `2026`; all on 'YYYY-MM-DD' keys — a DATE
  column's own value, the Manila day — in UTC arithmetic, so the host clock
  takes no part. Every row lands in exactly one of the window's buckets,
  `earlier` (closing before the window), `later` or `undated`, so the four
  add up to everything open; an empty period is still listed at zero. The
  weighted sum is rounded once at the end, the board's rule. The default
  window is the current period and the next eleven weeks, eleven months,
  seven quarters or two years (`defaultWindow`); more than `MAX_BUCKETS`
  periods is a 400. A row is `overdue` when its closing date is before
  today (Manila) and it is still open.
- **The page**: the period and Mine · Team · All as `scope-switch`es, the
  window's dates, a salesperson picker fed by `people` (everyone with
  something in scope, before the owner filter) and "Include leads without a
  quotation"; the view lives in the URL (`?period=&from=&to=&scope=&ownerId=
  &leads=`); a period's row and bar link to the quotation list filtered to
  its closing dates (`closingFrom`/`closingTo`, declared keys — rule 16); the
  consolidated list groups the quotations under their period with the stage
  on `StatusBadge` (`STAGE_TONES`, exported from `Quotations.tsx`).
- **Breakdowns and a chosen range** (2026-10-12, the owner's call:
  "Forecast of Sales Person, by Product Group, by Team" and "a specified
  date range"; `docs/notes/P-forecast-breakdowns-2026-10-12.md`). Each row
  carries its `team` (`quotationTeamOf`; a lead's is its assignee's) and
  its `groups` (`groupShares()` of its value over the value revision's
  lines; a lead is one "No group" share), and `buildForecast` returns
  `byOwner`, `byTeam` and `byGroup` — one `breakdownOf()` shape: a line
  per person / team / group with a cell per period plus earlier, later,
  undated and total, value summed in cents and weighted rounded once per
  cell, the catch-all ("No team", "No group") last. A row counts once per
  line, so a quotation split across groups counts under each, but values
  add up to the forecast's own (verify-pipeline asserts all three). The
  page's **Breakdown** panel switches Salesperson · Team · Product group
  (`?by=`), a matrix of weighted over value with a bar list; a
  salesperson's cell links to the quotation list on their closing dates.
  **Filters** `?teamId=` (an id or `none`) and `?group=` (a group key or
  `none`) — the group filter keeps only that group's SHARE of each
  quotation; an unknown one is a 400. **The range**: `?range=` presets
  (`rangePreset()`: this month / quarter / year, next 30 / 90 days, next
  12 months — on the Manila day, beating a typed from/to), the first and
  last periods CLIPPED to from/to ("5–31 Oct 2026", their links carrying
  the clipped dates; a period inside keeps its name), and
  `period=range` ("Whole range") — the window as one bucket. The CSV
  appends `Team` and `Product groups`; the PDF prints the chosen
  breakdown (`?by=`) after the totals, one column per period up to six,
  else "In the window".
- **Tick boxes and a comparison range** (2026-10-12, the owner's call: "the
  product group, sales personnel and team have tick box" and "compare for
  example current year versus previous year";
  `docs/notes/P-forecast-compare-2026-10-12.md`). **By period takes the
  whole width** — its Weighted column carries a `MiniBar`, the separate bar
  panel is gone, nothing is cut off. **Salesperson, Team and Product group
  are `TickPicker`s** (`components/TickPicker.tsx`, a `fieldControl`: a
  select-sized button reading what is ticked, a panel of tick boxes with
  Clear and Done, Escape and focus-out close it); the URL keys stay
  `ownerId`, `teamId`, `group`, comma-separated (`listOf()` in the route;
  one value reads as before), the response says `ownerIds`, `teamIds`,
  `groups`; several groups ticked make a quotation's value the SUM of the
  ticked groups' shares. **`?compare=prev-period|prev-year|custom`**
  (`compareFrom`/`compareTo` for custom, a 400 without them) is
  `compareWindow()` in `shared/forecast.ts` — the same length ending the
  day before `from`; both edges a year back, 29 February to 28 February;
  or the days typed. **While a comparison is on, both windows are read
  alike**: the open rows as always PLUS every won and lost quotation
  DECIDED inside the window (`decidedAt`'s Manila day, else its expected
  closing), won at odds 100 and lost at 0 (`outcomeOdds()`); with no
  comparison nothing changes, open quotations only. `compareForecasts()`
  (pure) pairs the buckets BY POSITION (October with October, Q1 with Q1;
  past the compared window's end a pair is null, its extra buckets
  `unpaired`), compares the window and each breakdown line's `window` cell
  (every `ForecastLine` now carries it: its periods together) with the same
  line's in the compared window, and adds a line found only there at zero.
  `changeOf()` is the one change (amount in cents, percentage to one
  decimal, null when nothing came before). The page: the cards' subs
  ("last year ₱… · +27.0%"), a note saying how the windows are read,
  Previous and Change on By period, In the window / Previous / Change after
  the count in the breakdown; the CSV appends `Compared period`,
  `Previous count`, `Previous value`, `Previous weighted`, `Change
  (weighted)` to each row (empty without a comparison); the paper adds the
  same columns and two totals rows.

### Sales: board, calendar, costing

- **A lead with a quotation is never a board card**, and every quotation value
  is `quotationValue()` — Insights, the board, Customer 360 and job orders call
  it rather than a fourth lambda. A won or lost quotation leaves the board
  once its decision is older than the window (`decidedWithinDays`); one whose
  decision carries NO date (imported, continued) stays — `buildBoard` used
  to drop it, so the list and the page showed a won quotation the board did
  not (2026-10-10).
- **The board wears SCORO's dress** (2026-10-07, the owner's pipeline
  screenshots): each column is a tinted band — stage, "N deals", "value
  (Total sum)" — mapped by POSITION onto SCORO's ladder (`COLUMN_TONE`:
  lead stages and drafted quotes = Opportunity cream, SUBMITTED =
  Negotiation orange, NEGOTIATION = Closing light green, WON = Confirmed
  green), tinted with the tone tokens' rgb values; a card
  is the deal's name in bold, the company under it, the owner's face
  top-right (name in the tooltip and aria), and a footer of age against
  amount. The field toggles still shape it. **The "This month forecast"
  column is gone** (2026-10-13, the owner's call): `GET /pipeline` sends
  no `forecast`, the board draws no such column and its CSV no such rows —
  the Forecast menu consolidates closing dates. The optional "This month
  forecast" tile (off by default) still reads `kpis.forecast*`.
- **"Forecast deal" on the board is manual forecast input** (the owner's
  call): "+ New → Forecast deal" asks company, value, probability and
  expected closing and files a LEAD with `source: "Forecast"` — the
  pipeline stays a view over leads and quotations (no third record), the
  card appears at once, and value × probability joins the month its
  expected closing names. Hand-typed forecasts stay tellable by source.
- **The stages are SCORO's statuses, as data** (2026-10-07, the owner's
  pipeline and status-settings screenshots): `shared/pipelineStages.ts`
  holds `DEFAULT_STAGES` — Opportunity (10%, cream), Negotiation (50%,
  orange), Closing (90%, light green), Confirmed (100%, green), Completed
  (100%, blue), Lost (0%, off the board), On hold (says nothing, off the
  board) — each gathering the fine statuses and board columns that stand in
  it. **Completed is derived**: a won quotation with a sales order or a
  project (`Card.booked`; `stageOfCard()` gives the booked WON card the
  later of the two stages sharing the column). Admin › Pipeline Stages
  (`admin.pipeline_stages.*`, `GET/PUT/DELETE /pipeline/stages`, one
  Setting `pipeline.stages` of overrides merged by `mergeStages()`) changes
  what SCORO lets an administrator change — name, odds, colour, "in active
  list" — and never which statuses a stage gathers nor the fixed odds
  (Confirmed/Completed 100, Lost 0, On hold null: a won deal weighted at 90%
  misstates the forecast). The board (`GET /pipeline` carries `stages`, and
  each card its `stage`) draws SCORO's six bands by default — the "Stages"
  view, tinted with the stage's own colour through `--stage-color` — and
  "All steps" is G-CORE's eleven fine columns; a drop on a stage resolves to
  the first of its columns the server allows (`stageTarget()`), so the move
  rules stay the one `allowedTargets`. The summary strip is SCORO's six
  tiles in its order (Total, Average quote, Average discount, Sum, Margin,
  Overdue). The CSV twin appends a Stage column.
- **The stage sets the odds** (2026-10-07, the owner's SCORO status
  settings): `stageProbability()` / `probabilityAfterMove()` (in
  `shared/pipelineStages.ts`, re-exported by `shared/pipeline.ts`) read the
  configured stages — opportunity stages (every lead stage before a
  decision, `QUOTATION_CREATED`, a drafted quote) 10%, SUBMITTED 50%,
  NEGOTIATION 90%, WON 100%, LOST 0%, On hold says nothing, by default.
  Both PATCH routes apply it on a stage move (`await pipelineStages()`)
  UNLESS the same request typed a probability (an explicit value is
  somebody's judgement), a move within one band keeps a typed value, and
  the lead that follows a quotation's outcome takes the stage's odds too.
  The record pages still override afterwards — the stage only sets the
  starting odds, exactly as SCORO's statuses do. verify-pipeline sets an
  administrator's `pipeline.stages` aside for the run, as verify-sales does
  with the PDF layouts.
- **The quotation page prints the STAGE as its status** (2026-10-08, the
  owner's call: "if dragged to another column, the quotation also changes
  its status" — it always did, but the page printed the fine step,
  Submitted, where the board printed its stage, Negotiation, and "Closing"
  on the board read "Negotiation" on the page). `GET /quotations/:id`
  carries `stage` and `stageLabel` (`quotationStage()`, booked-aware, so a
  won quotation with an order reads Completed) and `quotationStages` — each
  stage a quotation can stand in, as Admin › Pipeline Stages names it, with
  the fine outcomes it gathers — so the page needs no pipeline right. The
  pill, Previous status, the days-in-status line, the Change status menu,
  the Modify page's Status and the list's mass action all speak stage names
  (`OUTCOME_STAGE` / `stageLabelFor()` / `stageKeyFor()` in
  `Quotations.tsx`), while every VALUE stays the fine outcome the PATCH
  takes; the fine step is named under the pill ("Step: Submitted"). After a
  drop in the board's Stages view the toast names the stage dropped on, and
  the owner's bell says "moved to Closing (negotiation)" — the stage first,
  the step after it where the words differ. verify-pipeline asserts the
  board card, the list row and the page agree after a drop.
- **Hold and Cancel on the Move menu** (2026-10-13, the owner's call).
  **A quotation can be put on hold**: `ON_HOLD` is a `QuotationOutcome`,
  NOT open — the forecast, the open counts and the open filters list
  OPEN / SUBMITTED / NEGOTIATION and so leave it out; a leaver's clearance
  counts it. It stands in the board's parked On hold column and the On
  hold stage (`columnFor`, `quotationStages()` now lists HOLD; the board
  query fetches held quotations), `allowedTargets` puts an open card on
  hold and a held one back on an open stage or Lost — never straight to
  Won — and its lead follows to ON_HOLD and back. SCORO's "Hold" imports
  as ON_HOLD. **Cancel is Lost with a kind**, not a stage:
  `Lead.lostKind` / `Quotation.lostKind` (`LostKind` LOST | CANCELLED,
  null unless lost), set by the PATCH's `lostKind` through
  `lostKindAfter()` (`shared/pipeline.ts` — LOST by default, cleared on
  leaving Lost, a 400 without Lost); the lead takes its quotation's kind.
  A cancelled one reads "Cancelled" wherever its stage is named
  (`cancelledLabel()` in `routes/sales.ts` — the list rows, the quotation
  page, the lead rows; "Cancelled because" on the pages, "Cancelled:" on
  its card) and counts as NEITHER won nor lost: the board's `lostCount`
  and Insights' lost counts, win rates and lost reasons leave it out
  (`NOT_CANCELLED` in `routes/insights.ts`, null-safe), `cancelledCount`
  and Sales Analytics' `cancelled` say how many; SCORO's "Cancelled"
  imports cancelled. The Move menu offers "Put on hold" and "Cancel…"
  (the reason asked in the confirm bar) in both views; the quotation page
  has "Cancel quotation" and the lead page "Cancel lead" in ⋯ beside
  Mark lost, and the quotation list's Change status gains On hold and
  Cancelled.
- **The move rules are `assertLeadStatusChange` / `assertOutcomeChange`** in
  `shared/pipeline.ts`, called from the PATCH routes; the board's drop targets
  come from `allowedTargets()` on the same rules. Do not add a board-only move
  endpoint or re-implement the rules in a page — three screens would then refuse
  different things.
- **`buildBoard()` is pure; `GET /pipeline` only fetches.** Test board arithmetic
  in `verify-sales.ts` and reconciliation in `verify-pipeline.ts`. Weighted sums
  round once at the end; summing rounded cards drifts. The CSV twin is
  `/api/pipeline/board.csv` — Express never hands the router `/api/pipeline.csv`.
- **Every calendar renders through `components/MonthCalendar.tsx`.** Callers hand
  it `CalendarEvent`s already bucketed on a local day key (`dayKeyOf`) and toned
  through `statusTone(status, extra)`. Do not draw a second grid or put a
  status-to-colour rule in a caller.
- **Calendar view and position live in the URL** (`?view=&month=&week=`,
  `?date=` as an alias), never in localStorage — a calendar that opens on the
  month you last looked at opens on the wrong month.
- **Fetch on `nav.windowKey`, never on `from`/`to`**, and `to` is the last grid
  day at 23:59:59.999 local: the API's `lte` is inclusive, and a window ending on
  midnight counts that instant in two windows. `verify-calendar.ts` proves a
  boundary activity lands in exactly one.
- **Never `new Date('YYYY-MM-DD')` in the browser** — that is 08:00 Manila. Use
  `parseDay`/`dayKeyOf` from `web/src/lib/day.ts`, which is DOM-free so the verify
  script can import it.
- **One roving tab stop per calendar grid**, and DOM focus follows only keyboard
  moves, so a toolbar click leaves the person on the button they pressed.
- **`activityWhere()` in `shared/activities.ts` is the one rule** for which sales
  activities a query means (inclusive `lte`, 14-day default). Activity writes are
  audited like every other write.
- **Leads print** (2026-10-07): `GET /leads/:id/pdf` is the whole lead on
  paper (details, enquiry, costings, quotations, activities,
  notes) under the lead's own visibility rule, and `GET /leads/pdf` — above
  `/:id`, the route-order trap — is the LIST as the screen shows it, through
  `leadListWhere()`, the same where-builder the list uses, so the paper never
  shows a different set (its filter line says what narrowed it; capped at
  1,000 rows). Both audit EXPORTED; the list export's entityId is `list`.
- **The leads list is the quotation list's layout** (2026-10-08): the board's
  stages a lead can stand in as a Stage filter (`?stage=`: Opportunity,
  Negotiation, Closing, Confirmed, Lost, On hold — `leadStages()` /
  `leadStage()` / `leadStageStatuses()` in `shared/pipeline.ts`, the board's
  own `statuses` lookup; never Completed, which is a quotation's; the
  counts still come as `summary.tabCounts`), the fine
  status still a column (with its stage under it) and a filter, Filters
  (status, owner, added by, customer, Added — a timestamp, Manila days — and
  Expected closing — a DATE), summary cards of the count, the estimated and
  the weighted value and My team (`leadListSummary()`, summed in centavos),
  the printed list and mass actions. **The customer filter's key is `clientId`, never `customerId`**:
  this page's `?new=1&customerId=` is the "new lead for this customer"
  hand-off, and a list must not eat it (rule 16). `leadListWhere(me, q,
  stages)` returns `{ base, where }` and feeds the rows, the summary and the
  paper. Mine for `edit_own`/`edit_all` holders, All for a reader. **Mass
  actions are Change status and Assign to**, each the ordinary
  `PATCH /leads/:id` per row (the move rules, the stage's odds, the new
  owner's notification and the audit row are the PATCH's): the statuses
  offered are a lead's own (New … Costing, On hold, Lost — one reason for
  all), never the quotation stages, and a lead with a quotation stays — it
  moves with its quotation (`planLeadMove()` in `Leads.tsx`). Rows carry
  `stage`, `stageLabel` and `canEdit`.
- **A lead says who added it** (2026-10-06): `Lead.createdById`, set once on
  create and never edited, is the list's "Added by" column (with the date) and
  `?createdById=` filter, and the lead page's "Added by" row. It is not the
  owner — a manager often records an enquiry and assigns it on.
- **The calendar's activity form picks no lead, quotation or customer**
  (2026-10-07, the owner's call) — **reversed on 2026-10-08**, when the
  owner asked for SCORO's New event dialog, whose Links panel names the
  customer, contact person, project, quotation and lead (see "The activity
  form is SCORO's New event dialog" under the calendar notes). `ActivityLog`
  on the lead, quotation and customer pages still sends its own links.
- **"Start costing" moves a lead forwards only** (from NEW, CONTACTED, QUALIFIED
  or SITE_VISIT to COSTING), and the lead lookup runs before `nextNumber` so an
  unknown lead burns no number. `PATCH { leadId }` is a correction and moves
  nothing.
- **A sales activity has Starts and Ends, invitees and a reminder**
  (2026-10-06). `durationMinutes` stays the stored figure: the form sends
  `endsAt` and the API derives the duration (5 minutes to 7 days), and every
  response carries `endsAt`. `SalesActivityInvitee` (one row per person,
  cascade) holds the others asked along; an invitee must hold
  `gops.calendar.view_all` (the notification links to the calendar), except
  one invited before losing it. Invitees are told on save
  (`activity.invited`); moving or cancelling tells everyone already on it
  (`activity.updated`), never the person who made the change. "Whose
  activities" and `activityWhere({ assignedToId })` match the assignee OR an
  invitee, and the My Work provider in `routes/workspace.ts` does the same.
  **Telling people is `tellAboutActivity()`**: a bell each, plus an email
  each through `shared/mail.ts` when SMTP is set, sent after the save and
  never allowed to fail it. No SMS (the owner's call).
- **The sales calendar has a Day view, and the day and week views are a
  time scale** (2026-10-08, SCORO's scheduling): `CalendarView` is `day |
  week | month` (`useCalendarNav` carries `?day=` beside `?week=` and
  `?month=`, `goToDay()` opens a day; the other calendars keep `views:
  ['month']`); `windowFor('day', key)` is the one day. `TimeGrid` in
  `Calendar.tsx` draws an hour gutter, a column per day, all-day items (a
  service visit) in a row over the hours, and each activity a block sized
  by its Starts and Ends — placed with `calc(minutes / 60 * var(--cal-hour))`
  on the one token, never a pixel — in lanes where blocks overlap. **A
  half-hour slot shows "+" under the pointer and books that time** (the
  form opens on it, an hour long); the slots are not tab stops — "+
  Schedule" on the focused day is the keyboard's way. The arithmetic is
  `web/src/lib/timeGrid.ts` (`blockSpan`, `placeInLanes`, `slotAt`,
  `minutesLabel`), DOM-free and pinned by verify-calendar; an activity
  across midnight is clipped to each day it touches. The month's day click
  opens the day.
- **Activity types are data** (2026-10-08, SCORO's customisable types):
  `SalesActivityType` (Admin › Categories › Activity types,
  `/api/reference/activity-types`, `admin.categories.*` to change, anyone
  signed in to read) — name, colour (the chip's edge, on the month grid and
  the time grid), order, active. An activity carries the type's KEY
  (`SalesActivity.typeKey`; the key is derived from the name once and never
  changes, so a rename rewrites nothing); the enum column `type` stays one
  deploy as the fallback — the six built-ins are seeded under the enum's
  own keys (`seedActivityTypes()`, which also backfills `typeKey` from
  `type` once), a custom type is written as OTHER in it, and every reader
  takes `typeKey ?? type`. Every activity leaves the API with `type` (the
  key) and `typeName`. A new activity must take an ACTIVE type (400
  otherwise); the type an activity has may stay on it after it was
  deactivated. The six built-ins are never deleted and OTHER never
  deactivated; a custom type in use is deactivated, not deleted.
- **Birthdays and work anniversaries are derived, never stored** (2026-10-08,
  the owner's call): `shared/celebrations.ts` reads each active employee's
  `birthDate` and `dateHired` on the fly (`annualDayIn` — a 29 February keeps
  to 28 February in a common year; `occurrencesBetween` — the date itself is
  no occasion). `GET /employees/celebrations?from=&to=` (above `/:id`, anyone
  signed in, at most a year) feeds the sales calendar's **People layer** —
  on by default, `?people=0` hides it, all-day chips "🎂 Maria Santos turns
  34" / "🎉 Juan dela Cruz · 5 years with us", the age and the years shown
  to everyone as the owner asked, a chip opening the employee record only
  for `ghr.employees.view_all` — and a `registerSchedule` provider puts the
  day's into My Work's Today as all-day rows (`startsAt === endsAt`, kind
  `celebration`). **The greetings are the one thing here that writes**:
  `sendDueGreetings(now)` runs on the activity reminders' minute tick, from
  the Manila hour HR sets, and CLAIMS a `Greeting` row (unique on employee,
  kind, year) before anyone is told — the celebrant gets a bell
  (`greeting`) and an email where SMTP is set, everyone else a one-line
  bell when "Tell everyone" is on. The templates are `hr.rules.greetings`
  (`GreetingSettings`, `GREETING_DEFAULTS` in `shared/hr.ts`; `{first}`,
  `{name}`, `{company}`, `{years}`, `{n}`), edited on HR Settings'
  Greetings card, which PUTs only `{ greetings }` — the route merges a
  partial over what is stored. verify-calendar pins the leap-day rule, the
  feed, the My Work rows, the hour gate, the once-only claim and the
  settings merge; its celebrant's names carry the TAG so cleanup can take
  the office's bells back.
- **Invitees answer Going / Maybe / Not going** (2026-10-08, SCORO's visual
  confirmation): `SalesActivityInvitee.response` (`InviteeResponse`, the
  meeting's enum — PENDING is "No reply") and `respondedAt`. `POST
  /activities/:id/respond { response }` is the invitee's alone (403 for
  anyone else, 409 once the activity is done or cancelled); whoever booked
  it is told (`activity.responded`, "Maria is going: …"). Every read with
  invitees carries `responses: { going, maybe, notGoing, noReply }`, so a
  chip says "✓2 ✗1 ?3" (readable without colour) and My Work's row says
  what the viewer answered. **Clicking an activity opens its own page**
  (2026-10-08, SCORO's event page, the owner's screenshot):
  `/g-ops/calendar/activities/:id` (`pages/sales/ActivityPage.tsx`,
  `gops.calendar.view_all`) — the date as a block, the title, the status
  and type, when and for how long ("8h 00min", `durationLabel`), where,
  the people on it as faces (`Avatar` on `photoPath`, which the activity
  reads carry) with their answer under each, "Open in Google Calendar ↗"
  (`googleCalendarUrl` on `GET /activities/:id`, the meeting's hand-off
  from `shared/calendar-links.ts`, for a planned activity), Details,
  Description, **Responses as a table grouped Going / Maybe / Not going /
  No reply with when each answered** (the thing SCORO's page lacked, the
  owner's ask), the invitee's own Going / Maybe / Not going buttons, Files
  (attachments on `sales_activity`), and Modify (the form, `ActivityModal`
  exported from `Calendar.tsx`), Mark done and Cancel, confirmed in the
  page. `activityLink()` in `shared/activities.ts` is where every
  notification about an activity lands; the calendar's old
  `?activity=<id>` link redirects there, carrying `?respond=`. The
  invitation email carries Going / Not going / Maybe links
  (`activityEmailText`, `respondLinks`): `?respond=` on the page records
  the answer on opening, for the invitee only, then drops out of the URL.
- **The activity form is SCORO's "New event" dialog** (2026-10-08, the
  owner's first screenshot: "make it as reference for calendar"):
  `ActivityModal` in `pages/sales/ActivityForm.tsx`, opened by "+ New activity"
  and a time-grid slot on the calendar and by Modify on the activity's page;
  what the three screens share (the `Activity` row, the answers, the
  reminders, the types' stand-ins) is `pages/sales/activityShared.ts`, no
  React, so none imports another. The event on the left — Date, Start,
  Duration in hours and minutes with "Ends 11:30 AM" under it, All day,
  Private, Repeat (new only), Title, Activity type, Booked for, Address,
  Conference call link, Description, Reminder, Status (existing) — and
  beside it **Participants** (`PeoplePicker`, now with faces: `photoId` on
  its `Person`, which `/users/lookup` sends as `photoPath`) and **Links**:
  Customer (`CustomerPicker`), Contact person (the customer's contacts from
  `GET /customers/:id`), Project (`/jobs/lookup`), Quotation and Lead (the
  ordinary lists' `search=`), each offered only to a viewer who may read
  that record and otherwise shown as "(kept)". **This reverses the
  2026-10-07 "the calendar's form picks no lead, quotation or customer"
  decision** — SCORO's dialog has them and the owner asked for SCORO's
  dialog; `ActivityLog` on the record pages still sends its own links. The
  foot is SCORO's: Save, **Save and open** (the page) and **Save and add
  another** (the form stays, blank, on the same time; `onSaved(saved,
  action)`) — the last two on a NEW activity only. Removing is the
  activity page's ⋯ (rule 19): "Delete", or "Remove this one" / "Remove
  this and later ones" on an occurrence of a series, each asking first. Not here, on purpose: SCORO's Busy (no
  availability view), Shared resources (no resource booking), rich text
  (every note in the app is plain) and Add file (files go on the page once
  it exists). The columns: `SalesActivity.allDay`, `isPrivate`, `callLink`
  (http(s) only, `safeHttpUrl`), `contactId` (must be one of the customer's
  contacts, so a contact needs its customer — `checkActivityLinks()`),
  `jobId` (exists, not cancelled), `createdById` (who booked it, shown on
  the page), `seriesId`.
  - **All day** snaps Starts to the day's Manila midnight
    (`allDayStart()`) and runs whole days (a 10-hour "all day" is a 400);
    `toEvent` gives it `time: null`, so the grids draw it in the all-day
    row beside the service visits.
  - **Private is SCORO's "Personal"**: `maskPrivate()` in
    `shared/activities.ts` is applied to every read that leaves the API
    (the list and the one; My Work lists only the viewer's own). Someone
    not on it — not booked for it, not invited, not the one who booked it
    (`isOnActivity()`) — reads "Busy" with the time and the person and
    nothing else: no notes, address, call link, links, invitees or Google
    hand-off, `masked: true`; the page shows the title "Busy", one line,
    and no buttons; the PATCH and DELETE are a 403 for them. A super admin
    sees it whole, as they do every record.
  - **Repeat is rows, never a rule**: `repeatOccurrences(first, every,
    until)` (pure, verify-calendar) steps a day, a week or a month on the
    Manila wall clock — a monthly booking on the 31st falls on 28 February
    and is back on 31 March, counted from the first each time — up to and
    including the last Manila day `until` names, at most `MAX_OCCURRENCES`
    (60; more is a 400 before anything is written). `POST /activities`
    writes every occurrence in ONE transaction, each an ordinary activity
    carrying the first one's id as `seriesId` (the first carries its own),
    with its own invitees, reminder and audit row; the invitees are told
    ONCE, the body saying how it repeats ("repeats weekly until Mar 24,
    2031 (4 times)"); the response carries `occurrences`. Editing an
    occurrence edits that one. `DELETE /activities/:id?series=upcoming`
    removes it and every LATER PLANNED occurrence of its series (a past or
    done one is a record and stays), answering `removed`.
- **Reminders are the one thing G-CORE runs on a timer.** `reminderMinutes`
  is null, 15, 60, 120 or 1440 (`REMINDER_MINUTES`).
  `startActivityReminders()` (called from `index.ts` after `listen`, never
  from a script) runs `sendDueReminders()` once a minute; each due reminder
  is CLAIMED with a conditional `updateMany` on `reminderSentAt: null` (and
  the start and offset it was read with) before anyone is told, so two ticks
  or two processes never send it twice. A reminder whose moment passed while
  the API was down still goes before the start; one for an activity already
  started is never sent. Changing the time or the offset clears
  `reminderSentAt`. Everything else that looks scheduled (expiry, missed
  visits, evaluations due) is still swept on read — do not move those onto
  the timer.
- **"Assign costing" replaced the lead page's "Start costing"** (2026-10-06,
  the owner's call): a panel in the page, never a dialog. `POST
  /costings/assign { leadId, assigneeId, note }` needs the right to EDIT THE
  LEAD (`gops.leads.edit_own` + `canEditRecord`), not to cost; the ASSIGNEE
  must hold `gops.costing.create`. It creates the DRAFT in the assignee's name
  (`ownerId`), with the lead's customer and site, `assignedById`,
  `assignedAt` and `assignmentNote`, numbers it with the caller's `tx` after
  every refusal, moves the lead forwards only (same rule as below), notifies
  the assignee and audits. Picking yourself opens the new costing's sheet.
  The lead page lists each costing with whose it is and who assigned it,
  when; the costing page shows "Assigned by". The picker is
  `/users/lookup?holding=gops.costing.create`.
- **A duplicated costing copies the numbers and not the history** — DRAFT, owned
  by the copier, no lead, revisions or jobs, totals recomputed through
  `recalc(tx)` rather than copied, so it can never carry a figure its own lines
  do not add up to.

### Delivery and procurement

- **A job's customer is its costing's customer**; `POST /jobs` refuses another.
  **A renewal is one transaction**: `renewedFromContractId` forces
  SERVICE_CONTRACT and writes the DRAFT contract with the job, so a refused
  renewal leaves no job behind. `renewalTerm()` keeps whole-month terms whole.
- **Turnover registers equipment, then moves the status** — never a TURNED_OVER
  job with nothing in the installed base.
- **`GET /jobs/lookup` excludes COMPLETED and TURNED_OVER** unless
  `?includeClosed=true`; equipment registration and supplier bills need it.
- **Cross-module cards are hidden, not empty, without their `view_all`**, and a
  card reading another module's list with `?jobId=` re-checks each row's job on
  the client, so a register that has not learned the filter shows nothing rather
  than every project's documents.
- **Overtime on a project shows the posted amount only**, never the rate, even
  though the list endpoint returns it.
- **A PO is edited only while DRAFT, by its author or `edit_all`**
  (`canEditRecord` in `poForEdit()`), and every edit audits. A direct-to-job PO
  line must name its cost category (`requireCategory()`) — without it the
  approved order commits nothing for that line. An order from an awarded canvass
  keeps its supplier; the link is derived (`awardedCanvass()`), there is no
  `canvassId`.
- **Stock value is `stockOnHand()` everywhere** — the G-CHAIN dashboard,
  `/inventory/reports/summary` and Insights. **A dashboard never prints a zero
  it could not count**: `chainOverview()` returns `null` for a figure the caller
  cannot open, and the tile prints "—".
- **Supplier bills appear on a PO or receiving only for `gfin.ap.view_all`**
  (`billsVisible`); a link to a bill the reader cannot open is a 403 waiting to
  happen.

### Aftermarket: Service Schedule and job orders

- **The register asks for an equipment type, an address and a specification**
  (2026-10-07, the owner's call). "Equipment type" is still
  `InstalledAsset.name` — text, with suggestions from `EquipmentType`
  (seeded CAPSLOCK: COMPRESSOR, DRYER, FILTER, GENERATOR, PUMPS, VFD,
  INSTRUMENT, FIRE PUMP, OTHERS; anything typed since is remembered through
  `rememberEquipmentTypes`, upper-cased, `GET /installed-assets/types`).
  `address` is where the machine is, free text — the form no longer offers
  the CustomerSite picker, but `siteId` stays and is still written by the
  turnover flow; screens show `site?.name ?? address`. `capacity` is now
  labelled Specification (voltage, power, flow, pressure, application);
  `location` is "Location". The form's Customer is predicted from
  `/customers/lookup` as it is typed, and — for a `gops.customers.create`
  holder — "Add as a new customer" files one properly (name + industry)
  through the ordinary `POST /customers` before registering.
- **The register prints**: `GET /installed-assets/pdf` (above `/:id`) is the
  list as the screen filters it, through `assetListWhere()`, the list's own
  where-builder; audited EXPORTED with entityId `list`. The toolbar's own
  Export stays the Excel-ready CSV twin.
- **`regenerateSchedule` only touches GENERATED visits** (`sequence: { not:
  null }` in both the delete and the kept count). A hand-booked call-out or a job
  order's visit has no sequence and must survive; this `where` is the one place
  such a visit could be deleted silently — do not simplify it.
- **`GET /service-visits/calendar` is a range feed** (≤ 62 days, runs
  `sweepOverdue()` first) and `GET /service-visits/:id` is what every `?visit=`
  link depends on. Both sit above the other visit routes — the
  `/overtime/chargeable` route-order trap.
- **Overdue is derived, missed is swept.** Cancelling a visit requires a written
  reason. A visit takes exactly one report (a second is a 400, not a
  unique-constraint 500), and the report takes the visit's facts.
- **A returned (REJECTED) service report is edited and resubmitted**; freezing it
  left its visit unable ever to complete.
- **The job order is the PROJECT WORK ORDER** (2026-10-09, the owner's call;
  a request for service work on a registered machine before that). Sales
  raises it for a customer with its LINKS — the quotation (any one still on,
  **one under negotiation included**), the sales order and/or the project —
  the project's name, the contact and their number, the **target start and
  target finish** (the working days, Mon–Sat, between them are `workingDaysBetween()`
  in `shared/day.ts`, computed and never stored; `requestedFor` mirrors the
  start so one index serves both shapes), the **scope of work in one box**,
  the amount, Customer PO, and the **personnel to send**: project manager,
  project engineer, project lead (one each) and project support
  (`JobOrderSupport`, any number). No equipment, no kind, no urgent flag,
  no charge basis any more — `kind`, `urgent`, `assetId`, `chargeBasis`,
  `contractId` stay on the table for the orders raised before, which print
  without them. Linking a quotation fills the name, contact, number, site
  and amount (`/job-orders/options` sends each quotation's net and whether a
  costing stands behind it, and the customer's live sales orders); a sales
  order must book the quotation the order keeps. "Mine" is what you raised
  OR are sent on (`mineWhere`).
- **The route is the project manager named ON THE ORDER, then the
  salesperson's team leader**: seeded "Job order — project manager then
  team leader" — step 1 the engine's PROJECT_MANAGER type reading the
  request's own `projectManagerId` (`ApprovalRequest.projectManagerId`,
  `ApprovalContext.projectManagerId`, read before the job's; `ctxOf(request)`
  is what every engine read passes; `project_manager` role when none is
  named or the PM raised it), step 2 SUPERVISOR falling back to
  `sales_manager`. "Job order — service manager" is RETIRED.
- **Approval BUILDS THE PROJECT** (the owner's choice over booking a visit):
  `settleJobOrder` claims PENDING_APPROVAL → APPROVED with a conditional
  `updateMany`, then — for an order with no project yet — reads the linked
  quotation's value revision's `costingId`, checks it through
  `costingForJob()` and writes the job through **`createJobRecord()`**, both
  exported from `routes/jobs.ts` and the SAME code `POST /jobs` runs, so a
  project comes to be one way: named as the order names it, `startDate` the
  target start, `targetEndDate` the target finish, the order's PM as its
  manager, the quotation revision linked only when APPROVED (a revision
  under negotiation stands behind no job), the costing marked FINAL. An
  order already linked to a project builds nothing; one whose quotation has
  no usable costing is still approved — the decision stands — and its trail
  and the requester's bell say why, for the project to be built by hand.
  A double settle builds nothing twice (verify-aftermarket). **A job order
  posts no cost**; cost reaches its project through overtime, PRs, stock
  issues and claims. Orders raised as service calls before keep their
  visit: the report on it still completes the order in `onReportSettled`.
- **The amount is the linked document's NET** (the sales order's, else the
  quotation's value revision's: subtotal less discount, before VAT — the
  invoice adds VAT) unless somebody typed one.
- **`/job-orders/options` feeds the form's pickers** behind the form's own
  permission; the people come from `/users/lookup`. The PDF prints the
  project, the links and amount, the scope, the personnel, and the route's
  steps as sign-offs through `approvalSlots` ("Pending" until signed) with
  the customer's acknowledgement slot last.
- **Section photos** are attachments on `service_report` with entityId
  `<reportId>~<sectionKey>`; `GET /service-reports/:id` returns them by prefix.

### CAD job orders: the design team's queue (2026-10-09)

The owner's call: "an additional menu for CAD J.O. … optimize the design
team, consolidating job orders: attach files, revision traceability, the
designer updates the status by percentage, the requestor comments for
changes, the designer sets the priority; there is a Designer Lead and a
Designer Support; the output is always a PDF for the requestor".
`/g-ops/cad-job-orders` under Project Management (Costing · Projects · Job
Orders · **CAD J.O.** since 2026-10-14 — pinned by verify-foundation), `gops.cad_job_orders`,
`routes/cadJobOrders.ts`, `pages/delivery/CadJobOrders.tsx`,
`styles/cad.css`, numbering type `cad_job_order` (CJO), verify-cad.

- **It is work, not a decision: no approval route, no money.** Nothing here
  touches `shared/approvals.ts`. The rights are the registry's eight with
  two of them given a meaning: **`edit_all` is the design team** (Designer
  Lead and Designer Support, seeded roles `designer_lead` and `designer`;
  assign both in Admin › Users) — progress, revisions and priority on what
  is assigned to them, and taking an unassigned request; **`approve` is the
  Designer Lead's dispatch right** — assign, reassign and unassign any,
  close any. `edit_own` is the requestor on their own request (sales, sales
  managers, project managers, project engineers and service engineers hold
  `VIEW_OWN_SELF`); `view_all` is the design team, sales managers, PMs and
  executives. `flags(me, row)` in the route is the one rule for every
  button; the page draws what it says. The people picker is
  `/users/lookup?holding=gops.cad_job_orders.edit_all`.
- **The lifecycle**: REQUESTED → IN_PROGRESS (taken or assigned) →
  FOR_REVIEW (a revision submitted; progress 100) → COMPLETED (the
  requestor accepts; the designer or the lead may close it instead, WITH a
  note) or CHANGES_REQUESTED (the requestor's comment, `isChangeRequest`,
  pinned to the latest revision; reporting progress puts it back IN
  PROGRESS) ; ON_HOLD from either side with a reason, and Resume returns it
  to `statusBeforeHold`; CANCELLED by the requestor or the lead with a
  reason. A completed or cancelled request is a record: no edits. Accept
  and take are conditional `updateMany` claims. **Overdue is derived**
  from `neededBy` (a DATE, Manila's day through `dayKey`), never stored;
  the list's `?overdue=true`, the summary card and My Work all read it.
- **Revisions are rows, never overwritten** (`CadRevision`, unique on
  request + sequence: R0, R1 …), each with its note, an optional http(s)
  `externalUrl` (`safeHttpUrl`) and its files as attachments on
  `cad_revision`. **A revision must carry a PDF** — the owner's call, the
  output to the requestor is always a PDF; the AutoCAD or SketchUp source
  travels beside it. A refused upload `discard()`s what multer already
  wrote, so nothing strays on disk (verify-cad counts the upload folder).
- **CAD files are accepted by EXTENSION, and take their own ceiling.** A
  browser sends a `.skp`, and often a `.dwg`, as `application/octet-stream`,
  so `shared/attachments.ts` admits `CAD_EXTENSIONS` (dwg, dxf, skp, rvt,
  ifc, step, 3ds, rar, 7z …) beside the MIME list — document formats a
  viewer opens, never something a browser runs — and `cadUpload` carries
  `MAX_CAD_UPLOAD_MB` (default **100**, the Cloudflare tunnel's limit per
  request; bigger goes as a split zip or as the revision's external link).
  The generic `/attachments/:entityType/:entityId` POST picks `cadUpload`
  for `isCadEntity()` types. Such a file downloads under its name; PDFs and
  images open as before.
- **The thread is `CadComment`**: permanent, by anyone who may open the
  request, with files (attachments on `cad_comment`) and optionally the
  revision it is about. Every comment, revision, assignment and change of
  status or priority tells the other side — the requestor and the designer,
  never the person who did it — by bell (`cad.*` notification types) and by
  email where SMTP is set (`tell()`; mail never fails the request). A new
  request tells the whole design team (`designTeam()`: active holders of the
  design right or the lead's through a role or an allow override; super
  admins are not designers). **Attachment guards** on the three entity
  types apply the request's own visibility (`mayOpen`: view_all, or the
  requestor or the designer on it).
- **One click raises the accepted revision as a Request for Approval** on
  the linked project ("Raise request for approval"; `POST /:id/file-plan`,
  once, `CadJobOrder.approvedPlanId` unique, claimed on null): a numbered
  DRAFT request with the CAD J.O.'s number as its drawing reference, `R<n>`
  as revision, the drawing type as discipline, and the revision's files
  COPIED onto `approved_plan` — a copy, because deleting an attachment row
  unlinks its bytes and the revision keeps its own. `requestFromCad()` in
  `routes/planApprovals.ts` is the one way, shared with the request form's
  "From a CAD J.O."; the page opens the new request for its requester to
  submit.
- **Drawing types are data** (`CadDrawingType`, Admin › Categories ›
  Drawing types, `/reference/cad-drawing-types`, `admin.categories.*` to
  change, anyone signed in to read): `CAD_DRAWING_TYPES` in
  `shared/cadDrawingTypes.ts` seeds the seven as system rows — renamable,
  never deleted, switched off instead; a custom one in use is deactivated.
- **The list is the shared layout**: `cadListWhere(me, q)` (`base` =
  visibility + scope + search + `ids`; `where` adds the filters: status,
  priority, open, overdue, unassigned, designer (`assignedToId`, or
  `none`), requestor, drawing type, customer, project, quotation,
  `neededFrom`/`neededTo`) feeds the rows, `cadListSummary(base)` (the
  cards: open, waiting for a designer, in progress, for review, overdue,
  completed) and the paper (`GET /cad-job-orders/pdf`, above `/:id`,
  `?ids=`). Mine is "raised by me or on my board"; the design team opens on
  All, everyone else on Mine. Mass actions for the lead: Assign to and Set
  priority, each the ordinary call per row. The request's own PDF prints
  the request, the scope, the revisions, the thread and three dated
  sign-offs (requested, drawn, accepted — "Pending" until each happens).
  Ctrl+K finds requests under the same visibility; **My Work** lists the
  designer's open requests, the requestor's drawings awaiting review and,
  for the lead, the queue nobody has taken.
- **Priority is the design team's, never the requestor's** (the owner's
  call): the requestor gives a needed-by date; the designer or the lead sets
  Low / Normal / High / Urgent. Progress is a whole 0–100 reported by the
  designer on it (`NumberInput kind="count"` with 25 / 50 / 75 / 100
  buttons); a submitted revision sets it to 100.

### Modify where nothing had one (2026-10-09, rule 19's second half)

The owner asked for Modify, Delete and Back in the same place on every
screen; ten documents had no Modify at all. Each now has one, in the header's
right-most place, with the API behind it. The shape is always the same: **a
draft is modified; a pending document is PULLED BACK first, never edited
behind its approver** (`submitForApproval` snapshots the amount and subject
and picks the workflow by amount band, so an edit after submission would
leave the approver deciding on stale figures).

- **The pull-back** (purchase request, expense claim, leave, overtime actual
  hours; the quotation and sales order already had one) claims
  PENDING_APPROVAL → DRAFT with a conditional `updateMany` and calls
  `cancelOpenRequest` in the SAME transaction. An empty return means a
  decision claimed the request first: the transaction rolls back and the
  route answers 400 "decided a moment ago" — the decision must apply. Every
  settle subscriber touched here (`settlePurchaseRequest`,
  `settlePurchaseOrder`, `settleExpense`, the supplier-bill subscriber, leave
  and overtime) applies an outcome only through a conditional claim on the
  pending status and otherwise writes "… — not applied" to the trail.
- **Submit claims DRAFT conditionally, and on `updatedAt` too** where a
  Modify may race it ("It changed a moment ago — reload"), files the request
  in the REQUESTER's name whoever presses the button (`requestedById`,
  `claimedById`, the employee's login), and goes back to DRAFT when the
  engine refuses — none of these documents is stranded pending with no
  request any more.
- **G-CHAIN**: a purchase request's header and lines change while DRAFT
  (`PATCH /purchase-requests/:id`, `requireAny(edit_own, edit_all)` +
  `canEditRecord`); kind and project change under the create rule
  (`checkPrTarget`: direct-to-job needs a project and a budget line on every
  line, filled from the item's category or refused naming the line; stock
  needs a warehouse and drops the project). Its PDF prints the route a draft
  would take (`routePreview`) and `approvalSlots` once submitted, so a
  pulled-back request never prints the old approver's signature. A canvass
  changes only its notes once opened, and its supplier rows' lead time,
  terms and remarks while OPEN; a supplier is never removed once awarded. A
  stock issue is modified or deleted only as a DRAFT — moving warehouse
  re-prices every line at that warehouse's average (Decimal), refused for an
  item it never held — and `POST /:id/issue` claims DRAFT on the warehouse
  and project it read. A borrow slip changes who, when due, what for and
  notes while anything is out; a receiving only its DR no., invoice no. and
  notes (what arrived is the record).
- **G-FIN**: `PUT /expense-claims/:id` (claimant with edit_own, or
  edit_all), `PUT /supplier-bills/:id` (gfin.ap.edit_all), `PUT
  /invoices/:id` (gfin.ar.edit_all) — DRAFT only, lines replaced in the same
  transaction, money from one helper shared with create (`claimLines()`,
  `billMoney()`, `manualInvoiceMoney()`), a draft keeps its stored VAT/EWT
  rates. A liquidation keeps what it accounts for; a bill's links go through
  `billLinks()` (an order with goods received always lends the bill its
  receiving — what stops approval charging twice); an invoice raised from a
  billing changes only dates, terms, PO reference and notes. `POST
  /supplier-bills/:id/cancel` takes a draft with a reason. Cancelling an
  invoice releases both `progressBillingId` and `jobOrderId`. Expense-claim
  receipts have an attachment guard (the claimant or view_all).
- **G-HR**: `PUT /leave/:id` (DRAFT, `checkLeave()` again — days, proof, a
  clash check that leaves the request itself out; submit runs it too, so two
  overlapping drafts cannot both go pending). `/g-hr/leave/:id` is a record
  page now (`LeaveRecord`), not a modal. An overtime filing awaiting
  authorisation changes through `PUT /overtime/:id` (withdrawn and re-sent in
  the employee's name in one move; refused if it could not be sent again —
  `assertRoutable()` mirrors the engine); once authorised the plan is fixed.
  Filed actual hours are pulled back with `POST /overtime/:id/withdraw`.
- **Service contract**: `PATCH /service-contracts/:id` (edit_own — the
  job's PM — or edit_all). DRAFT changes every term; ACTIVE re-plans the
  schedule in the same transaction (`planReplan`): once a generated visit has
  come due or been attended, start and frequency are fixed and only the end
  moves; a carried visit keeps its status, date, engineer and notes; a
  re-plan is refused while a visit it would move has a service report, and
  an end may not run into a renewal. EXPIRED/RENEWED/CANCELLED refuse. The
  claim is on status AND `updatedAt` (409 if anything moved in between).

### Budget requests: project cash (2026-10-07)

- **A budget request is PROJECT CASH, never a budget change** (the owner's
  definition: cash so the team can buy what it needs without a purchase
  requisition). `BudgetRequest` keeps its own table and its own name — it
  is NOT a cash advance, which is the company's term for a personal loan —
  but runs the advance's arithmetic on the project's money: DRAFT →
  PENDING_APPROVAL → APPROVED → RELEASED → LIQUIDATED (or REFUND_DUE while
  unspent cash is still out), plus REJECTED and CANCELLED. `routes/
  budgetRequests.ts`; `refreshBudgetRequest(tx, id)` in `shared/finance.ts`
  is the only thing that decides its figures and status, re-derived from
  the payment allocations (`PaymentAllocation.budgetRequestId`) and the
  approved liquidation. **Approval and release post nothing to the job**;
  the liquidation posts INCURRED at what was spent, through the ordinary
  expense-claim settle. Never write a BUDGETED row from a budget request
  again: the seed's `closeLegacyBudgetIncreases()` closes the ones approved
  under the old rule (released, spent and liquidated at their own amount on
  the day they were approved, a note saying so; their ledger rows stay) so
  they do not sit in finance's "to release" queue for ever.
- **The route is the routing sheet's since 2026-10-13**: Team Leader
  (the requester's "Reports to", else a Team Leader), Admin Back Support
  (the holders supporting the requester's team), Finance Manager, and the
  CEO / President above ₱100,000 — see "The routing sheet of 2026-10-13".
  The project's manager is no longer a step; "Budget Request — project
  manager then finance" is RETIRED. What follows is how that route worked,
  and how the engine's PROJECT_MANAGER type still works for the job order:
  step 1 was the engine's
  new **`PROJECT_MANAGER` approver type**: the manager the document's job
  names (`ApprovalRequest.jobId`, set by `submitForApproval({ jobId })`,
  read by `approversForStep(step, requesterId, tx, { jobId })` everywhere —
  submit, queue, act, history, slots, withdrawal), falling back to the
  step's role — **Executive** unless the step names another — when the
  project has no manager or the manager raised it themself (the owner's
  call: a PM's own request goes up, never to nobody). `audit-workflows.ts`
  checks the fallback is held and counts active projects with no manager;
  Admin › Approval Workflows offers "No project manager, or their own
  request: <role>". A test that settles a budget request passes the
  request's `jobId` to `approversForStep`, or the PM step resolves to the
  fallback and `act()` refuses the person it picked.
- **Finance releases it in one voucher**: `POST /payments` with
  `kind: 'budget_request'` (DISBURSEMENT, exactly the outstanding, the
  advance's one-voucher rule) and `budget_request_refund` (RECEIPT, unspent
  cash back, never a collection). The liquidation deadline is snapshotted
  at release from **`finance.rules.budgetRequestLiquidationDays`** — its
  OWN rule, beside the advance's (the owner's call), on the Finance
  Settings page. G-FIN › Money out › **Budget Requests**
  (`gfin.budget_requests`, READ; the finance role holds it) is finance's
  window on every project's requests — the same `budgetRequestListWhere()`
  the project tab reads, so the two cannot list different sets
  (verify-delivery asserts it); releasing is the A/P create right.
  `financePosition()` carries `budgetRequestsToRelease` and
  `budgetRequestsInHand` and subtracts the first from the working position,
  as it does the advances; the dashboard, the cash forecast and Insights'
  formula follow.
- **The liquidation is an expense claim naming the request**
  (`ExpenseClaim.budgetRequestId` — one of `advanceId` /
  `budgetRequestId`, never both, a 400). Only the person who raised the
  request files it, only once it is RELEASED, one live liquidation at a
  time, on the project and budget line the request was approved for.
  `claimPayable()` / `liquidatedReleased()` read whichever source the claim
  names; `LIQUIDATION_SOURCES` is the include every reader of a claim's
  payable needs. `NewClaimModal` takes `budgetRequest` beside `advance`; the
  Expenses register's "Liquidation" kind covers both.
- **The project's Budget Requests tab** (`ProjectBudgetRequestsCard` in
  `pages/delivery/BudgetRequests.tsx`, which also holds the register — one
  component in G-OPS's and G-FIN's dress — the request page and the form)
  shows requested, released, spent, out with the team, each request's
  liquidation and its approval chain. A request's own page is
  `/g-ops/budget-requests/:id` — the approval notification lands there —
  where the PM/finance decide, finance releases, the requester liquidates
  and refunds are recorded. The old "budget increase" is gone from the UI;
  `project_engineer` holds `budget_requests` own-scope so the team can ask.

### Finance: cash advances and liquidation

- **`refreshAdvance(tx, id)` is the only thing that decides an advance's figures
  and status**, re-derived from DISBURSEMENT and RECEIPT allocations and the
  approved liquidation, never incremented — so deleting a payment rolls it back
  exactly. Direction comes from `Payment.kind` (`allocationKind()`), never a
  second column.
- **An advance is released in one voucher**; `POST /payments` refuses anything
  but exactly its outstanding. The liquidation deadline is snapshotted at
  release from `finance.rules.advanceLiquidationDays`, so a settings change never
  moves a deadline already given.
- **`claimPayable(row) = max(0, total − advance.amountReleased)`** — everything
  that asks what is still owed on a claim goes through it, or the person is owed
  their advance twice. SETTLED is terminal.
- **Both settle handlers are idempotent and exported** (`settleExpense`,
  `settleAdvance`): a repeated settlement posts, notifies and audits nothing.
- **An expense claim is submitted with `requesterId: claim.claimedById`**, not
  whoever pressed the button — otherwise a super admin submitting for somebody
  could approve a claim they did not file. A refused submit reverts to DRAFT.
- **A refund is cash in, never a collection**: every "collected" aggregate
  filters `customerId: { not: null }`.
- **`financePosition(today)` in `shared/finance.ts` is the one definition of the
  working position** (receivable − payable − reimbursable − advancesToRelease).
  G-FIN's dashboard and Insights both read it; the cash forecast's totals equal
  it and both verify scripts assert that.
- **`GET /cash-advances/for-job/:jobId` is budget monitoring, not finance** —
  it requires `gops.budget_monitoring.view_all` and lives in `advances.ts` so
  `jobs.ts` imports nothing from finance. `/expense-claims/chargeable` is what
  the claim and advance forms load, not `/jobs/lookup`, which filers cannot see.
- **`Invoice.jobOrderId` is unique**, and `POST /invoices { jobOrderId }` refuses
  a warranty/contract order, an uncompleted one and a second invoice.

### HR: leave and overtime by id

- **A single leave or overtime record is readable by `view_all`, the owner, or an
  approver of that document** (`mayReadHrRecord` / `isApproverOf` in `hr.ts`).
  The approver door exists because a `view_own` supervisor must open what they
  are asked to decide. `GET /overtime/:id` had no own-scope check at all before.
- **`canCancel` / `canFileActual` mirror the POST routes' own checks** — change
  the flag with the route, or an approver is offered a button the route refuses.
- **A leave submit the engine refuses reverts to DRAFT**, never PENDING with no
  approval behind it. Every HR filing write audits.

### Hire-to-separate: plantilla, clearance, turnover

- **Filled and vacant are counted, never stored.** `plantillaSummary()` is the
  one definition; `Position` must never get a filled or vacant column.
  Over-complement is shown, not refused — refusing would block a real hire.
- **`Employee.position` is a mirror with one writer** — `positionFields()` /
  `setEmployeePosition()` and `mirrorPositionTitle()`. `verify-plantilla.ts`
  asserts the mirror for every linked employee in the database. A position anyone
  has held is deactivated, not deleted.
- **The import resolves in `build` and creates in `write`**, because `runImport`
  calls `build` on every dry run; a dry run creates no position and burns no
  number.
- **Clearance items that point at a record derive their status from it**
  (`scanAccountabilities()` / `syncClearanceItems()` on every GET and on submit).
  A derived item is waived with a reason, never cleared by hand; the leaver never
  clears their own.
- **Who may clear is one function, `areaRight()`**, used by the route and by the
  screen's `canClear` map. The requester is the leaver's own login where one
  exists, so step 1 is *their* supervisor and the self-approval rule keeps them
  off their own form; `hrSignsOwnWork()` refuses a submit when the raiser is the
  only HR holder.
- **Approval records the separation, and nothing else does.** The settle
  subscriber sets `dateSeparated` and deactivates employee and login once the day
  has passed; `sweepSeparations()` (on read) closes a login only behind a CLEARED
  clearance and otherwise asks an admin — a hand-typed date is one keystroke.
  Errors in the subscriber are logged, never thrown: the approval is the record
  of fact.
- **Turnover is arithmetic over employee dates, no table** — `turnover()` feeds
  the report, its CSV, the register strip and the dashboard, so they cannot
  disagree. An employee with no hire date counts from record creation, and the
  report says so.
- **`DELETE /employees/:id` 409s** once the employee has a clearance, evaluation,
  training record or attendance row — deactivate instead.

### Evaluations

- **Regularisation is an approved document, not a field edit** — the employee row
  changes only in the `onApprovalSettled('evaluation')` subscriber, after HR
  *and* executive. ABSORB keeps `dateHired`; END changes nothing and tells HR to
  raise a clearance.
- **Due is derived on read** (`dueEvaluations()` / `milestonesFor()`); an
  evaluation covers a milestone only if its `dueDate` is on or after it, which is
  what makes an EXTEND bring END due again. Reading `/due` notifies HR once per
  milestone, deduplicated on the link — there is no scheduler.
- **`visibleTo()` is the one rule**: the subject sees their evaluation only once
  APPROVED, and anybody else gets a **404, not a 403** — "there is an evaluation
  about you" is itself information.
- **The subject can never approve their own evaluation** — `/submit` refuses when
  any step's approvers include them, and the subscriber refuses to apply an
  approval any of whose actions they took, because roles change between
  submission and decision.
- **Ratings never reach the audit log** (a summary, null before/after —
  asserted), because admins read the audit trail and a rating is not between
  them. **Evaluations have no search provider**, deliberately.
- **Criteria are snapshotted onto `EmployeeEvaluationLine`** when the form opens;
  a key is permanent (rename freely, never reuse). The score is the weighted mean
  of RATED lines only. A RETURNED evaluation goes back to DRAFT; REJECTED closes
  it. There is no DELETE route although `ghr.evaluations.delete` exists — a
  numbered document is cancelled.

### Meetings

- **A meeting has no workflow, no PDF and no money**; it reuses `ActivityStatus`
  rather than a fourth vocabulary for the same three words.
- **G-Core holds no Google credentials.** `parseGoogleLink` is the only thing
  that decides what was pasted; `googleEventId` stays null until a Calendar
  integration is deliberately built.
- **Invitations go out on "Send invitations", never on save**
  (`MeetingInvitee.notifiedAt`). A time change bumps `icsSequence` and tells only
  those already told; cancelling bumps it too so the `.ics` withdraws the event
  under the same UID. The UID is the row id — never change it.
- **Once invitations went out a meeting cannot be deleted** (409, for `delete`
  holders too) — it is cancelled with a reason, because the record is what those
  people were told.
- **Visibility is one function, `visibleWhere(user)`**; a `view_own` holder who is
  not on the list gets a 404. Only the invitee answers for themselves.
- **The attendees agree the minutes** (2026-10-14, the owner's call:
  "approval of attendees agreeing the minutes" — only those who said
  Going). `Meeting.minutesStatus` DRAFT → FOR_AGREEMENT → AGREED,
  `minutesRound`, `minutesSentAt`, `minutesAgreedAt`; `MinutesAgreement`
  (meeting × round × user, PENDING / AGREED / CHANGE_ASKED with a
  comment), never deleted. `POST /meetings/:id/minutes/send` — the
  organiser or `edit_all` (`mayLeadMinutes`), written minutes, at least one
  invitee ACCEPTED (the organiser aside) — opens a round, each attendee
  told (`minutes.to_agree`); `POST …/minutes/respond { response, comment }`
  is the asked attendee's own (a change needs words), changeable while the
  round is open; the last agreement closes it AGREED and tells the
  organiser, as does every change asked (`minutes.answered`). Once sent,
  only the organiser changes the minutes, and a change sets the round
  aside (DRAFT, its rows kept) to send again. **Not the approval engine**:
  the minutes are a record the people who were there sign, not a document
  a role decides (rule 2 is about documents). `GET …/minutes/pdf` is the
  Minutes of Meeting paper (the meeting's Print): MEETING DETAILS,
  agenda, minutes, attendance, Prepared by and one ATTENDEE sign-off each,
  "Pending" until agreed. verify-meetings pins it.
- **Minutes of meeting** (2026-10-13, the owner's call: "so anyone can back
  track what have been talked about"): `Meeting.minutes`, `minutesAt`,
  `minutesBy` — ONE text, replaced whole by `PUT /meetings/:id/minutes`,
  in the **Minutes of meeting** card under the Agenda (written in the card,
  never a dialog). `minutesProblem()` is the one rule for the route and the
  page's `canWriteMinutes`: the organiser, anyone invited or `edit_all`;
  never before the start (409), never on a cancelled meeting (409). An
  empty save clears all three. Each save audits (the length, never the
  text); everyone on the meeting but the writer is told once per Manila day
  of edits ("Minutes: …"). The list and Ctrl+K search the minutes, list rows
  carry `hasMinutes`, and a project's Meetings & Records shows a Minutes
  column. Files stay on the Documents card. Attendance is still the
  invitees' answers — no roll call.
- **A place is tagged by a link** (2026-10-13, "allow Google Map tagging";
  no Google credentials): `Meeting.mapUrl` and `SalesActivity.mapUrl`,
  http(s) only (`safeHttpUrl`), pasted in the form's "Google Maps link"
  beside Where / Address, whose hint opens Google Maps on the place typed.
  `mapLinkFor(place, mapUrl)` (`shared/calendar-links.ts`) is the one rule —
  the link, else Google Maps' search for the address, else nothing — and
  `components/MapLink.tsx` its twin on the page ("Open in Google Maps ↗" /
  "Find on Google Maps ↗"). A tagged place rides in the meeting's `.ics` and
  Google hand-off description, the activity's hand-off and its invitation
  email ("Map: …"); `maskPrivate` hides an activity's map with its address.

### Academy

- **The passport is derived, never kept** — `lineState()`, `readinessFor()` and
  `teamReadiness()` are the only arithmetic, and expiry uses `expiryState()` from
  `shared/aftermarket.ts` (the warranty rule). Requirements match by id, never by
  title.
- **The record that answers for a course is the one that lasts longest**
  (`bestRecord`), so a renewal supersedes without deleting.
- **Two doors write a `TrainingRecord`**: `completeSession` (VERIFIED, number
  null, final; `@@unique([sessionId, employeeId])` makes completing twice
  impossible) and the external certificate through `training_certification`
  (`pickWorkflow` checked before `nextNumber` so a missing workflow burns no
  number). HR never records their own.
- **Changing a course's validity never rewrites an expiry on file** — the VAT
  snapshot principle.
- **The trainer is the owner** (`canEditRecord` on `trainerId`) and must hold
  `ghr.training_sessions.create`. **The calendar is company-wide; results are
  not** — someone who sees a session only through the calendar sees who is going
  and their own result.
- **Cancel, don't delete** a session anyone is enrolled on; a time or course
  change bumps the `.ics` sequence and tells attendees. Expiry notices are swept
  on read, once per record, claimed with a conditional `updateMany`.

### Insights

- **The brief reconciles to the module dashboards through their own functions**
  — `gopsOverview`, `chainOverview`, `attendanceDay`, `financePosition`. Change the
  shared function, never the brief; `verify-insights-brief.ts` asserts each figure
  against the module's endpoint. `attendanceDay()` IS the HR dashboard.
- **A figure the caller may not see is omitted, never sent as 0.** Each line
  needs that module's `*.dashboard.view_all`; the summary CSV needs
  `insights.dashboard.export` plus each module's `*.dashboard.export` — seeing a
  number is not the right to take a file of it away.
- **A range is Manila's days, with a pair of edges for each kind of column.**
  `parseRange()` returns `from`/`to` for `@db.Date` columns (UTC midnight, and
  23:59:59.999Z, still that day) and `fromAt`/`toAt` for timestamps
  (`decidedAt`, `createdAt`): Manila midnight to 23:59:59.999 in Manila
  (`manilaDayStart`/`manilaDayEnd`, `shared/day.ts`). `periodWhere()` does the
  same for G-OPS: `createdAt` from Manila midnight, `performedAt` (a DATE) from
  UTC midnight, both to the end of the Manila day. A timestamp given the DATE
  edges ran 08:00 to 08:00, so a quotation won at 07:00 on the 1st counted in
  the month before; a DATE given Manila midnight reads as the day before.
  verify-aftermarket pins the PM count, verify-insights-brief both edges and a
  quotation raised and won at 00:30.
- **CSV columns are appended, never reordered**, so a sheet built on an export
  keeps working.
- **Sub-industry reporting puts UNCLASSIFIED last**, and the sub-industry
  table sums to the report's own totals — asserted. (It grouped by the
  customer's industry until 2026-10-08, when the industry became the team.)

## The Help box: help tickets (2026-10-11)

The owner's call: "a help chat box so every user can raise a ticket for
improvement, allow them to screenshot the problem" — and "super admins
receive the tickets".

- **A "? Help" button in the top bar of every signed-in page, beside Sign
  out** (`components/HelpDesk.tsx`, mounted once in `Shell.tsx`'s top bar;
  2026-10-11, the owner's call — it sat bottom-right at first and was hard
  to reach). It opens a PANEL dropping down under it, never a modal — the
  page stays usable —
  with New ticket (Improvement / Something is wrong / Question, a subject,
  a description, the screenshot) and My tickets (`GET /help-tickets/mine`,
  each row opening the ticket's page). The draft lives as long as the
  Shell, so closing the box keeps what was typed.
- **The screenshot is taken in the browser** by `captureScreen()` in
  `lib/screenshot.ts`: the visible part of the page redrawn from its DOM by
  html-to-image as a PNG (the box and the toasts filtered out), no
  screen-sharing prompt, nothing sent until the ticket is. The library is
  a dynamic import — only the screenshot's chunk carries it. Take it
  again, remove it, attach an image or paste one (Ctrl+V); five pictures
  at most, images only (the route refuses anything else and deletes what
  multer wrote). `html-to-image` was added to `web/package.json` and the
  lockfile from the npm registry by hand, because `npm install` here
  re-resolves SheetJS from cdn.sheetjs.com, which this sandbox cannot
  reach; the server's install fetches both normally.
- **The API is `routes/helpTickets.ts`** (`/api/help-tickets`, `HelpTicket`
  + `HelpTicketReply`, numbering type `help_ticket`, GT-HT-2026-0001).
  Raising, reading and answering one's OWN ticket needs only a login;
  `admin.help_tickets.view_all` reads every ticket (Admin › Records › Help
  Tickets, its paper `GET /help-tickets/pdf`, any ticket and its
  screenshots) and `admin.help_tickets.edit_all` answers and moves the
  status (New → In progress → Done, or Won't do with a reason). No seeded
  role holds either. **Who is told of a new ticket is chosen by a super
  admin** (2026-10-11, the owner's call: "allow me to assign who receive
  the help ticket"): the "Who receives new tickets" card on Admin › Help
  Tickets (`PeoplePicker`), `GET/PUT /help-tickets/receivers` (above
  `/:id`; read with the view right, changed by a SUPER ADMIN only, active
  logins only, 50 at most, audited as `help_ticket` / `receivers`), one
  Setting `helpTickets.receivers` = `{ userIds }` in
  `shared/helpReceivers.ts`. **The people chosen hold both rights whatever
  their roles**: `resolveUser()` adds `RECEIVER_RIGHTS` for them (a
  per-user DENY still wins), so the menu, the page's Guard and the routes
  agree with no role edited; the list is cached a minute per process and
  dropped on save. **Nobody chosen is every active super admin** (bell,
  and email where SMTP is set) — holding the view right is not enough to
  be told. verify-workspace stashes the stored list in
  `helpTickets.receivers.__verify__` for its run and `cleanup()` puts it
  back. A reply tells the other side; a status move tells the
  raiser; **the raiser replying on a Done or Won't-do ticket opens it
  again** (NEW). Someone else's ticket is a 404. The page the person was
  on is kept only when it is a path inside the app; the browser line is
  shown to administrators only. Screenshots are attachments on
  `help_ticket` with a guard (the raiser or view_all) and a write guard
  that refuses the generic attachment routes. 20 tickets an hour per
  person (`shared/throttle.ts`).
- **One page for both sides**: `/admin/help-tickets/:id` (`HelpTicketPage`
  in `pages/admin/HelpTickets.tsx`, no Guard — the API decides), where the
  raiser and the administrators read the thread and reply; the bell links
  there. verify-workspace raises tickets as a user with no rights and
  cleans up the bells they rang for the real super admins.

## Accounts and sign-in

- **Employee and User stay two records (Phase 2), with ONE creation**
  (2026-10-10, the owner's call: "unite the creation of user and HR employee
  record"): a person is made as an employee with their login, `POST
  /employees { login }`, from both doors — Admin › Users "+ New user" (the
  login required, the form opening on it; or "an employee already on the
  register", which is `POST /employees/:id/login` — offered on
  `ghr.employees.edit_all`, the route's own right, which is why
  `/employees/lookup` admits `edit_all`) and HR › Employees "+ New
  employee" (the login tick on when the viewer may make logins, and can be
  unticked; the admin door's is locked on). **`POST /users` is gone**;
  `createLogin()` in `shared/accounts.ts` stays the one writer. The login
  mirrors the employee's number WHEN IT IS MADE (`User.employeeNo`, unique —
  a number an older login still carries stays there and the new login goes
  without, never a failed save; a later renumbering on the employee does
  not follow, and need not: `{EMP}` reads `Employee.employeeNo` first),
  copies name, department, position and mobile, and starts with the seeded
  `employee` role. Making a login needs `admin.users.create`, checked BEFORE
  anything is written, so HR without it saves the person and no half-made
  record is left — an administrator adds the login from the employee record
  or from Admin › Users; no seeded role gained the right. Both routes refuse
  a login for an inactive employee (400) and an unknown role, "Reports to"
  or department (400 naming the field as THAT body spells it —
  `login.roleIds` on `POST /employees`, `roleIds` on `/:id/login`) before
  writing, and `POST /employees` an unknown `userId` (404); `/:id/login`
  LOCKS the employee's row first (`FOR UPDATE`, the expense claim's rule —
  two at once used to leave the loser a 500 off `User.employeeNo`'s index,
  or both through with the first login orphaned) and claims the link
  (`updateMany` on `userId: null`), so the loser gets the sequential 409;
  it leaves an `employee` UPDATED row ("Linked the login …")
  beside the `user` CREATED one. `NewPersonModal` in
  `pages/masters/Employees.tsx` is the one form (`door: 'hr' | 'admin'`; a
  new record's Save follows the branch — `create` for a new person,
  `edit_all` for one on the register); `UserEditor` in
  `pages/admin/Users.tsx` only modifies.
- **A login email already in use says whose it is** (2026-10-13, the
  owner's report: "i can't add employee in the user" — Karen's login had
  been made before her employee record, and the form only said "Someone
  already uses that email address"). `assertLoginEmailFree()` in
  `routes/employees.ts` runs before anything is written on `POST
  /employees { login }` and `POST /employees/:id/login`: a 409 whose
  `details[0].existingLogin` names the login and `linkable` — true when
  it has no employee (the form then offers **Link the existing login**,
  the same save with `userId` in place of `login`, its roles and
  "Reports to" kept), false when it is another employee's (the message
  names their number: open that record instead). `createLogin()` keeps
  its own check for any other caller.
- **No password is typed for a new person — they are invited.** `invitePending`
  marks the account; its password hash is of random bytes nobody sees. The
  invitation (7 days), a self-service reset (1 hour) and an admin-issued reset
  (24 hours) are `AccountToken` rows holding only the SHA-256 of the token. The
  link carries it in the URL **#fragment** (`/welcome#token=…`,
  `/reset-password#token=…`), which no server log or Referer sees; the pages
  POST it. A link is claimed by a conditional `updateMany` (used once), the
  next of its kind supersedes it, and it dies with the account's `isActive`.
  Accepting or resetting kills every other live link of that person.
- **"Forgot password?" never tells whether an address has an account**: the
  answer is identical, the email is sent after it, requests are throttled per
  address and overall, and the link goes only to the mailbox — never back to
  the caller. With email off it makes no token at all.
- **`shared/mail.ts` is the one mail sender**, SMTP over Node's own sockets (no
  dependency): TLS on 465 or STARTTLS on 587, and it refuses to send the
  mailbox password over an unencrypted connection. Header values lose CR/LF
  (no injected Bcc), bodies go base64 UTF-8. `SMTP_*` in api/.env; unset
  `SMTP_HOST` = email off, and every issued link is returned to the
  administrator who issued it to pass on (`components/LinkDelivery.tsx`).
- **A person keeps their own contact details** through `/auth/profile`:
  mobile, address, birthday and emergency contact on their linked employee —
  never the employment, pay or statutory fields.
- **A person's team is `Employee.industryId`** — an Industry row (KAT, HIT,
  UIT, GIB, SIT since 2026-10-08; customers are no longer classified by
  that list); HR sets it on the employee form (or the import's `Team`
  column, by code or name, blank keeps what is on file). A team with people
  on it is deactivated, not deleted. **Team,
  position and employee number are SHOWN, never edited, on the invitation and
  My Account** (`hrFacts()` in `routes/auth.ts`, `components/HrFacts.tsx`): the
  employee number is the `{EMP}` in their quotation numbers and the position
  has one writer. `personalSchema` strips them, and verify-accounts sends them
  anyway to prove it. The invitation asks only for mobile, photo and birthday;
  address and emergency contact are kept from My Account.
- **`PasswordInput` is the one password box** (Show / Hide, a real button with
  `aria-pressed`). The signed-out pages (`/welcome`, `/reset-password`,
  `/forgot-password`) are `SIGNED_OUT_PAGES` in `App.tsx`, matched before the
  signed-in check.

## SCORO migration notes

Gruntech moved from SCORO. Customers came across through the ordinary CSV
import (`tools/scoro/scoro_convert.py`, a workstation-side Python converter
never installed on the server), and new work starts in G-CORE. SCORO's
quotations come across the same way, as REAL quotations (2026-10-10: "later
I will upload data of SCORO Quotation, it will act as part of the G-CORE;
also the invoices from SCORO which will become a Sales Order in G-CORE"):
the quotes export is built (below, 2026-10-11); the quote-lines export and
the invoices, which become sales orders, are still to come.
`docs/notes/{S,C,Q,R}-*.md` carry the detail of what was patterned on
SCORO.

- **The SCORO archive was removed on 2026-10-10** (the owner's call: "remove
  also scoro data"): `removeScoroArchive()` (`shared/scoroArchive.ts`), run by
  the seed on every deploy, empties `LegacyQuote` and deletes its PDFs once,
  audited (`legacy_quote` / `archive`, DELETED, marked in
  `seed.scoroArchiveRemoved`); the `LegacyQuote` model and its four relation
  fields went in the NEXT push (2026-10-11, once the owner said the first
  had deployed — db push cannot drop a full table, and the deploy pushes
  before it seeds), and the step now only sweeps the archive's leavings.
  verify-foundation pins the once-only rule on the archive's leavings (a
  `legacy_quote` PDF and a saved view — never a row of the retired table),
  parking the install's own mark in `seed.scoroArchiveRemoved.__verify__`
  meanwhile, as the tagline is. The seed logs the removal only when it
  removed something — the mark is stamped on a fresh install too.
  The quotations continued from SCORO keep their numbers as ordinary
  quotations, and `checkQuoteNumber()` no longer refuses an old SCORO number.
  The read-only screen, its `gops.quote_archive.*` keys, the search provider,
  Customer 360's "SCORO history", the import CLI and `verify-archive` are
  gone with it.
- **SCORO quotations arrive through the ordinary import** (2026-10-11, the
  owner's file: "could you add this to the database so I can check if it's
  possible to migrate data of SCORO from a CSV file"). The entity is
  `scoro_quotes` (`routes/imports/scoroQuotes.ts`, registered in `REGISTRY`,
  `gops.quotations.create`; the quotation list's ⋯ menu "Import from
  SCORO…" opens the ordinary `ImportModal` on it), and it takes SCORO's
  quotes export AS IT COMES: the columns are SCORO's own headers (`doc_no`,
  `payer`, `quote_name`, `doc_date`, `owner_name` …), matched by name, and
  the file is **UTF-16 LE with a BOM and TAB-separated** — `decodeCsv()` in
  `shared/csv.ts` decodes a file by its BOM (UTF-16 LE or BE, else UTF-8
  with its BOM stripped) and `parseCsv` sniffs the delimiter from the header
  line (`sniffDelimiter`: more tabs than commas is a TAB), so every import
  reads either kind; `POST /imports/:entity` decodes through it, never
  `.toString('utf8')`. SCORO's null date `0000-00-00 00:00:00` is empty
  everywhere. `build` RESOLVES and `write` CREATES (the plantilla import's
  rule): the **owner** is a login whose name equals `owner_name` case-blind
  with spaces collapsed — none is an ERROR ("No login named … — add them in
  Admin › Users first"), never an invented author; the **customer** is
  matched by SCORO id first (`(SCORO id 4798)` in its notes, as the company
  import wrote it — whole tokens), then by name or legal name case-blind,
  else CREATED by name alone in `write` (`nextNumber('customer', tx)`, the
  SCORO id in the notes so the next file matches it, no team, no
  sub-industry; a customer switched off is used as it is); the **contact**
  is one of the customer's by name, else added with the name alone. The
  **status map**: Opportunity, This Month Forecast, Hold → OPEN;
  Negotiation → SUBMITTED; Closing → NEGOTIATION; Confirmed, Completed,
  Confirmed Project → WON (revision 0 APPROVED); Rejected, Cancelled → LOST
  with `lostReason` "SCORO status: <name>"; unknown → an error naming it.
  Probability is the stage's odds (`stageProbability`), `submittedAt` the
  status-change date (else `doc_date`) once moved, `decidedAt` the
  confirmed date (else the status change, else `doc_date`) when decided.
  `doc_date` is the issue date — `createdAt` of the quotation AND its
  revision, a DATE at UTC midnight; `validityDays` is `doc_deadline` −
  `doc_date` (30 when either is missing); `vatRate` is `total_vat ÷
  total_sum` to four decimals (an imported rate is a fact, stored as read);
  a `currency` other than the company's is an error. **The file carries no
  lines**, so every quotation gets ONE summary line ("As quoted in SCORO",
  1 lot, under the group the file names — see below — else OTHERS) worth the subtotal BEFORE discount
  — `total_sum ÷ (1 − discount/100)` to the centavo — costed at
  `total_cost` so the margin reads as SCORO's, written through the exported
  `lineData()` and recalculated by `recalcQuotationRevision`. **The export
  with the LINE columns** (the owner's second file, 2026-10-11: one row per
  line, the header repeated on every row) is the same entity: the rows are
  grouped by `doc_no` — `ImportSpec.groupBy` / `buildGroup`, the
  framework's rule for ANY import whose record spans rows (`runImport`
  partitions the data rows by the key in first-seen order, case-blind,
  calls `existing` on a group's first row and `buildGroup` once per group,
  and reports ONE result per group, `row` the first row's number; a spec
  without `groupBy` behaves as before) — and a group with line content
  (`product_name`, `line_comment` or `line_id` on any row) gets its rows as
  lines in file order instead of the summary line: `is_subheading` 1 is a
  subheading of `product_name`, else of `line_comment` (the owner's quotes
  export of 2026-10-11 put all 25 of its subheadings' words there and left
  `product_name` empty, and the all-or-nothing import refused the whole
  file over it), and nothing else — one with neither is refused, naming the
  row; otherwise `group` =
  `product_group` as the import decides it (below), `title` =
  `product_name` whole (the three product boxes stay empty — SCORO's name
  is not reliably "brand, type, part"), `description` = `line_comment`,
  `quantity` = `amount`, `unit` (else "lot"), `unitPrice` = `price`,
  `unitCost` = `line_cost ÷ amount` to the centavo (SCORO stores the LINE's
  total cost; `lineData` recomputes `costAmount` = qty × unitCost, a
  centavo at most from SCORO's figure), the supplier named by
  `supplier_name` matched by name — or, with `is_internal` 1, the login
  named by `doer_name` — never created, one not on file kept in `costNote`
  ("Supplier in SCORO: …", joined to `cost_comment`); `vatRate` is the
  first priced line's `line_vat_percent` where it says. The quotation takes
  `doc_no` as its number and `write` calls `setCounter('quotation', number,
  tx, { mode: 'raise' })` — the series follows the highest imported number
  and is never lowered. **A number already in G-CORE is left as it is**
  (`existing` is the case-blind number; the row reports "update" and
  `write` skips it), so a re-run of the same file changes nothing — with
  ONE exception, the summary line's promise: a quotation whose revision 0
  is still DRAFT and holds exactly the one "As quoted in SCORO" line takes
  the lines of a file that carries them (the summary line deleted, the
  lines written, `rememberGroups`, `recalcQuotationRevision`, one
  `quotation` UPDATED row "Replaced the summary line with N lines from the
  SCORO lines export", in the row's transaction; the counter untouched);
  anything else existing is untouched. One transaction per row; the
  quotation's CREATED audit row names SCORO's quote id and, where a series
  moved, the counter; a created customer and contact get rows of their own
  ("… from the SCORO quotes import"). The route hands every writer the
  actor (`Registered.write(records, actor?)`) for exactly such rows.
  **A row the database refuses names itself** (2026-10-11, the owner's
  report: the dry run passed on the live server and the commit answered
  only "Something went wrong on our side"): each row's transaction runs
  with `ROW_TRANSACTION` (15 s to start, 60 s to finish — the shared
  server ran past Prisma's 5-second default), a customer it creates takes
  `nextNumber('customer', …, isTaken)` so a code already on file is
  stepped over, and any error in a row stops the import as a 400 —
  "Stopped at quotation <number>: <reason>. The N quotations before it
  were imported — run the import again to continue" — `rowFailure()`
  putting a Prisma refusal (P2002, P2028, P2003, P2000, P2020) in words,
  the full error still in the server log.
  verify-sales builds both files as SCORO writes them (UTF-16, tabs) and
  drives the spec and writer by name — the lines file's totals come out as
  SCORO's own; verify-masters pins the decoding, the delimiter and the
  grouping. SCORO's invoices, which become sales orders, are still to come.
- **A SCORO group not on the list is the importer's call, else OTHERS**
  (2026-10-11, the owner's call: "let me decide or set it as OTHER"). The
  import never adds a group to the master: a file's group matched by
  `groupKey()` to a listed (active) group takes the master's spelling;
  anything else is ASKED. `ImportSpec.summarize(records)` — the
  framework's hook for a question only the whole file can raise — puts
  `report.extra.groups` (`unlisted`: each group with its lines and
  quotations, `choices`, `fallback`) on the dry run, and `ImportModal`
  shows "Groups not on the list" with a "File under" select per group,
  OTHERS preselected; the commit posts `options` (JSON in the form,
  `{ groups: { <key>: <listed name> } }`), which the route hands the
  writer (`Registered.write(records, actor, options)`). A choice that is
  not a listed group is a 400 before anything is written; a group with no
  choice is OTHERS. The quotation's CREATED row records `groupsMoved`
  (SCORO's name → the group used). The summary line takes the file's
  `product_group` the same way.
- **The importer tags the file's quotations with a TEAM** (2026-10-12,
  the owner's call: "on SCORO import allow me also to select which team it
  goes or tag"). `Quotation.teamId` (an Industry row, nullable, SetNull) is
  the tag; **a quotation's team is its tag, else its owner's**
  (`quotationTeamWhere()` / `quotationTeamOf()` in `shared/team.ts`, the one
  rule) — the quotation list's Team view and "My team" share, its team
  cards and the Forecast's Team view all read it, so a tagged quotation is
  counted under its tag and never under its owner's team. The check asks
  (`summarize` sends `extra.teams`: the active teams and how many
  quotations the file holds; `ImportModal` shows "Tag with team", "— each
  owner's team —" first) and the commit's `options.team` answers: an ACTIVE
  team or a 400 before anything is written (`teamChoice()`). The file's new
  quotations take it (their CREATED row names it), and quotations ALREADY
  on file from the same file are re-tagged when the team differs (one
  `quotation` UPDATED row "Tagged with team KAT from the SCORO quotes
  import") — the one change a re-run makes to an existing quotation besides
  the summary line's replacement. No team chosen leaves a tag already
  there as it is. The quotation page shows a tag as "Team: KAT — tagged at
  import"; nothing else sets one yet.
- **An imported quotation needs no approval until somebody changes it**
  (2026-10-11, the owner's call: "the import from SCORO will not have
  approval details below the quotation, only the Prepared by; if they
  modify the quotation and save the changes, that's the only time they need
  the approval"). The import marks revision 0
  `QuotationRevision.importedUnchanged`; while it stands the PDF prints
  Prepared by alone (no route, no Pending), `GET /quotations/:id` offers no
  route or option, the page shows no Submit for approval but a one-line
  note, and Won is open to it — `standsApproved()` in `shared/pipeline.ts`
  (an APPROVED revision, or a DRAFT still as imported) is the one test the
  PATCH, the list's rows and the board ask. **A saved change clears it for
  good**: `PUT …/lines` (every Modify save), `PATCH …/revisions/:id` and
  "Fill from costing" — and a submit for approval; a status move does not. The Modify page says so in
  its lead line, and its own Status keeps Won behind a real approval, since
  its save clears the mark before the status is applied. The seed's
  `markUnchangedScoroImports()` marks quotations imported before the mark
  existed, where the trail shows no saved change to revision 0 (the
  summaries those three routes write); a changed one is never re-marked.
  The summary line's replacement leaves the mark as it finds it.
- **One quotation arithmetic: `shared/quotation.ts`.** `subtotal` is PRE-discount;
  net = subtotal − discountAmount; VAT on net (honouring `vatInclusive` and the
  snapshotted rate); margin is measured against net of tax, never a VAT-inclusive
  figure. `recalcQuotationRevision(revisionId, tx)` is the only writer of
  revision totals.
- **Cost never leaves unless the caller may see it** — `canSeeQuotationCost`
  (the author, `edit_all`, or `gops.costing.view_all`) strips `unitCost`,
  `costAmount`, the provider and `costNote` server-side, and the quotation PDF
  never reads cost at all.
- **The letterhead lives in the engine**: Tel/Fax, TIN, REG. NO. and the
  company's `documentTagline` print on every document when set; unset lines are
  left out — in `renderDocument`'s letterhead and strapline, and through the
  `company.*` fields (which `renderDesigned` reads itself) on the quotation's
  layout. The
  standard quotation layout prints no subject and no validity; both are fields
  an administrator can place. `PdfCell` (`string | { title, body? }`) is how a
  table cell prints a bold title over its description. Bank details are
  fields of the quotation layout, printed only where one is placed.
- **The quotation editor is a page, not a dialog** (SCORO's "Modify quote
  details"): `/g-ops/quotations/new` and `/g-ops/quotations/:id/edit`
  (`QuotationEditor.tsx`). **One save = one transaction** on create —
  `POST /quotations` takes the header AND `lines[]`, issues the number with the
  caller's `tx`, writes the lines in order and recalculates, so a refused line
  burns no number. Edit replaces a DRAFT's lines with the idempotent
  `PUT …/revisions/:revisionId/lines`. `ownerId` is honoured only for
  `edit_all` (403 otherwise). The page's live figures come from
  `web/src/lib/quotationMath.ts`, a BigInt mirror of `quotationTotals` pinned
  equal by `verify-sales.ts` — not a second rule. The editor's costing preview
  is `GET /quotations/costing-lines`, the same `quotationLinesFromSections()`
  that `from-costing` writes. **The old `?new=1&leadId=&costingId=&customerId=`
  links redirect** to `/new` with the same preset; new links point at `/new`.
  `docs/notes/quotation-editor.md` has the detail.
- **The quotation page is SCORO's "Quote details"** (`QuotationDetail` in
  `pages/sales/Quotations.tsx`): SCORO's labels in two columns, under the
  record header every record has (rule 19, 2026-10-09): next steps (Submit
  for approval, Mark as sent, Create Sales Order, Request job order, Create
  project — one primary), Print, ⋯ (Duplicate, New revision, Fill lines
  from costing, Mark lost with its reason, Delete) and Modify right-most.
  SCORO's old action bar across the card's foot, "Edit lines" and the
  per-line Modify are gone (each was a second way to the same editor). Its status block (Previous status, who
  moved it and when, Date confirmed, Sent, days per status) is
  `outcomeChanges()` / `outcomeStages()` in `shared/pipeline.ts`, read off the
  quotation's audit rows — there is no history table. The PATCH writes each
  move as `before/after: { outcome }`; older rows are read from the summary
  `…: FROM → TO`, so never reword that summary. **Duplicate** is the editor's
  `?duplicate=&revision=` preset: customer, contact, site, name, terms and lines
  (cost only where the viewer was sent it), never the PR number, enquiry or
  costing; nothing is written and no number used until Save.
- **The editor is SCORO's "Modify quote details" too**: one card, labels
  beside their values (`.qe-rows`), the contact beside the customer, quantity
  beside unit, SCORO's grey with-VAT figure under each amount (shown, never
  stored), the person/building toggles for who carries a line's cost, and Add
  row / Append quote under the lines. **Append quote** pulls another
  quotation's newest revision's lines through the ordinary list search and
  `GET /quotations/:id`, so it finds only what the viewer may read and brings
  cost only where the server sends it. **Status** on the Modify page is applied
  on Save through the same `PATCH /quotations/:id` and `assertOutcomeChange`
  as the quotation page and the board — never a second move path.
- **The Tax dropdown is `vatRate` on the revision: the company rate, 8%, 6%
  (Government) or 0%** (a zero-rated PEZA/BOI customer or an export) —
  `quotationTaxOptions()` / `QUOTATION_EXTRA_TAX_RATES` in `shared/quotation.ts`,
  sent to the page as `taxOptions` so the dropdown cannot drift from the rule —
  checked by `checkVatRate()`
  before anything is written so a refused rate burns no number; a draft may
  keep the rate it was snapshotted with. A new revision copies it. **Progress
  billing still takes the company rate** (`routes/progress.ts`), so a job won
  from a zero-rated quotation is billed VAT — an open item: billing should
  read the rate of the revision the job came from.
- **The discount is to six decimals** (2026-10-08): `discountPct` is
  `Decimal(9,6)` on the revision and the sales order;
  `quotationTotals` and its mirror return it to six. **SCORO's discount
  calculator** is `DiscountCalculator` in `editorParts.tsx`, opened by the
  Σ beside the Discount box on both editors — in the page, never a dialog:
  Excl tax / Incl tax, the sum as it stands, the sum wanted (type in either
  column, the other follows), the discount to six decimals and "Sum after
  discount" — the exact figure that percentage gives through the mirror's
  own arithmetic, the nearer of the floor and the ceiling at six decimals —
  then Insert puts it in the box.
- **A quotation has a CURRENCY of its own, PHP by default** (2026-10-11,
  the owner's call: "interchangeable, but by default PHP").
  `Quotation.currency`, one of `QUOTATION_CURRENCIES` in
  `shared/quotation.ts` (PHP, USD, EUR, JPY, SGD, CNY, GBP, AUD, HKD —
  anything else is a 400), picked in the editor's Currency select (the list
  comes from `/next-number` and `GET /quotations/:id` as `currencies`).
  Every figure of every revision is in it and NOTHING is converted: the
  page, the list's Total and Margin cells, the PDF ("Total Price (USD):",
  the line table's head) and its sales orders, which print in their
  quotation's currency (`order.quotation.currency`). The PATCH refuses a
  change once a revision is APPROVED or PENDING_APPROVAL, or a live sales
  order booked it. The SCORO import takes the file's `currency` when it is
  listed (blank is PHP). **The open item**: summaries that ADD quotations —
  the list's Sum and team cards, the board, the forecast, Sales Analytics —
  still add figures as they stand, so a USD quotation counts as that many
  pesos there; the printed lists name a foreign currency beside its figure.
  Converting needs exchange rates the owner has not decided on.
- **`hideTotal` ("Hide total") only changes the paper**: the PDF prints the
  lines and prices without the totals block; the stored totals are computed
  as always, and a new revision copies the flag.

## Quotation module rework (2026-10-01)

- **No dialog anywhere in the quotation module.** Modify always opens
  `/g-ops/quotations/:id/edit`: the full editor on a DRAFT, or — when no
  revision is a draft — `QuotationDetailsEditor` (number, name, contact, site,
  closing date, status) with "Raise a new revision" to change the lines. Lost
  asks its reason in the confirm bar, Delete asks there too, Append quote is
  a panel, "Fill from costing" asks in the bar and leaving unsaved changes
  asks in the Shell's leave bar (rule 19).
- **The quote number may be typed by hand, and the series FOLLOWS it**
  (2026-10-10, the owner's call: "remember the manual edit, start there from
  the last edit"). `number` on `POST` and `PATCH /quotations/:id`, checked by
  `checkQuoteNumber()` — shape, then case-blind against every quotation. A
  duplicate is a 409 before anything is written, so it burns no number and
  moves no counter. A typed number that fits the template's own pattern
  names its series — `parseNumber(template, prefix, number)` in
  `shared/numbering.ts`, the inverse of `renderPattern`: the number's OWN
  year, month and employee digits give the counter row's key (`2026@001`;
  a number typed under a colleague's digits moves the colleague's series,
  which is the number's) and its SEQ — and `setCounter('quotation', number,
  tx, { mode: 'set' })`, the one writer of a counter from a number, puts
  that row AT the typed SEQ, raising or LOWERING it, inside the create's or
  the renumbering's transaction after the uniqueness check and the row
  itself (a refused number rolls it back). So the next automatic number is
  the typed one plus one. A number outside the pattern's shape (`ZZQ-12`) is
  used as typed and moves nothing — and the shape is TIGHT: `{EMP}` is
  what `employeeToken` yields (three digits, or wider and not starting with
  0) and `{SEQ}` is never 0, a place no counter stands at, so a typo such
  as `0012613060` (a thirteenth month) or SCORO's 8-digit `12610060` is
  outside it and moves nothing, never re-read as another employee's year
  (the review of 2026-10-10; verify-numbering pins both on the house
  pattern itself). `mode: 'raise'` (a conditional `updateMany`, never lowering) is
  for the coming upload of SCORO's quotations, whose numbers must leave every
  series at its highest. Both audit rows say "the series continues from it"
  and carry `after.counter` (`periodKey`, `before`, `after`) when a series
  moved. Unsent, the next number comes from `nextFreeQuoteNumber()`, which
  still STEPS OVER taken numbers (a lowered series lands on numbers already
  issued; a colleague's digits may sit ahead) — `nextNumber(…, isTaken)`'s
  own walk: the increment first (the row lock that keeps two saves apart),
  then ONE read per candidate rendered in hand and one write landing the
  counter on the number issued, so a thousand candidates fit the save's
  transaction (re-running the whole issue per candidate used to outrun its
  five seconds and answer 500 before the 409); `FREE_NUMBER_TRIES` (1,000)
  of them and the save is a 409 naming Admin › Numbering, rolled back with
  the counter — verify-sales takes a thousand and one real quotations
  through it; `previewNext(..., isTaken)` walks on the same budget. `/next-number` also returns
  `lastNumber` and `taxOptions`; `/number-available` answers the page as the
  number is typed; the editor's hint says the series continues from a typed
  number, and so does the Admin › Numbering page.
- **A line may be a subheading** (`QuotationItem.isHeading`): its title is the
  heading; `lineData()` stores it with no quantity, price, cost or provider,
  whatever was sent. `quotationTotals` (and the `quotationMath` mirror) leave
  it out of `lineCount`. A line keeps its SCORO group in a Group column of its
  own, on the editor and the quotation page. **The PDF never prints a group
  as a heading** (2026-10-06, the owner's call, after SCORO's own PDF): only
  subheadings are heading rows, and a group prints only in a Group column the
  layout places. A product cell is the title in bold over its description.
- **Probability is no longer asked for.** A new quotation takes its lead's
  probability, else 50; the weighted pipeline still reads the stored value.
- **Delete** is `DELETE /quotations/:id`: `gops.quotations.delete` (the sales
  role holds it) AND authorship (`canEditRecord`); refused when won, built into
  a project or a job order, or pending approval. A lead left with no
  quotation steps back to COSTING (it has a costing) or QUALIFIED, audited.
  **Purge is the super admin's way out for sample data** (2026-10-11):
  `DELETE /quotations/:id/purge` (⋯ "Purge (sample data)", offered only
  where Delete is refused) removes the quotation WITH its sales orders,
  job orders and the projects built from its revisions, in one
  transaction, withdrawing open requests through `cancelOpenRequest`. It
  refuses — naming what blocks it — while an invoice, supplier bill, PR,
  PO, stock issue, claim or advance is filed against the project or an
  invoice against a job order; any other foreign key it meets rolls the
  whole purge back as a 400. One DELETED audit row names what went.
- **Optional approval routes are data.** `ApprovalWorkflow.optionLabel` marks a
  route the submitter may tick; `pickWorkflow` never picks one unasked;
  `approvalOptions(type, amount)` lists those in band; `submitForApproval({
  optionId })` uses it or refuses. Seeded: "Quotation — over ₱1,000,000, with
  the CEO" (Sales Manager → CEO approval, role executive), offered as "Add the
  CEO as approver". A refused submit puts the revision back to DRAFT.
  `approvalSlots(type, id)` lists every step of the latest request — the PDF
  prints one APPROVED BY per step, "Pending" until it acts.
  Admin › Approval Workflows edits the label ("Offer as an option"); a PUT
  that does not mention it keeps it, because clearing it by omission would
  make the CEO a step every quotation over a million takes.
- **A quotation goes to the salesperson's supervisor first** (2026-10-06,
  the owner's call). Both seeded quotation workflows open with a SUPERVISOR
  step whose `roleId` is `sales_manager`: **on a SUPERVISOR step, `roleId`
  is the fallback** when the requester has no "Reports to" — HR when it is
  null, which is every other supervisor step (leave, overtime, claims,
  advances) and must stay so. `approversForStep()` is the one rule; Admin ›
  Approval Workflows offers "No supervisor set: <role>" on such a step, and
  `audit-workflows.ts` checks the fallback role is held. The seed's
  `previously` moved a workflow that has routed documents only where its
  steps were still exactly as first seeded, updating the step rows in place
  by sequence (an open request stays at its step; past decisions keep their
  step). **Set "Reports to" for every salesperson** — without it their
  quotations go to whoever holds Sales Manager.
- **Who decides is named before they decide** (2026-10-02). In
  `shared/approvals.ts`: `namedApprovers(step, requesterId)` — the step's
  approvers by name, NEVER the requester (act() refuses them; empty means
  nobody can, and submit refuses); `routePreview(type, amount, requesterId,
  optionId?)` — the route a draft WOULD take; `approvalSlots(…, draft?)` gives
  an open or draft step `assigned` people while `name`/`at` stay "who signed,
  when"; `historyFor()` adds `approvers` to the open steps of a PENDING
  request. The quotation page shows "Submit for approval sends it to …" in a
  card under the header (`approvalRoutes` on `GET /quotations/:id`: the standard
  route and each option's, names only, the caller as requester) and switches
  to the CEO route when it is ticked; the Approval panel says "Waiting on …"
  and "Then …". The PDF names who will sign each open step with "Pending"
  under them — one person with their contact lines, several as "A or B" with
  none — and a draft's PDF prints the route submitting would take; the PDF
  button passes the ticked option as `?option=`, and one that no longer
  applies falls back to the standard route.
- **A pending revision can be pulled back to draft** (2026-10-07, the
  owner's call): the author (or `edit_all`) on the Modify page — "Pull it
  back and edit", asked in the confirm bar — calls `POST
  /quotations/:id/revisions/:revisionId/withdraw`, which claims
  PENDING_APPROVAL → DRAFT with a conditional `updateMany` (a decision that
  lands first wins and the route says so) and withdraws the open request
  through `cancelOpenRequest`, telling the approvers. The SAME revision
  returns to draft — no revision number burned on a document the customer
  never saw; raising a new revision stays the path once anything was sent.
- **A revision superseded while PENDING_APPROVAL takes its request with it**
  (2026-10-02). `POST /quotations/:id/revisions` calls
  `cancelOpenRequest('quotation', revisionId, tx, reason, actorId)` in the same
  transaction: the request closes CANCELLED (kept, never deleted), audited,
  and its approvers are told (`approval.withdrawn`; the requester too when
  someone else raised the revision). Left open, it sat in My Work for good —
  GT-QT-2026-0161 R0–R2 on the laptop — and approving it resurrected an
  outdated revision. The settle subscriber applies an outcome only to a
  revision still PENDING_APPROVAL (a conditional `updateMany`); a late decision
  changes nothing, and the quotation's trail says "… not applied". The seed
  runs `withdrawStaleQuotationApprovals()` (`shared/quotation.ts`) on every
  deploy: a quotation's request is open only while its revision is
  PENDING_APPROVAL. Idempotent; a second run withdraws nothing.
- **`GET /quotations/suggest?q=`** offers past lines (newest price, unit,
  description, use count) from quotations the caller may read, a line's cost
  only where `canSeeQuotationCost` allows, and items with their list price
  (standard cost only with `gops.costing.view_all` or `gchain.items.view_all`).
- **The quote name and the product boxes are CAPITALS** (2026-10-11, the
  owner's call). The boxes show what is typed in capitals (`.caps-input`,
  `.qe-product-parts input`: `text-transform`, placeholders left alone)
  and the server STORES capitals: `quotationSchema.subject` and
  `lineData()` go through `upperText()` / `capsParts()` in
  `shared/quotation.ts` (the sales order's lines too), and the SCORO
  import's `quote_name`. `upperText` leaves a character whose capital is
  not one Latin-1 character as typed ('µ' — the PDF fonts are WinAnsi, the
  rule `caps()` keeps); `web/src/lib/caps.ts` is its copy, pinned equal by
  verify-sales. Nothing on file is rewritten: an old quotation's name and
  lines take capitals the next time they are saved.
- **A line is ONE row, as SCORO edits it** (2026-10-02): Group | Product and
  description | Quantity and unit | Unit price | Amount (with-VAT under) |
  Cost and provider info (toggles and provider, then notes beside the unit
  cost) | Margin. **The product is three boxes** (2026-10-08, the owner's
  call): Brand, Product type and Part number — `QuotationItem.brand`,
  `productType`, `partNumber` (and the same three on `SalesOrderLine`,
  copied at booking) — and `title` is their sentence, "SCHNEIDER ELECTRIC,
  CIRCUIT BREAKER, EZC100H3030", empty parts left out: `productTitle()` in
  `shared/quotation.ts`, the one writer, mirrored by `productSentence()` in
  `editorParts.tsx`; every reader of a line (the PDFs, the quotation page,
  search, the suggestions) keeps reading `title`. A line typed before the
  boxes keeps its title and shows it in Product type. `ProductCells` in
  `editorParts.tsx` is the cell for both editors: Brand and Product type
  offer what was used before (`GET /quotations/suggest/fields?field=&q=&
  brand=` — a type under its brand first; Brand also the partners' brands
  and the groups'), Part number offers past lines and item-master part
  numbers (`/quotations/suggest` matches any of the three) and a pick fills
  all three with the description, unit and price (`partsFromSuggestion`). Every column but the product has a fixed width, so the
  product takes what is left; narrower than the table's minimum, the table
  scrolls inside its card. Never split a line's cost onto a row of its own.
  Labels and values share one size (`--fs-md`) on both pages. The quotation
  page has no Margin card — the cost panel beside the totals says it. **A
  line with no provider says nothing about it** (2026-10-08, the owner's
  call): no "No provider named" caption in the editor's cost cell nor under
  a line on the quotation page; the cost panel's third row is "Unassigned
  cost", shown only while there is some. **The product column's head is
  "Brand | Prod. | Part No."** and the description is a placeholder in its
  box, not a word in the head (2026-10-09, the owner's call, to squeeze the
  table; the table's minimum is 90rem). **The cost cell is the owner's
  layout** (2026-10-09, his picture): the two toggles and the person or
  supplier on one line ("Who carries the cost" while none is named), then
  the **unit cost beside the total cost**, each captioned, then Notes.
  Either cost box may be typed: a typed total sets the unit cost to
  total ÷ quantity to the centavo (`CostCell` keeps the typed total while
  the box has focus and shows the derived one after); only the unit cost
  is sent and the server derives the amount, as before.
  **A supplier not on file** (2026-10-13, the owner's call): once the
  provider lookup has answered for what is typed, the menu ends with
  "add “X” as a new supplier" for a `gchain.suppliers.create` holder (the
  ordinary `POST /suppliers { name }`, then picked — the seed gives the
  right to sales, sales managers, team leaders and industry specialists),
  else "keep “X” as a note on this line", which writes `Supplier: X` into
  the line's cost note (`withSupplierNote()`, `web/src/lib/supplierNote.ts`,
  the SCORO import's words) and adds nothing to the master; "could not be
  listed" when the lookup failed — SupplierPicker's rules, in
  `ProviderLookup` (`editorParts.tsx`), so the sales order editor has it
  too.

## Quotation groups (2026-10-06; required since 2026-10-08)

- **`QuotationGroup` is a list, not a reference.** A line keeps its group
  as text (`QuotationItem.group`); the master (Admin › Categories ›
  Quotation groups, `/api/reference/quotation-groups`, `admin.categories.*`
  to change, anyone signed in to read) is what the editor's Group
  **dropdown** offers (active ones) and what "By group" names. `key` is the
  name trimmed, single-spaced and lower-cased: one group per spelling.
  Renaming a group never rewrites a saved line.
- **A group can be deleted, and its lines go to OTHERS** (2026-10-11, the
  owner's call: "allow me to delete also the group in the category").
  `deleteGroup(tx, group)` in `shared/quotationGroups.ts` moves every
  quotation line and sales order line filed under it — any spelling, by
  `groupKey` — to `FALLBACK_GROUP` (OTHERS), deletes the row and records
  its key in the `quotationGroups.deleted` Setting, so `seedOwnerGroups()`
  never brings one of the owner's twelve back; adding a group of that name
  again clears the mark. OTHERS itself cannot be deleted (the route and
  the Categories card both say why). The question in the modal says how
  many lines will move; the audit row says how many did.
- **Every priced line names its group** (2026-10-08, the owner's call: "it
  should be selected or else the quotation cannot be proceeded"). The
  editor refuses to save a line without one — a `<select>` of the master,
  and since 2026-10-11 ("don't proceed save of quotation if the group are
  not selected") a group NOT on the list is refused too (`groupProblem()`
  in `editorParts.tsx`, both editors; the line's old group stays visible
  as "— not on the list" so the person sees what to change). **The API
  refuses the save as well**: `checkLine()` in `routes/sales.ts` answers
  "Line N: Choose a product group" for a priced line with none, on `POST
  /quotations` and `PUT …/lines`, before a number is issued. Submit for
  approval (quotation and sales order) still refuses a priced line without
  a group — the gate for a quotation filled another way (from a costing),
  and `rememberGroups` still adds a group an API caller names.
- **A group carries what it covers and a brand** (`description`, `brand`):
  the description is the dropdown's hint under the choice; picking a group
  fills an empty Brand box with its brand. `OWNER_GROUPS` in
  `shared/quotationGroups.ts` are the owner's twelve — OMEGA AIR …
  HORIBA, each with its line of business and its name as brand, then
  GRUNTECHNOLOGY, GRUNTECH SERVICES and OTHERS with none — seeded in his
  order by `seedOwnerGroups()` on every deploy: a group already on file is
  kept, and only what is blank on it (description, brand, a sort order of
  0) is filled. An administrator's spelling or wording is never overwritten.
- **Every save that writes a line calls `rememberGroups(tx, names)`**
  (`shared/quotationGroups.ts`) — create with lines and replace lines
  (the single-line add/edit/delete routes went on 2026-10-10: nothing
  called them) — so a group typed on a quotation joins the master with
  nobody filing it first. `createMany … skipDuplicates`: an administrator's
  spelling or a deactivated group is never overwritten. The seed's
  `seedQuotationGroups()` adds the groups lines already use.
- **"By group" in Sales Analytics splits each quotation's value across its
  value revision's groups in proportion to the line amounts**
  (`groupShares()` in `shared/pipeline.ts`, exact in centavos, remainder on
  the largest share; subheadings left out; no priced line → "No group"), so
  the table adds up to the report's own quoted and won figures —
  verify-insights asserts both. Every active group is listed, even at zero;
  "No group" is last. The pipeline CSV appends a Groups column. Verify
  scripts tag their test groups (`ZZSALES …`) and delete them by `key`.

## Approval by who prepared it (2026-10-11; one route since 2026-10-12; six documents since 2026-10-13)

The owner's routing sheets ("APPROVAL ROUTER — SALES ORDER AND QUOTATION", then
`APPROVAL_ROUTE.xlsx` for six documents).

### The routing sheet of 2026-10-13 — six documents, one signature per person

The owner's `APPROVAL_ROUTE.xlsx` (`docs/notes/P-approval-routes-2026-10-13.md`):
every row of a block names the same approvals whoever prepared it, so each
document is ONE route (two where an amount band adds the CEO / President),
every one with `preparerSigns` and `standIns`:

| Document | Route | Retired |
|---|---|---|
| Quotation | Team Leader; CEO / President above ₱1,000,000 | — (unchanged) |
| Sales order | Team Leader › Back Support › Cost Controller › CEO / President | — (unchanged) |
| Costing | Technical Manager › Team Leader | "… team leader, CTG" |
| Purchase requisition | Technical Manager › Team Leader, no band | the ₱50,000 bands |
| Purchase order | Purchasing Manager; CEO / President above ₱100,000 | "… project manager then finance" |
| Budget request | Team Leader › Admin Back Support › Finance Manager; CEO / President above ₱100,000 | "… project manager then finance" |

"More than" is strict: ₱100,000.00 takes the shorter route (`minAmount`
100,000.01 on the longer one; verify-chain and verify-delivery pin the
edge). A Team Leader step is the preparer's "Reports to", else a Team
Leader on their team, else any (`leadersFor`); Back Support is team-scoped
(`supportersFor`). **A Technical Manager step goes to the Technical Manager
on the preparer's own team** (2026-10-13, the owner's report: Ivan's HIT
costing waited on every Technical Manager, where Ricardo alone handles
HIT): `OWN_TEAM_ROLES` in `shared/approvals.ts` (`technical_manager`) sends
a ROLE step naming it through `leadersFor` — the holders whose
`Employee.industryId` (the Team on Admin › Users) is the preparer's, else
every holder, never nobody. It covers the costing, the purchase requisition
and the Request for Approval alike, and reads live, so a request already
pending follows it. A Technical Manager with no Team is only ever the
fallback. Back Support follows the same rule, its "Supports teams"
ticks replacing the holder's own team (`supportersFor`).

- **Two new roles**, seeded from the role whose work they manage:
  `purchasing_manager` **Purchasing Manager** (Procurement's rights) and
  `finance_manager` **Finance Manager** (Finance's, plus raising budget
  requests). Procurement and Finance stay for the staff. **Assign both in
  Admin › Users** — until then purchase orders and budget requests stall
  at their steps, and `audit-workflows.ts` says so.
- **The preparers on the sheet can prepare**: Industry Specialist,
  Technical Manager and Team Leader raise purchase requisitions; Industry
  Specialist, Team Leader, Back Support and Finance Manager budget
  requests; Back Support purchase orders (with the requisitions, canvasses
  and suppliers it reads); a Technical Manager costings. Each approver
  reads what it signs (`*.view_all` on the Technical Manager, Team Leader
  and Back Support roles), so the Approval panel on the document is
  reachable. The never-offered rule carries every pair to the live install.
  `audit-workflows.ts` knows the new typical requesters.
- **One signature per person — the approver's turn** (the owner's call:
  "the time stamp of the same employee with multiple roles … make it
  uniform, just like on the quotation and sales order"). The preparer's
  rule of 2026-10-12 signs at submit; this is its other half, in `act()`:
  on a route with `preparerSigns`, an Approve also signs every LATER
  unsigned step the decider may decide in their own right
  (`approversForStep`), in turn or out of it — a Team Leader who is also
  Finance Manager signs steps 1 and 3 of a budget request while Back
  Support's step 2 still waits — each an `ApprovalAction` with
  `coSignedWith` (the sequence pressed) and the SAME `actedAt`, one
  APPROVED audit row each ("Finance Manager — Maria Santos, signed with
  Team Leader (holds both)"). `currentSequence` moves to the first step
  still unsigned; none left settles it through the same subscribers.
  Never as a stand-in (a stand-in signs only the step they stood in for),
  never on a return or a rejection, never on a route without
  `preparerSigns` — a supervisor who is also HR is still asked as HR. A
  co-signed step is never queued or told. `ApprovalSlot.coSigned` marks
  it, so every paper prints one name with one timestamp; the Approval
  panel reads "<name> · signed with <step> · <when>". Admin › Approval
  Workflows calls the switch **"One signature per person"**. The purchase
  request's, purchase order's and budget request's (and cash advance's)
  first slot now prints `preparedAt(slots) ?? createdAt`, as the
  quotation's, the sales order's and the costing's do.
- **The quotation's paper prints each person ONCE** (2026-10-13, the
  owner's call: "if the creator name appears on Team Leader and CEO /
  President, make it appear in the print out as Prepared by only … one
  name only; only show the Team Leader"). `onePerPerson(slots,
  preparerId)` in `shared/approvals.ts` (slots carry the signer's
  `userId`) drops a slot signed by somebody already on the paper — the
  author's own steps are their Prepared by, an approver's co-signed steps
  their first signature — and an open step somebody already on it may
  sign (they will co-sign it). Only the paper changes: the request keeps
  every signature and the Approval panel every step. The quotation's
  `quotationPrintData()` alone applies it; the sales order, costing and
  the rest still print a slot per step.
- **Several roles on one person** needed nothing else: every step is
  judged by every role held, at submit (`heldSequences`), at eligibility
  (`approversForStep`, `deciderFor`) and in the team fallbacks.

### The routing sheet of 2026-10-12 — what holds now

The owner's updated sheet gives EVERY preparer (CEO / President, Team
Leader, Industry Specialist) the same route: **Quotation** — Team Leader,
and the CEO / President too over ₱1,000,000; **Sales order** — Team Leader,
Back Support (its step's name since the owner's slide of the same day,
corrected in place through `previously`), Cost Controller, CEO / President. The four routes keyed
to a preparer's role (below, 2026-10-11) are in the seed's RETIRED list;
`requesterRoleId`, `pickWorkflow`'s preparer logic and the "Prepared by"
field stay as data an administrator may still use. Three rules came with it:

- **The preparer signs the steps they hold, at submit, with the Prepared-by
  timestamp** ("if a person holds the Team Leader, Technical Manager, they
  appear the time stamp as one … the CEO … may create a quotation or sales
  order, while on the last approval he will also approve").
  `ApprovalWorkflow.preparerSigns` turns it on per route — seeded on the two
  quotation routes, the sales order route and the costing route, once
  (`seed.preparerSignsApplied`; an administrator who unticks it keeps it
  unticked) — and NEVER engine-wide: a leave request or an expense claim
  must not be signed by the HR or finance person who filed it. A step is
  HELD (`holdsStep()` in `shared/approvals.ts`) when the requester holds the
  role it names — a ROLE step's, or a SUPERVISOR step's fallback ("Team
  Leader" is the `team_leader` role, whoever the preparer reports to) — or
  is the person a USER step names; never a PROJECT_MANAGER or HR step.
  `submitForApproval` writes, in the request's own transaction, one
  `ApprovalAction { action: APPROVED, selfSigned: true, actedAt:
  request.createdAt }` per held step, one APPROVED audit row each ("Team
  Leader — Maria Santos, signed at submit (holds the step)"), and sets
  `currentSequence` to the first step NOT held; every step held is approved
  on submit (closed at that instant, settled through the same
  subscribers). `act()` passes over a signed step when it moves on (the
  CEO's own sales order settles on the Cost Controller's signature), and
  rule 3 is untouched: nobody presses Approve on their own document.
  **One timestamp**: `ApprovalSlot.selfSigned` marks such a slot, and
  `preparedAt(slots)` is what "Prepared by" prints when there is one — the
  quotation's, the sales order's and the costing's paper — so the two
  signatures read the same instant; a draft's preview carries none and
  keeps the document's own date. The route preview marks a held step
  (`held`; `routePreview`, `routeBrief`), so "Submit for approval sends it
  to …" says "You — signed when you submit" (`previewSteps()` in
  `components/ApprovalStepper.tsx`, both pages), and where every step is
  the preparer's: "No one else's approval needed — you hold Team Leader".
  The Approval panel reads "Carter Gasiong · signed on submitting · …".
- **A manager may stand in, unseen** ("in the event that the approver
  cannot approve, the manager or the person they report to can approve …
  don't show them in the approval"). `ApprovalWorkflow.standIns`, seeded
  on the same four routes. `deciderFor(request, step, userId)` is the ONE
  test `act()` and the panel's `canAct` both apply: never the requester; an
  eligible approver; on a `standIns` route the "Reports to" of an eligible
  approver (one level up), recorded as `ApprovalAction.onBehalfOfId`; else
  a super admin. A stand-in is never listed (`namedApprovers`,
  `historyFor`, the PDF's assigned names), never queued (`pendingFor`) and
  never told — the document's own Approval panel is where they find the
  buttons. Their decision is in their own name: the audit row says
  "(standing in for …)", the panel "<name>, for <approver>", the paper
  prints who really signed. **The read door**: a stand-in may hold no
  right to the module, so the quotation, sales order and costing record
  and PDF routes take `requireAnyOrDecider` (`auth/middleware.ts`) and let
  in, through `mayDecide()`, whoever may decide the document's OPEN
  request — only while it waits on them (decided, it is a 403 again).
- **A Team Leader step's fallback is the preparer's TEAM's leader**: a
  SUPERVISOR step naming a role, for a requester with no "Reports to",
  goes to `leadersFor()` — the role's holders on the requester's team
  (`Employee.industryId`), else every holder (never nobody; the requester
  never counts as the team's leader). The CEO on SIT goes to SIT's Team
  Leader, not to every one. The costing's Team Leader step now falls back
  to `team_leader` too (it was `sales_manager`), through `previously`.

Admin › Approval Workflows has both switches ("The preparer signs the steps
they hold", "A manager may stand in"), each kept when a PUT leaves it out;
`audit-workflows.ts` no longer reports a step routed to the raising role on
a `preparerSigns` route, and knows Industry Specialists, Team Leaders and
the CEO raise quotations and sales orders. verify-foundation (16) and
verify-sales (22) pin it: the held step, its instant, the one timestamp on
the quotation and the order paper, the CEO's quotation and order, the
stand-in's door, queue, bell and trail, and both switches off.

### As built on 2026-10-11 (the keyed routes, now retired)

- **`ApprovalWorkflow.requesterRoleId`** ("Prepared by" in Admin › Approval
  Workflows; `onDelete: Restrict`). `pickWorkflow(type, amount, { option,
  requesterId })` reads the requester's roles: a route keyed to one of them
  beats the general route (null); among several keyed routes the SHORTEST
  wins — the senior role's (the owner's call: a CEO who is also a Team
  Leader takes the CEO's); then the narrowest amount band. Every caller
  that previews or submits passes the requester (`routePreview`,
  `submitForApproval`, the sales order's GET and Issue guard). A
  general route still needs a step; **a role's route with NO steps
  approves on submit**: `submitForApproval` writes the request APPROVED,
  audits "Approved on submit", and runs the same `onApprovalSettled`
  subscribers a last signature reaches — the quotation's page says "No
  approval needed — Submit for approval approves it at once" and its paper
  prints Prepared by alone.
- **Three new roles** (seeded, then edited in Admin › Roles): `ceo` **CEO /
  President** (the owner's call: its own role, apart from Executive, which
  stays the read-everything role and the CEO step of every OTHER route;
  starts from Executive's rights plus raising quotations and sales orders),
  `team_leader` **Team Leader** (the sales manager's rights) and
  `industry_specialist` **Industry Specialist** (the sales role's).
  Admin Back Support (`back_support`) and Cost Controller are reused.
- **Quotation**: CEO / President — no approval; Team Leader — CEO /
  President; anyone else — Team Leader (SUPERVISOR, falling back to the
  `team_leader` role), and over ₱1,000,000 the CEO / President too, a fixed
  step: "Quotation — sales manager" and the "Add the CEO as approver"
  option are RETIRED. **Sales order**: CEO / President — Admin Back
  Support, Cost Controller; Team Leader — the same, then CEO / President;
  anyone else — Team Leader, Admin Back Support, Cost Controller, CEO /
  President (the general route, corrected in place through `previously`).
- **Back Support decides for the TEAMS it supports** (2026-10-12, the
  owner's call: "in admin back support, even they are reporting to
  specific manager, allow me to set where they support in back admin").
  `UserSupportTeam` (user × Industry/team), set as "Supports teams (Back
  Support)" on Admin › Users' Access tab when the role is ticked (`PATCH
  /users/:id { supportTeamIds }`, an unknown team a 400, audited with the
  user). A ROLE step whose role is in `TEAM_SCOPED_ROLES`
  (`shared/approvals.ts`, `back_support` only) goes through
  `supportersFor()`: the holders handling the PREPARER's team
  (`Employee.industryId`), else every holder — a document never stalls for
  want of a supporter. "Reports to" is untouched by it. **Since 2026-10-13
  (the owner's call: "apply the same team rule to Back Support") a holder
  with nothing ticked handles their OWN team** (their Team on Admin ›
  Users), the Technical Manager's rule — no longer every team; ticked
  teams replace their own.
- **A person's TEAM is picked on Admin › Users too** (2026-10-12, the
  owner's call: "on users edit allow selection of Team, particularly in
  Team Leader Role and sales to categorize their quotation and sales order
  by team"). The Details tab's "Team" select writes `teamId` through
  `PATCH /users/:id` onto the linked EMPLOYEE's `industryId` — the one
  place a team lives (`shared/team.ts`), so the quotation, lead and sales
  order lists' team cards, the Team view and the forecast follow it with
  nothing else changed. An unknown or switched-off team is a 400; a login
  with no employee record cannot keep one (the select is disabled and the
  PATCH says so); a change audits an `employee` UPDATED row. The user list
  has a Team column.
- **The team is picked on the quotation itself, the author's by default**
  (2026-10-12, the owner's call: "allow sales to pick the team on the
  quotation itself, but make it default by their team"). The editor's
  "Team" select (beside Currency) starts on the author's team —
  `/next-number` sends `ownerTeamId` and `teams`, and follows a change of
  author until somebody picks — and `POST /quotations` STORES
  `Quotation.teamId`: the one picked (`pickedTeam()`: active, else a 400)
  or the author's own (`teamOf(ownerId)`), so a quotation keeps the team
  it was raised under when its author later moves. `PATCH` takes `teamId`
  at any stage (a category, not a figure; null goes back to following the
  author's) and writes its own audit row ("… team: KAT → HIT"). The rule
  stays `quotationTeamWhere()` / `quotationTeamOf()` — the stored team,
  else the author's. **A sales order counts under its QUOTATION's team**:
  `salesOrderListWhere`'s Team view, its summary's team cards and "My
  team" read `quotation: quotationTeamWhere(…)` / `quotationTeamOf(o.
  quotation)`, never the order's own author's team. **Old quotations take
  their author's team** (2026-10-12, the owner's call: "set the team of old
  quotations to the author's team"): `fillQuotationTeams()` in
  `shared/team.ts`, run by the seed on EVERY deploy, fills `teamId` on a
  quotation that has none from its author's `Employee.industryId` — never
  touching a picked team or an import tag, claimed on `teamId: null`, one
  audit row per team (`quotation` / `list`); an author with no team leaves
  theirs open until one is set, and the next deploy fills them then.
- **A role you made can be deleted** (2026-10-12, the owner's call: "allow
  me also to delete role created"): `DELETE /roles/:id`
  (`admin.roles.delete`, the Delete in the role modal's foot) takes it off
  everybody holding it in the same transaction — the question says how
  many — and audits who lost it. Refused: a seeded (`isSystem`) role, which
  the seed would make again and its routes name (the modal says so), and a
  role any approval route still names, as a step or as "Prepared by" — the
  400 names the routes, because deleting it would leave a step routing to
  nobody.
- **Assign the roles in Admin › Users**: until somebody holds Team Leader
  (for anyone with no "Reports to") and CEO / President, those steps route
  to nobody and `audit-workflows.ts` says so.

## Sales orders (2026-10-07)

SCORO's "Create invoice", under its real name: the document that books a
quotation's work in operations (`/g-ops/sales-orders`, `gops.sales_orders.*`
OWNED, `routes/salesOrders.ts`, patterned on SCORO quote 8442 → invoices
4622 / 4622.1 and the owner's sample PDF).

- **Raised FROM a quotation only** — the quotation page's "Create Sales
  Order" panel (in the page, no dialog). **The panel offers one thing:
  "Transfer all details"** (2026-10-07, the owner's call, after a day with
  SCORO's line-by-line table): the order books what is left of every line
  of the VALUE revision (`valueRevision()`: approved, else latest), and the
  panel says how many lines and how much. A line booked in part is adjusted
  on the order itself, in the editor, and a later order books what is left.
  `POST /sales-orders` still takes `mode: lines` with `lines: [{ id,
  quantity }]`, `all` (what is left of every line) or `summary` (the
  selection, or what is left, as one line worth its net, with `bookedItems`
  saying which lines it books) — scripts and a future screen may use them.
  The quotation's Sales orders card has no button of its own: the action
  bar's is the one way. **The list's "+ New sales order"** (2026-10-09, the
  owner's call: "add also add button in sales order") asks which quotation
  the order books — the quotation list's own search, in the page
  (`PickQuotationPanel`, in the Append quote panel's dress) — and opens
  that quotation with its Create Sales Order panel already open
  (`/g-ops/quotations/:id?order=1`; `QuotationDetail` reads `?order=1`
  once). No second create path. **The editor has "+ Append quote"** too:
  the quotation editor's `AppendQuotePanel` and `linesFromItems` are
  exported for it; an appended line has no saved id, so it books nothing
  of the order's quotation.
- **Progress booking is `bookingFor()` in `shared/salesOrderBooking.ts`**
  — SCORO's "100% of available": a quotation line is booked by the live
  (not cancelled) orders' lines pointing at it (`SalesOrderLine.
  quotationItemId`) or by a summarised line's `bookedItems`; what is left is
  its quantity less that. `GET /sales-orders/booking?quotationId=` (above
  `/:id`) is the panel's figures; the create route reads the same inside its
  transaction and refuses more than is left ("Only 0.5 lot of … is left to
  book"), so two bookings of one line cannot both pass. A cancelled order
  gives its booking back; the editor's PUT carries a line's link when the
  line comes back with its `id` (new lines book nothing). The seed runs
  `linkLegacyBookings()` on every deploy: orders made before this link up
  to the quotation lines they match (product, price, unit), and a lone
  summarised line is marked as booking every line in full. Idempotent.
- **One quotation, one number family**: the first order takes the next
  `sales_order` number; every later one is `<base>.1`, `<base>.2`…
  (progress booking), computed inside the creating transaction
  (`nextOrderNumber`), so a refused order burns no number and two creates
  cannot share a suffix.
- **The money is the quotation's own arithmetic** (`quotationTotals`), and
  `recalcOrder()` is the only writer of its stored totals. Cost visibility
  is the quotation's rule (author, `edit_all`, or `gops.costing.view_all`);
  everybody else gets lines with the cost keys REMOVED server-side
  (`stripLineCost`), on the JSON and on the paper alike.
- **DRAFT → PENDING_APPROVAL → ISSUED (booked) → CANCELLED (reason
  kept)**. **Approval is the one engine, and the route is the owner's four
  signatures** (2026-10-08: "Sales (Create) › Team Leader › Back Support or
  Admin › Cost Controller › CEO or Executive"): ONE seeded `sales_order`
  workflow, "Sales Order — team leader, back support, cost controller,
  CEO" — step 1 a SUPERVISOR step named Team Leader (the salesperson's
  "Reports to", falling back to `sales_manager`, the quotation's rule),
  then ROLE `back_support` (**Back Support / Admin**, a seeded role), ROLE
  `cost_controller` (**Cost Controller**, seeded, holding
  `gops.costing.view_all` so the margin shows), then ROLE `executive`. No
  option any more: the CEO is a fixed step, so the "Add the CEO as
  approver" tick is gone from the order page. The two earlier routes are
  in the seed's RETIRED list (deactivated, history kept — the step count
  changed, which `previously` cannot update in place; an order pending on
  one finishes on it). **Assign the two new roles in Admin › Users**: until
  somebody holds them, orders stall at step 2 and `audit-workflows.ts`
  says so. `POST /:id/submit { optionId? }`
  claims DRAFT → PENDING_APPROVAL and calls `submitForApproval`; a refusal
  puts it back to DRAFT. `settleSalesOrder()` (exported, idempotent) claims
  PENDING_APPROVAL → ISSUED on approval — only once EVERY step has approved
  (verify-sales proves three signatures book nothing) — → DRAFT on
  rejection, and writes "… not applied" when a decision lands after a
  cancel. `POST /:id/withdraw`
  pulls it back to draft through `cancelOpenRequest`, as a quotation's
  revision is; cancelling a pending order withdraws its request in the same
  transaction. **Issue is refused while a route is active** (`pickWorkflow`)
  — deactivate the seeded workflow to issue without approval, as with the
  costing. `GET /:id` carries `needsApproval`, `approvalOptions` and
  `approvalRoutes` (names only), so the page shows "Submit for approval
  sends it to …" (the four, each by name) and the Approval panel
  (`DocumentApproval`, type `sales_order`). The PDF's sign-offs come from
  `approvalSlots` — Prepared by, then each step (Pending until it acts);
  Noted/Approved stay open only where no route exists. An issued order refuses the full save
  but still takes its release references (`PATCH`: SI/BS No., DR No.,
  payment method, reference); Reopen goes back to DRAFT; **Delete takes a
  draft or a cancelled order** (2026-10-07), never an issued or pending one.
  Editing is one PUT — header and lines together — and saved groups go
  through `rememberGroups`. **The editor is the quotation editor's**
  (2026-10-08, the owner's call): `SalesOrderEditor` in
  `pages/sales/SalesOrders.tsx` is built from `pages/sales/editorParts.tsx`
  — the `Line` shape, `moneyOf` / `linePayload`, `ProductInput`, `CostCell`
  (the person/building toggles and the provider lookup), `Static` — which
  the quotation editor imports too, so the two cannot
  drift: one card, labels beside values (`.qe-rows`), the contact beside the
  customer, the `qe-lines` table (group, product over description, quantity
  beside unit, price, amount with the with-VAT figure, cost and provider,
  margin), SCORO's Tax dropdown (`taxOptions` on `GET /sales-orders/:id`),
  the totals beside `CostPanelBlock`, Save at both ends, the Shell's Back
  line and `useUnsavedChanges` (rule 19). The PUT takes `providerUserId` / `providerSupplierId` per
  line (one or the other, checked to exist). Add a shared cell to
  `editorParts.tsx`, never to one editor. `audit-workflows.ts` knows sales and sales
  managers raise sales orders.
- **The list is the quotation list's layout** (2026-10-08): the status as
  a filter (`?status=`: Draft, Pending approval, Issued, Cancelled — the
  counts still come as `summary.tabCounts`), Filters (booked by,
  customer, order date range — a DATE, UTC-midnight edges — and Released: an
  SI or DR number filled in), Customer / PO / SI-DR / Margin columns (margin
  only where `canSeeOrderCost`), the printed list `GET /sales-orders/pdf`
  (above `/:id`, value never cost, audited, `?ids=` for Print selected) and
  tick boxes with Export / Print selected. `salesOrderListWhere()` is the one
  query for the rows, `salesOrderListSummary()` and the paper. **The summary
  cards' value is the BOOKED value** — orders still standing; a cancelled
  one is counted apart ("N cancelled, not counted"), never summed, as the
  quotation page's Booked figure. Mine for `edit_own`/`edit_all` holders,
  All for a reader (finance). No bulk status change: submitting, issuing and
  cancelling an order each have consequences of their own, and stay on the
  order's page.
- **The order shows NO discount — its lines carry it** (2026-10-12, the
  owner's slide: "don't reflect the discount and the approval always sits
  at the bottom of the document"; `docs/notes/P-sales-order-paper-
  2026-10-12.md`). `quotationTotals` (and its mirror) give every line
  `netAmount` — its share of `net`, the remainder on the largest line so
  the lines add up to `net` exactly (`spread()`) — `netMargin` (its share
  of `netOfTax` less its cost, so the lines add up to `cost.totalMargin`)
  and `netMarginPct`, and the panel `netMarginPct`, all TWO decimals
  (the owner's call: "always 2 decimal places"). The order's paper and
  its PAGE (`GET /sales-orders/:id` sends `netUnitPrice`, `netAmount`,
  `netMargin`, `netMarginPct` per line and `netOfTax`; `netUnitPrice()`
  in `routes/salesOrders.ts`) print the lines after the discount and the
  money as **Total price** (the sum after the discount, before VAT),
  **Total cost**, **Margin**, **VAT (12%)**, **VAT included** and **Margin
  (%)** (`16.29`) — never Subtotal, Discount or Sum without tax; a reader
  without cost rights gets the first, VAT and VAT included. The EDITOR
  keeps the list price and the discount box: that is where a discount is
  set. The quotation keeps its discount row everywhere — a customer is
  shown the discount; the booking record is not. On paper the money is
  the totals box's **grid** (`grid: true`, `perBand`, `bandGap` on the
  totals block in `shared/pdfDesign.ts` — bordered cells, the figure bold
  over its label in capitals, a band flush right; "Layout: Grid" in Admin
  › PDF Templates; the quotation's stays rows): two bands of three under
  the table, flush right, the internal note to its left, then — anchored
  `last` — "The name, date and time are considered a digital signature of
  approval" and the one-row approvals table, its bottom just over the
  footer rule, at the foot of the LAST page whatever the order's length
  (verify-foundation pins both a short order on one page and a 40-line
  one). An administrator's SAVED order layout keeps its own boxes: "Put
  the standard back" in Admin › PDF Templates brings the new one.
- **The quotation page lists the orders booked from it** (2026-10-07, the
  owner's call, as SCORO lists a quote's invoices): `QuotationSalesOrders` in
  `pages/sales/Quotations.tsx`, under the Lines card, reads the ordinary
  `/sales-orders?quotationId=` list — the same rows and visibility as the
  register, so a `view_own` holder sees only their own — with number, date,
  status, PO, SI/DR, total and who prepared it, under three figures:
  Quotation total (the value revision's), Booked (live orders' totals) and
  Outstanding (the difference, never below 0). No button of its own. No
  second query, no copy of the figures.
- **The PDF prints through the Sales Order template** (2026-10-07): a
  designed document like the quotation, landscape, in the quotation
  template's dress, edited under Admin › PDF Templates. The standard layout
  is the owner's sample: customer details against the PO, Group, cost +
  supplier and margin columns, Prepared / Noted / Approved sign-offs, a
  DRAFT note until issued. Cost reaches the paper ONLY for a caller who may
  see it — `withoutCostColumns()` strips the cost columns from the layout
  and `salesOrderPrintData(order, showCost)` sends no cost cell or cost
  total — because it is the internal booking record, never the customer's
  copy (the invoice is G-FIN's). **The margin prints as a percentage too**
  (2026-10-11, the owner's call): each line's margin cell carries its share
  of the line's amount under it, and "Margin %:" (of the sum without tax,
  `totalMarginPct`) follows "Margin sum:" — `{{order.marginPct}}` for a
  layout that wants it in a box; all of it for cost viewers alone.
  **The approvals are ONE bordered row at the foot of the last page**
  (2026-10-11, the owner's call: "a 1 row table at the bottom … show only
  the name and time stamp"): the sign-off block's `style: 'table'`
  (`signoffsBlock` in `shared/pdfDesign.ts`, `drawSignoffTable()`), equal
  columns across the block's width, the step in the head, the name and the
  date — or "Pending" — in the cell, never a phone or an email, borders in
  its `ruleColor`; `columns` (the default, and the quotation's) is the old
  side-by-side look. The standard order layout anchors it `last` at y 482,
  and its "DRAFT — NOT YET ISSUED." moved under the strapline, opposite the
  page number, so it never sits on the table. Admin › PDF Templates offers
  the choice ("Layout" on the sign-off box) and draws the table in its
  preview; a layout an administrator saved before keeps its columns until
  the box is switched or the standard is put back. **The totals are compact** so a
  short order prints on ONE page (the owner's call, same day): the totals
  box takes a `rowHeight` (24.5 by default, the quotation's; "Row height"
  in the editor), and the standard order layout sets 15 at 8.5pt, so the
  six rows with cost end above the approvals table — verify-foundation
  prints the two-line sample on one page.

## Attachments on the quotation and the sales order (2026-10-12)

The owner's call: "add attachment card between sales order and activity …
e.g. Purchase Order; when print or save as, it also includes the attached
documents; when created as sales order, the attachment also transfers …
the attachment card at the bottom of the sales order"
(`docs/notes/P-quotation-attachments-2026-10-12.md`).

- **The cards are the one `Attachments` card**, `entityType` `quotation`
  (between Sales orders and Activity; the files belong to the quotation, so
  a new revision keeps them) and `sales_order` (last on the order page).
  **Guards** (`registerAttachmentGuard`, in `routes/sales.ts` and
  `routes/salesOrders.ts`): read = the record's own visibility, a stand-in
  deciding it included (`printableQuotation` / `assertOrderVisible`);
  write = whoever may edit it (`canEditRecord`), and on a quotation also a
  READER holding `gops.sales_orders.create` (sales files the customer's PO
  on a colleague's quotation). Deleting or purging a quotation and deleting
  an order remove their files (`deleteAttachmentsOf`, after the commit).
- **The paper carries them**: `withAttachments(pdf, files, doc)` in
  `shared/pdfAttachments.ts`, applied by `GET /quotations/:id/revisions/
  :rid/pdf` and `GET /sales-orders/:id/pdf` only (never the list papers,
  the template preview or the specimen). The document's own pages first,
  unchanged (its "Page n of m" stays its own); then, when anything is
  attached, an **Attachments page** through `renderDocument` naming every
  file, who added it and when, and what became of it ("Printed — 2
  pages", "Not printable — open it in G-CORE", "Could not be read …");
  then each PDF's pages copied whole and each image (JPEG/PNG, WEBP and GIF
  made PNG through `sharp`, EXIF-turned) on an A4 page of its own,
  `fitImage()` inside the 36pt margins and never enlarged, its name under
  it. Word, Excel, CAD and zips are listed, never converted (that needs
  LibreOffice on the shared host). A damaged or protected PDF is listed and
  the paper still prints. **`pdf-lib` (1.17.1)** is the merger — pdfkit
  cannot read a PDF; added to the lockfile by merging only its entries (the
  sandbox's npm strips `libc` fields from every other entry). `?attachments=0`
  prints the bare document — "Print without attachments" in the ⋯ of both
  pages; the list's PDF column stays the bare paper. The EXPORTED row says
  how many went with it.
- **The order takes the quotation's files**: `POST /sales-orders` copies
  them after the commit through `copyAttachments()` (bytes copied, rows of
  their own captioned "From quotation <number>" — the CAD plan's rule), so
  removing a copy never touches the original; a failed copy is logged and
  never fails the order. A file added to the quotation later stays there.
- **The card shows every file's first page** (2026-10-12, the owner's
  call: "the viewer can easily view the attachment without opening it"):
  the one `Attachments` card lists its files ONE UNDER ANOTHER, each headed
  by its name, size, who and when (and Remove), with the first page at the
  card's full width under it — a picture as itself, a PDF's page 1 drawn to
  a picture by **pdf.js 4.10.38, vendored in `web/public/pdfjs/`** (the
  legacy build's two files, its licence and a README with the registry
  integrity; `lib/pdfThumb.ts` loads it only when a PDF comes into view, so
  no bundle carries it and npm never resolves it — this sandbox cannot
  re-resolve the lockfile). The bytes come through the token-bearing file
  route, so each record's attachment guard still decides, fetched only when
  the item scrolls into view and never past 20 MB. Word, Excel, CAD and
  zips are a band naming their type (drawing them needs a converter on the
  shared host). The name and the page still open the whole file.
- **verify-sales** uploads a PNG, a two-page PDF (by a colleague — the PO
  rule), a Word file and a damaged PDF, proves a view-own reader is kept
  out, counts the pages (bare + 1 + 1 + 2), reads the Attachments page,
  follows the copies onto the order and its paper, and deletes the files on
  disk in `cleanup()` (every attachment uploaded by a `@verifys.local` user).
  The order's landscape check reads the FIRST page's size through pdf-lib,
  since attachments behind it keep their own.

## The list of quotations (2026-10-08)

SCORO's "list of quotes", on the shared list pattern (rule 9).

- **The stage is a filter** (`?stage=`; the tab strip went on 2026-10-08,
  the owner's call). All quotes, Opportunity, Negotiation, Closing,
  Confirmed, Completed, Lost — `quotationStages()` in `shared/pipeline.ts`,
  the stages a quotation can stand in (On hold too since 2026-10-13), named and coloured
  as Admin › Pipeline Stages has them and sent with the list's
  `summary.tabs` (the filter's choices; a reader needs no pipeline right
  to see them) and counted in `summary.tabCounts`. A quotation's stage is
  `quotationStage(outcome, booked)` — the board's own `columnFor` +
  `stageOfCard` — and `quotationStageWhere()` is the same rule as a
  where-clause, built pair by pair from it, so the filter and the board can
  never sort a quotation differently. `QUOTATION_BOOKED_WHERE` is the twin of
  the board's `booked` (a sales order or a project); change one, change the
  other.
- **One query: `quotationListWhere(me, q, stages)` in `routes/sales.ts`**
  returns `base` (everything but the stage) and `where`. The rows, the
  printed list (`GET /quotations/pdf`, above `/:id`, audited EXPORTED with
  entityId `list`, capped at 1,000 rows, value never cost) and
  `quotationListSummary()` all read it: the stage counts under `base`, the
  totals under `where`. **The summary cards** (SCORO's row over the list;
  the owner's four): Quotations (the count), Sum (`quotationValue()` summed
  in cents — the approved revision, never a later draft — the figure the
  Total column shows), Margin (where every listed quotation's cost is the
  viewer's) and **one card per team** — `summary.teams`, the set split by the
  OWNER's team (`Employee.industryId`, `shared/team.ts`): every active team
  in the master's order even at zero, a team since switched off as it is
  met, "No team" last while any listed owner has none (the Quotations
  card's subtext, not a card); the shares add up
  to the count and the sum, which verify-sales asserts, along with the
  stage counts adding up and each stage listing exactly what its count
  says.
- **Filters**: owner (people holding `gops.quotations.create`, declared
  before they load so a linked `?ownerId=` is read), customer (a lookup, for
  `gops.customers.view_all` holders), Raised (`createdFrom`/`createdTo`, a
  timestamp: Manila midnight to midnight), Expected closing
  (`closingFrom`/`closingTo`, a DATE: UTC-midnight edges), Revision (has a
  draft / pending / approved revision) and Sales order (yes / no — live
  orders only; a cancelled one books nothing). An unknown stage, a malformed
  date or an unknown choice is a 400. The old `?outcome=` still filters.
- **Mine for whoever may edit quotations, All for a reader** (the owner's
  call): `defaultScope` is Mine for `edit_own`/`edit_all` holders. A link's
  `?scope=` wins. **Team** sits between them for a viewer with a team
  (2026-10-08): the quotations of everyone on their team. The summary's
  `team` (the viewer's team's share) is still sent; the quotation list's
  cards show every team's share instead (Quotes by team), the leads and
  sales order lists a "My team" card while the Team view is off.
- **Columns**: Number, Quotation (contact under it), Customer (sorts by name),
  Status (the stage on `StatusBadge` with `STAGE_TONES`, its name from the
  row's `stageLabel`), Revision, Total, Margin (only for a viewer who may see
  cost — `canSeeQuotationCost` per row, read off the value revision's lines
  through `quotationTotals`; null when no line is costed), Owner, Closing,
  Raised, then **PDF** — `PdfButton`, the value revision's paper (the row
  carries `valueRevision.id`); Probability and Modified are under Columns.
  The column pattern every Sales list follows: Number · Name · Customer ·
  Status · figures (right-aligned) · Owner · dates · PDF; the masters put
  Status right after their classification.
- **The leads and installed-base lists print through `printPath` too**; their
  hand-built "Export PDF" buttons, which re-read the URL themselves, are gone.
  All three honour `?ids=` for Print selected.
- **Change status on many** (the quotation list's mass action) is the detail
  page's "Change status" for the ticked rows: the same targets (Submitted,
  Negotiation, Won, Lost), planned by `planMove()` with the page's
  `NEXT_OUTCOMES`, a won quotation built into a project staying won, and Won
  needing an approved revision — rows carry `canEdit`, `hasApprovedRevision`
  and `hasJob` for it. The bar says how many will move and why the rest stay
  before anything is sent; Lost asks one reason for all. It then sends the
  ordinary `PATCH /quotations/:id` one row at a time — the move rules, the
  lead that follows, the stage's odds and the audit row are the PATCH's, and
  the server still decides each one. What did not move stays ticked, with
  the reason. There is no bulk endpoint, deliberately.

## Paper: one sign-off rule, one money block, a printed twin for every list (2026-10-10)

The owner approved the review's A3–A5 (2026-10-10). Rule 6 is the dress;
these are what every document and list says in it.

- **Sign-offs say who really acted.** A routed document prints its own first
  slot (Prepared by / Requested by / Filed by — the author, dated, with their
  contact lines) and then one slot per step of its route through
  `slotSignatories(approvalSlots(…))` — the step's name as the role
  (TEAM LEADER, COST CONTROLLER, CEO APPROVAL; never "Approved by — step"),
  who signed and when, or who is assigned with "Pending" under them. A
  draft, a pulled-back or a returned document prints the route a
  (re)submission would take, never the closed request's old signatures; a
  cancelled one prints only the steps that really signed. The designed
  quotation and sales order print the same step names. A document with no
  route (invoice, progress report, billing, stock issue, CAD J.O., training
  sheet) prints the people who acted, read from the record or its audit
  trail and dated — never a slot nobody fills and never the creator as the
  approver: the billing's "Checked by" and Conforme, the progress report's
  "Checked by" and the invoice's "Received by" are gone. The job order's
  customer acknowledgement stays last (a real act, Pending until done).
- **One money block.** A document's money is a `totals` section — never a
  blank-head table, never a TOTAL row inside the line table (a costing's
  per-bucket subtotals are the estimate's structure and stay). The
  quotation's words: Subtotal, VAT (12%) at the stored rate, Total; "Less:
  EWT (2%)" and "Net collectible" / "Net payable"; only the last row bold.
  Figures in a table are `formatAmount` under a head naming the company's
  currency ("Amount (PHP)"), a totals row `formatMoney(value,
  await companyCurrency())` — no route spells "PHP".
- **Words and dates.** A record's date in its fields is `formatDate`
  ("October 9, 2026"; the DETAILS block keeps the quotation's MM/DD/YYYY), a
  list's `formatShortDate`; every enum through `statusLabel()`. A document's
  number column is "Number"; a master's identifier (customer, supplier,
  item, partner, position, course, machine) stays "Code".
- **Every PDF route writes an EXPORTED audit row** (the purchase request,
  stock issue, clearance and specimen did not).
- **Every list screen prints** (A5): a `GET <list>/pdf` declared above `/:id`,
  behind the list's own right, reading the SAME where-builder as the list
  (so the paper never shows a different set), `?ids=` through `idsFilter()`
  for Print selected, capped at 1,000 rows with "first 1,000 of N printed",
  a filter line naming every filter that narrowed it, landscape past seven
  columns, audited EXPORTED with entityId `list`; the screen's DataList
  carries `printPath`. Money on a list: a closed document (cancelled; a
  rejected claim, advance or budget request) prints its figure in brackets
  and is not summed; drafts and pending ones are summed with a note saying
  how many. With `?outstanding=true` the A/R and A/P papers' outstanding
  equals the working position's. The employee paper never prints pay data,
  whatever the reader holds. Not lists, so no paper: dashboard tiles,
  settings lists, a record's own sub-lists (a partner's price list, the
  stock card). Inventory's "Below level" is part of its query
  (`inventoryListWhere` / `belowReorder`), so the flag, the filter, the
  paper and the reports tile agree — it was filtered after paging before.
- **The specimen** (Company Settings › Preview, `GET /pdf/specimen`) prints
  every section kind the engine has — fields, text, a table with a
  subheading and title/body cells, totals, a gantt appendix, a footer note,
  signed and pending sign-offs — so it previews the dress real paper wears.
- **One sign-off rule lives in `shared/approvals.ts`**: `approvalSlots(type,
  id, draft?)` previews the route whenever `draft` is passed unless a
  request is PENDING, and without it a closed request gives only the steps
  that signed; `approvalStands()` is the one test of whether a decision
  still stands behind a reopened document (a costing made FINAL again, a
  reopened sales order); `routeBrief()` is a page's "Submit for approval
  sends it to …"; `contactOf()` / `contactsOf()` are how a name on paper
  gets its contact lines — read for the paper only, never sent with a
  record. A route never builds these itself.
- **One list-paper toolkit: `shared/listPaper.ts`** — `LIST_CAP`,
  `listReference()` (the "first 1,000 of N printed" line), `totalLabel`,
  `bracketed` / `bracketNote` (closed documents), `rangeNamed`,
  `filterDay`, `listDay`, `recordNamed` / `namedInFilter` (the filter
  line names the record, never its id), `choice()` (an unknown filter value
  is a 400 naming the choices — a list never silently ignores one),
  `scopeNamed`, `ratePct` and `sendListPdf`. Every `GET <list>/pdf` uses
  them, and `api/scripts/lib/paper.ts` is the verify side (`readPaper`,
  `checkListPaper`, `signedCount`, `pendingCount`).
- **The engine's own rules**: `formatDate` is Manila's day whatever the
  host clock; a table with no rows prints `NOTHING_TO_LIST`; a sign-off
  role runs to three lines at most (`ROLE_MAX`); `signoffColumns` and
  `breakPoint` are shared between `pdf.ts` and `pdfDesign.ts` (the editor's
  copy in `web/src/lib/pdfTemplate.ts` is pinned equal); a character
  outside WinAnsi (`≠`, a combining U+0338) has a stand-in rather than
  printing as garbage.

## Quotation PDF template (2026-10-02)

Admin › PDF Templates (`/admin/pdf-templates`, `admin.pdf_templates.*`,
`PdfTemplates.tsx`) lays out a designed document's PDF: boxes on an A4 page,
each printing fixed text and `{{fields}}`. Three documents are designed — the
quotation, since 2026-10-07 the sales order (`?doc=sales_order`, the
page's switcher) and since 2026-10-13 the costing (`?doc=costing`) — and
all go through the same editor, routes and engine.
Adding another means a field catalogue, a sample, a standard layout and a
data builder like `quotationTemplate.ts` / `salesOrderTemplate.ts` and
`quotationPrintData()` / `salesOrderPrintData()`, plus one entry in the
`DOCS` registry of `routes/pdfTemplates.ts` — the routes are generic over
it (`/api/pdf-templates/:type`), and an export file names its type so an
import for the wrong document is refused.

- **A layout carries its page**: `orientation` on the design (portrait the
  default; the sales order's standard is landscape), checked edge by edge on
  save, drawn at the right size by the editor, and applied by PDFKit's
  `layout`. Turning the page in the editor pulls every box back onto the
  paper.
- **The cost columns (`cost`, `margin`) exist only for internal paper.**
  The registry entry says which columns a document's line table may place;
  the quotation's refuses them on save (`verify-sales` proves it), and the
  sales order strips them server-side for a caller without cost rights.
- **The costing is the third** (2026-10-13, the owner's call: "add PDF
  template of costing in Admin Setting to modify";
  `docs/notes/P-scope-dates-rfa-people-flow-2026-10-13.md` §2).
  `shared/costingTemplate.ts` holds `COSTING_FIELDS` (`costing.*` — number,
  title, dates, start and finish, plan days, terms, the summary's figures —
  `customer.name`, `owner.*`), the sample, `STANDARD_COSTING_DESIGN`
  (portrait, the quotation's dress: PROJECT COSTING, a PROJECT and a
  DETAILS box with the start and finish dates, the line table, the summary
  `after` it, Terms and the schedule note, the sign-offs `last`) and
  `costingDesign()` on `pdfTemplate.costing`. Its line table places
  `no`, `product`, `qtyUnit`, `qty`, `unit`, `unitPrice` and `amount` only
  — never `group`, `cost` or `margin` (a costing's every figure is cost) —
  and the registry's `columnLabels` names them as the costing prints them
  (Line code, Line with its description, Unit cost). `costingPaper(me, id,
  deciderOnly)` in `routes/costing.ts` is the ONE data builder for the
  route and the editor's "a costing…" preview: the buckets as
  heading rows with a subtotal row each (`costingLineRow`,
  `costingSubtotalRow`), the summary as `totals`, the route's sign-offs.
  **The Gantt chart is not a box**: `costingAppendix()` draws it through
  `renderDocument({ appendixOnly: true })` — the sections alone on
  landscape pages with the page furniture, no letterhead, details or
  sign-offs — and `appendPdf()` (`shared/pdfAttachments.ts`, pdf-lib)
  joins it behind the designed estimate, so a layout never has to make
  room for a chart. verify-costing reads such a paper's pages through
  pdf-lib, never by regex over the file.

- **The layout is one `Setting` row, `pdfTemplate.quotation`**, read by
  `quotationDesign()`; none (or one that no longer parses — it is logged and
  the editor says so) prints `STANDARD_QUOTATION_DESIGN`. `PUT
  /api/pdf-templates/quotation` checks the shape (`designSchema`: one line
  table, one totals and one sign-off block at most, boxes on the page, colours
  `#RRGGBB`) and every field the layout names (`unknownFields()`), so a typo is
  a 400 naming it rather than a blank on a customer's quotation. Audited.
  `DELETE` puts the standard back. `POST …/preview` prints whatever the editor
  holds against the sample (one page or three) or a quotation the caller may
  print (`printableQuotation()`, audited as EXPORTED).
- **Anchors make a fixed layout work for a document of unknown length**:
  `first` (page 1; a box that grows pushes down what sits under it, the line
  table included, and never moves anything up), `every`, `later` (pages 2+),
  `after` (follows the line table, keeping its design distance under the table
  or under the box DIRECTLY above it — `covers()` — so a box with nothing to
  print closes up; one that does not fit goes over whole, text of four lines
  or more runs on), and `last` (where it was put on the last page, keeping its
  BOTTOM edge — printing more than its box holds it grows upward, never into
  the footer — or on a page of its own if the content reaches it). The table starts where it is on page
  1 and resumes at `flowTop` with its head repeated; content stops at
  `flowBottom`. A row taller than a page is split, never cut off.
- **Fields are filled by `resolveTemplate()`**: parts of a line split by
  ` | ` drop out when every field in them is empty, a line whose parts all
  went is left out, `{{field|—}}` prints the fallback, `**…**` is bold in the
  TEMPLATE only (a value's `**` prints as typed), and a value with newlines
  runs over as many lines. `web/src/lib/pdfTemplate.ts` is the editor's COPY of
  that rule for its preview, pinned equal by verify-foundation — change both.
- **Every string reaches the page through `pdfSafe`**, text is drawn run by
  run with no PDFKit wrapping (margins are 0, so PDFKit never starts a page by
  itself), and `{{pages}}` outside the page furniture renders twice to know
  the count. Graphics anchored every/later are drawn when a page is made, so
  they sit behind its content.
- **The sign-offs** (2026-10-02, the owner's call): each column is the role,
  the NAME in bold at `nameSize` (10pt), then smaller the contact number, the
  email and the date — or "Pending". No position unless the layout ticks
  `showPosition`; `showPhone` / `showEmail` drop either line. The number is
  `contactPhone()` in `shared/approvals.ts`: the login's `User.phone`, else the
  linked employee's `mobile` (kept on My Account). `approvalSlots()` returns
  each approver's phone and email; the author's are read in
  `quotationPrintData()` for the paper only — `GET /quotations/:id` never
  carries a mobile. `renderDocument`'s sign-offs print the same lines.
- **A layout travels as a FILE, never with a push.** It is a Setting row in
  one database, so a layout tried on the laptop reaches the live server by
  Export layout (`{ type, exportedAt, layout }`, downloaded in the browser)
  and Import layout, which posts it to `POST /api/pdf-templates/:type/check` —
  the save's own checks, an older file's gaps filled from the schema's
  defaults, nothing stored — and loads the result as unsaved, undoable
  changes for the administrator to preview and Save. A file for another
  document type is refused. Never carry a layout in the seed: it would
  overwrite what an administrator saved on the live server.
- **"Hide total" hides the money everywhere**: `quotationPrintData()` blanks
  the money fields as well as passing no totals, so a layout that prints
  `{{quotation.total}}` in a box of its own still obeys it. Cost is never in
  the data, so no layout can print it.
- **The editor**: drag to move, handles to size, snapping to margins and other
  boxes (Alt places freely); a focused box moves with the arrows (Shift 10pt)
  and sizes with Ctrl+arrows; Ctrl+Z/Y undo and redo — through a reducer that
  applies each change to the layout as it stands, so key repeats faster than
  a render are not lost. Moving or sizing the line table moves the `after`
  boxes with it. The page is drawn white (`--paper`) in either theme; the
  colours on it are the layout's own.
- **The company's fields on the editor are the REAL Company Settings**, not
  samples, so an empty one leaves its line out there exactly as on the PDF —
  which reads as a broken template unless it is said. `emptyFieldsIn()` (in
  `web/src/lib/pdfTemplate.ts`; a field with a `|fallback` and the page count
  never count) drives the page's "Empty in Company Settings: …" note, named as
  Company Settings names them (`COMPANY_SETTING_NAMES`) and linked there, and
  the selected box's "Not printing now: …". Hidden, the note stays hidden only
  until a different set of fields is empty (a per-browser convenience).

## Project Management (2026-10-06)

The owner's arrangement, after the old gasiontech G-CORE: the G-OPS section
is **Project Management** and its strip is **Costing, Projects, Job Orders,
CAD J.O.** (the owner's order of 2026-10-14; the registry's order carries it;
verify-foundation pins it). The five
registers that used to sit there — Approved Plans, Budget Monitoring, Purchase
Requests, Budget Requests, Progress & Billing — are `hidden: true`: each is a
tab inside a project, and the Projects page keeps them one click away
(`.del-registers`). Routes, permissions and links are unchanged.

- **Hide a screen with `hidden: true` on its registry entry — never by
  deleting the entry, which would drop its permissions.** A hidden entry is
  kept off the sidebar, the section strip and Ctrl+K's screen list while its
  route, its keys and every link to it work as before; `menuFor()` still
  sends it, flagged, so its page opens under the section it is declared in
  (`Shell.tsx` finds the group by the declaration). The hidden G-OPS
  "Purchase Requests" entry keeps its keys for the same reason: the API
  routes check `gchain.purchase_requests.*`, but the project's Purchase
  Requisition tab and its routes in `App.tsx` are guarded by
  `gops.purchase_requests.*`. verify-foundation lists the hidden entries.
- **A project's tabs are, in order**: Overview, Meetings & Records, Request
  for Approval (the `plans` key), Budget Monitoring, Purchase Requisition, Budget Requests, Scope of
  Work (Gantt), Progress & Billing — then Finance and Service, which hold the
  invoices and the turnover register and belong nowhere else. `TAB_ALIASES`
  in `ProjectWorkspace.tsx` keeps every old `?tab=` landing: `billing` →
  progress, `tasks` → scope, `documents` and `activity` → meetings. A new
  link to a tab uses the new key. (A budget request's notifications link to
  the request's own page, `/g-ops/budget-requests/:id`, not to the tab.)
- **Meetings & Records** is the meetings held for the project
  (`Meeting.jobId`, optional, SetNull; `GET /meetings?jobId=`, the usual
  `visibleWhere`), its documents and its activity. The meeting form offers
  "For project" to anyone who may see projects (`/jobs/lookup?includeClosed=true`)
  and keeps a preset it cannot list; a project's "+ New meeting" opens
  `/g-hr/meetings?new=1&job=<id>`, read once and dropped from the URL. A
  project that does not exist is a 400.
- **Scope of Work is a Gantt chart** (`pages/delivery/ProjectGantt.tsx`): each
  scope line is a phase on its `plannedStart`/`plannedEnd`, its tasks under it
  on `startDate`/`dueDate`, filled to `progressPct`; days in whole weeks from
  the Monday before the earliest date, today marked. No second store: tasks
  are `JobTask` rows through the same `/jobs/:id/tasks` routes (now taking
  `startDate` and `scopeItemId`, the latter checked to be this job's), edited
  in a panel under the chart, never a dialog. Bars are placed with `calc()` on
  `--gantt-cell` — the one token for the day width.
- **"Plan from costing" is `POST /jobs/:id/tasks/from-costing`**: the
  costing's `ScopeTask`s, planned in working days (`planTasks`), written as
  dated tasks from the project's start date through `workingDayDate()` in
  `shared/day.ts` (Mon–Sat since 2026-10-13; a Sunday start counts from the
  Monday after).
  Only scope lines with NO tasks yet are planned, so a second run overwrites
  nobody's hand work (`{ created, skipped }`); a planned line's dates become
  its tasks' span, which the planned S-curve reads. Audited. Needs a start
  date, and says so.

## Request for Approval (2026-10-13)

The owner's call: "replace the Approved Plans with Request for Approval — a
form with internal approval (Technical Manager, Team Leader and the CEO more
than 1 million project costing) and a Drawing Reference Number (it could be
from a CAD J.O.)". `routes/planApprovals.ts` (`/api/plans`),
`pages/delivery/PlanApprovals.tsx`.

- **The record is the old `ApprovedPlan`, routed now.** Its table and keys
  stay (`gops.plans.*` OWNED; the registry label, the project tab and the
  register say "Request for Approval"; `/g-ops/plans` and `?tab=plans`
  hold), with `number` (numbering type `plan_approval`, GT-RFA-2026-0001 —
  indexed, not @unique, because a unique constraint on an existing table
  stops the server's unattended `db push`), `description`, `amount`,
  `cancelReason`, and the statuses DRAFT → PENDING_APPROVAL → APPROVED,
  SUPERSEDED, CANCELLED (FOR_APPROVAL is the old registered-by-hand state:
  the seed moves any left to DRAFT; REJECTED is history). The requester is
  `uploadedById`. **Nobody approves one by hand**: the old `PATCH
  /jobs/:jobId/plans/:planId { status }` and its POST/DELETE are gone.
- **The route is the engine's `plan_approval`** (rule 2): seeded "Request
  for Approval — technical manager, team leader" (up to ₱1,000,000) and
  "… then CEO / President over ₱1,000,000" (`minAmount` 1,000,000.01),
  both `preparerSigns` and `standIns` as the costing's. The amount is the
  PROJECT's contract value, snapshotted onto `amount` at submit.
  `POST /plans/:id/submit` claims DRAFT, numbers a legacy row, refuses with
  no file attached, files the request in the requester's name and goes back
  to DRAFT if the engine refuses; `/withdraw` pulls a pending one back
  (`cancelOpenRequest`, same transaction); `/cancel { reason }` cancels a
  draft or a pending one; `DELETE` takes a draft or a cancelled one
  (`gops.plans.delete` + `canEditRecord`), its files and its CAD link with
  it. `settlePlanApproval()` claims PENDING → APPROVED (dated, `approvedBy`
  the last signer) and SUPERSEDES an earlier approved request on the same
  project and drawing reference (case-blind); a return or a rejection goes
  back to DRAFT; a decision after a cancel is "not applied". The Technical
  Manager and the project engineer raise them (`VIEW_OWN_SELF('gops',
  'plans')`); `audit-workflows.ts` knows.
- **Reading one**: `view_all`, its requester, or — through
  `requireAnyOrDecider` — whoever may decide its open request (a Team
  Leader or the CEO with no right to the module). The files are attachments
  on `approved_plan` with a guard: read as the request, written only on a
  draft by whoever may edit it — what the approvers decide on is what they
  were sent. A request takes drawing files (DWG and the rest, the CAD
  ceiling: `isCadEntity`).
- **The page** `/g-ops/plans/:id` (no Guard — the API decides): RecordHeader
  (Submit for approval, Print, ⋯ Pull back / Cancel request / Delete,
  Modify on a draft), "Submit for approval sends it to …" on a draft
  (`approvalRoute`, `previewSteps`), the `DocumentApproval` panel once sent,
  The request card and the Drawings and documents card. **The paper**
  "Request for Approval" through `renderDocument`: the project, the drawing
  reference, the request, Requested by and one slot per step
  (`approvalSlots`, a draft printing the route it would take), and the files
  behind it (`withAttachments`, `?attachments=0` bare). **The register**
  `/g-ops/plans` is a DataList over `planListWhere()` with its paper
  `GET /plans/pdf`; a project's tab lists its own from `GET /jobs/:id`'s
  `plans`.
- **The form** ("+ New request for approval" on the tab, Modify on a
  draft): what is to be approved, description, drawing reference number,
  revision, discipline, notes — or **From a CAD J.O.**
  (`GET /plans/cad-options?jobId=`: the project's accepted drawings not yet
  raised), which takes the reference and copies the files through
  `requestFromCad()`.

## People Flow (2026-10-13)

The owner's `PEOPLE_FLOW_FROM_START_TO_SEPARATION` file — Onboarding,
Integration, Development & Growth, Retention & Engagement, Separation — as
one path per person (`docs/notes/P-scope-dates-rfa-people-flow-2026-10-13.md`
§6). G-HR › People › **People Flow** (`ghr.people_flow`: `view_all` and
`edit_all` for HR, `view_own` for everyone through the `employee` and
`supervisor` roles), `/g-hr/people-flow` and `/g-hr/people-flow/:employeeId`,
`routes/peopleFlow.ts`, `shared/peopleFlow.ts`, `pages/hr/PeopleFlow.tsx`,
`styles/people-flow.css`, verify-hr.

- **The checklist is data**: `hr.peopleFlow`, a Settings list on HR
  Settings' People Flow card (`SETTING_LISTS` in `routes/hr.ts`, a row
  schema of its own: stage, key, title, description, `dueDays`, `source`).
  Unstored it reads as `PEOPLE_FLOW_DEFAULTS` — the owner's file, eighteen
  items. A key is permanent (rename the title freely); one used twice is a
  400. `dueDays` counts from the hire date for Onboarding and Integration
  and from the last working day for Separation (negative is before it);
  Development and Retention are a steady state with no due date.
- **What HR recorded is `EmployeeFlowItem`** (employee × item key, unique;
  PENDING / DONE / WAIVED / NA, `doneOn` a DATE, notes, who and when). A row
  exists only once HR has said something; the path is the checklist merged
  with the rows and the records on EVERY read (`pathsFor()`: five queries
  whatever the number of people). `PUT /people-flow/:employeeId/items/:key`
  (`edit_all`): DONE on a day (today by default, never tomorrow), WAIVED
  with a reason, NA, or open again; audited as `people_flow` on the
  employee's id. Files on an item are attachments on `employee_flow_item`
  with entityId `<employeeId>~<key>` — read by whoever reads the path,
  written by HR alone; deleting an employee deletes them.
- **Six items follow a record** (`source`, the clearance's rule): the
  probation review ← the latest APPROVED evaluation (REGULARIZE / ABSORB /
  END done; EXTEND still open, saying to when; a regular employee done; a
  project-based, contractual or part-time one not applicable; due at the
  period end), skill building ← VERIFIED training records, notice ← a
  clearance raised, knowledge transfer ← the clearance's handover lines
  (`HANDOVER_SOURCES`, the SUPERVISOR scan's types), access and property ←
  the clearance's other lines AND the login closed, the clearance
  certificate ← the clearance CLEARED. Such an item is never ticked by
  hand (a 400 naming the record), only waived with a reason or put back to
  follow its record; a done one offers nothing.
- **The stage is derived, never stored** — `stageOf()`, pure, on
  'YYYY-MM-DD' keys: SEPARATION once a clearance stands (OPEN, PENDING or
  CLEARED, raised since the hire) or a separation date is on file;
  ONBOARDING for the first `ONBOARDING_DAYS` (30; a future hire is in
  pre-boarding) and after that while an onboarding item is open within the
  new-hire window (the typed period end, else `probationMonths` from the
  hire); INTEGRATION while PROBATIONARY or a TRAINEE, or within the window
  while an integration item is open; then DEVELOPMENT until the first
  anniversary and RETENTION after it. **This departs from the plan's
  "Onboarding while any onboarding item is open"**: on deploy nobody's
  onboarding is recorded, and that rule would have put every employee in
  Onboarding — past the window, only the dates decide. An item is overdue
  only in the stage the person stands in, so nobody is chased for an
  onboarding left open years ago.
- **Who reads**: HR everyone; the person their own (`GET /mine`); a
  supervisor holding `ghr.dashboard.view_all` their DIRECT REPORTS' (the
  clock capture's rule, `mayReadFlow()`); anyone else a 404. `/:employeeId`
  carries no Guard on the web — the API decides.
- **The screens**: for HR, seven tiles (a stage each, With overdue items,
  Probation reviews due — within a week or overdue) over the shared list
  (Employee, Department, Hired, Stage, Open, Overdue, Next; filters `stage`,
  `overdue`, `probation`, `departmentId`), each tile linking to the list it
  counts (the summary is computed under everything but those three filters,
  so a tile equals the list it opens — verify-hr asserts it). The list is
  computed for every visible ACTIVE employee and paged after the stage
  filter. Everybody else: their own path, and — with the dashboard right —
  "My direct reports" (`?reports=true`). The path page is a `RecordHeader`
  (the stage as its pill), a five-step strip and a card per stage; HR's
  "Record…" / "Waive…" opens a panel under the item, never a dialog. The
  employee record has a People Flow tab for `view_all`. The list prints
  (`GET /people-flow/pdf`, above `/:employeeId`, `?ids=`, audited); no
  paper per person.
- **My Work** (`peopleFlowWork()`, appended to `assignedTo`): for HR, the
  open items of each person's current stage that are overdue or due within
  `DUE_SOON_DAYS` (7), ten at most; for the person, their own open
  onboarding items while they stand in Onboarding ("HR ticks it off").

## The purchase requisition page (2026-10-13)

The owner's call: "Purchase request in Project should not be popup window, it
should be a full form with line item and budget allocation, something like in
gasiontech G-CORE" (the mockup, approved first: `docs/mockups/purchase-
requisition-page.png`). `pages/chain/PurchaseRequisitionEditor.tsx`,
`lib/prLines.ts`, the `prq-*` rules in `styles/procurement.css`.

- **One page for New and Modify**, never a dialog: `/g-ops/purchase-requests/
  new?jobId=` (the project's Purchase Requisition tab — the project fixed,
  direct to project), `/g-chain/purchase-requests/new` (the register — Kind
  and Project or Warehouse chosen) and `/…/purchase-requests/:id/edit` on a
  draft (the record page's Modify). `PrModal` and `PrLineModal` are gone; an
  old `?new=1&jobId=` link redirects to `/new`. The record page keeps no line
  buttons of its own — its lines change on the page, with the header.
- **One save**: `POST /purchase-requests` takes `lines[]`, `PUT /purchase-
  requests/:id/sheet` the header and the lines (a line sent with its `id` is
  updated in place, one left out removed — the costing sheet's rule), claimed
  on DRAFT and on the `version` (`updatedAt`) the page read: "changed a moment
  ago — reload". `checkPrLines()` checks every line before the number is
  issued — the item and budget line exist, the line says what it is, a direct-
  to-job line names its budget line (else the item's) or is refused naming it
  — and `writePrLines()` writes them. The single-line routes stay for scripts.
- **A line** is Budget line | Part No. | Item (bold, `PurchaseRequestItem.
  name`) over its description | Unit | Qty | Est. unit cost | Amount
  (`prLineAmount`, the server's `cents()`); `partNumber` and `name` are new
  nullable columns, a name alone is the description too. The request has a
  `preferredSupplier` (text, a hint for purchasing; printed).
- **Filled three ways**: typing in Item asks `GET /purchase-requests/suggest
  ?q=&jobId=` — the project's costing lines, then the item master (a cost only
  to a costing or budget reader or the project's manager, an item's standard
  cost to an item or costing reader); **Add from costing…** (a panel of tick
  boxes, the costing's lines with their quantity); **Import CSV** or a block
  pasted into an empty Item box — `parseDelimited()` / `rowsToPrLines()`,
  pinned by verify-foundation: headings read by name, else the page's column
  order from Part No.; a row that cannot be read is named, never dropped.
- **Budget — live** beside the lines: `GET /purchase-requests/budget?jobId=`
  (`projectBudgetByLine()`, every active category in one GROUP BY, equal to
  Budget Monitoring — verify-chain asserts it) less what the page asks, per
  budget line and overall, red where it goes over and saying whether submit
  will be refused (`procurement.blockOverBudget`). A draft commits nothing.
- **The record page's "Against the project budget" card** leaves the
  request's OWN net commitment out (`GET /purchase-requests/:id`'s
  `budget`): an approved request committed its estimate, and counting it in
  "Already committed" and again as "This request" read as an overspend
  (2026-10-14, the owner's report). The card shows only while the request is
  a draft, pending or approved — once ordered, the order's page holds the
  budget — and its "Submitting it will be blocked" note only before submit.
- **Approval** under the lines: `GET /purchase-requests/route?amount=&jobId=
  &requestId=` (`routeBrief`, the requester's name) through `previewSteps` —
  nobody is picked on the form. "Submit for approval" saves, then submits; a
  refused submit leaves the saved draft and says why.

## The purchase order page (2026-10-13)

The owner's call, after the requisition page: "do the same full page for
purchase orders". `pages/chain/PurchaseOrderEditor.tsx`, in the requisition
page's dress (`prq-*`) and reusing its `ItemCell` and `lib/prLines.ts`.

- **One page for New and Modify**: `/g-chain/purchase-orders/new` — with
  `?fromRequest=` or `?fromCanvass=` the request's lines are on the page
  before anything is saved — and `/g-chain/purchase-orders/:id/edit` on a
  draft. `NewPoModal`, `PoHeaderModal` and `PoLineModal` are gone; the
  request page's "Raise order" and the canvass's order button open the page,
  and an old `?fromRequest=` / `?fromCanvass=` link on the list redirects.
- **What an order starts with is `orderSource()`** — the request, the
  canvass, the supplier an award decided, the lines still to order (the
  winner's quoted prices, else the request's estimates), with the request
  line's part number and name. `GET /purchase-orders/draft` shows it and
  `POST /purchase-orders` writes it, so the page shows what a save writes.
- **One save**: `POST /` takes `lines[]` (sent without, the source's lines,
  as before); `PUT /:id/sheet` the header and the lines, claimed on DRAFT
  and the `version` read. `checkPoLines()` before the number: a line's
  `requestItemId` must be one of the order's request's, the item and budget
  line exist, a direct-to-job line names its budget line; `writePoLines()`
  keeps a line sent with its id. The awarded supplier still cannot be
  swapped. `PurchaseOrderItem.name` and `partNumber` are new nullable
  columns; the order's paper prints both.
- **The money** is `orderTotals()` in `lib/prLines.ts`, `recalcPo()`'s rule
  to the centavo (verify-foundation pins it), with the "Supplier prices
  include VAT" tick on the page.
- **Budget — on issue**: `GET /purchase-orders/budget?jobId=&requestId=` is
  `projectBudgetByLine()` plus `released` — the request's net commitment per
  budget line, which issuing releases whole before it commits the order's
  lines; the panel shows what is left after issue. Line suggestions are
  `GET /purchase-orders/suggest` (`lineSuggestions()`, the requisition's
  rule behind the order's rights); the route is `GET /purchase-orders/route
  ?amount=&orderId=` at the order's total, in its buyer's name.
- **The order's paper goes to the supplier, in the owner's layout**
  (2026-10-14, `docs/mockups/purchase-order-layout.pptx`, his slide):
  the title in bold (`titleBold`, this document only), "Date: …" under
  the number (`renderDocument`'s `numberNote`); DETAILS
  is columns (`details`, an array of columns: the quotation reference
  over the delivery date, the terms beside them), and the section after
  it follows straight on rather than at the fixed DETAILS height; then
  **Supplier** and **Ship to** side by side as unlabelled 8.5pt address
  blocks (the engine's `blocks` section) — the supplier's name, address,
  the contact's mobile (else the supplier's phone), the contact person
  (primary, else first) and email; our registered name, the order's
  Deliver to (else the company's address), the company's phone and
  email, and the buyer who prepared it with their position (the owner's
  second slide, 2026-10-14). Then the lines, totals
  and notes, and over the sign-offs the italic "The name, date and time
  are considered a digital signature of approval." (`signoffNote`). Never
  "For" (internal), the supplier's TIN, the purchase request or a Status
  line — a draft or pending order says "DRAFT — NOT YET ISSUED." in the
  footer note, a cancelled one "CANCELLED.". `PurchaseOrder.quoteRef`
  (nullable) is the supplier's quotation no. — "Quotation ref." on the
  order page, filled from the awarded canvass row's `quoteRef`, editable
  while a draft.

## G-CHAIN's flows (2026-10-14)

The owner's six of 2026-10-14 (`docs/notes/P-chain-flow-2026-10-14.md`,
previews `docs/mockups/chain-flow-*.png`), built push by push.

- **The divisions run G-OPS, G-CHAIN, G-FIN, G-HR** — the registry's
  module order (the launcher's `DIVISIONS` in `pages/Home.tsx`, the top
  bar and Ctrl+K follow it); verify-foundation pins it with the strips.
- **Procurement** is Purchase Requests, RFQ, Canvass, Purchase Orders and
  **Warehouse** is Incoming, Inventory, Outgoing, Borrow Slips, Pull-out
  Slips (`PROCUREMENT_STRIP` / `WAREHOUSE_STRIP` in verify-foundation, the
  strips as built so far). **Incoming and Outgoing are Receiving and Stock
  Issuance renamed**: the registry KEYS (`receiving`, `stock_issuance`) and
  every permission string stay, so no right moved; the paths are
  `/g-chain/incoming` and `/g-chain/outgoing`, and the old
  `/g-chain/receiving[/:id]` and `/g-chain/stock-issuance[/:id]` land there
  (`MovedTo` in `App.tsx`, the query kept) — notifications already sent
  carry the old links. The papers are "Incoming", "Outgoing" and the slip's
  "Delivery Receipt" (since 2026-10-15); the numbering labels "Incoming Report" and "Outgoing Slip" (the
  seed updates labels only, so RR and SI stay unless an administrator
  changes them).
- **The Request for Quotation is its own document** (push 2;
  `routes/rfq.ts` at `/api/rfqs`, `pages/chain/Rfq.tsx`, `gchain.rfq.*`
  OWNED, numbering type `rfq` — GT-RFQ-2026-0001). It is raised FROM an
  APPROVED (or partially ordered) purchase request — the request page's
  "Request quotations", its one next step, or "+ New RFQ", which asks which
  approved request first (`GET /rfqs/requests`) — and asks some or all of
  its lines (`RfqItem`; a line already on another open RFQ starts unticked
  and says so, `GET /rfqs/source`). **No approval route**: an enquiry
  decides nothing. DRAFT → SENT ("Mark sent", which dates it and each
  supplier row) → QUOTED (the first quote) → CLOSED (its canvass awarded,
  push 3); CANCELLED with a reason from any open state, refused while a
  canvass compares it. **One save** (`POST /rfqs`, `PUT /rfqs/:id/sheet`,
  claimed on `version`; a field left out is kept): the header (Quote by,
  Deliver to — the project's site, else the warehouse — the terms printed
  for every supplier, internal notes), the lines while a draft, and the
  suppliers asked (`RfqSupplier`, a row's own Attention / Tel / Email,
  filled from the supplier's primary contact by `GET /rfqs/contacts`).
  Once sent its lines are fixed; a supplier added later is asked that day;
  a supplier who quoted is never removed. **Quotes** are recorded per line
  asked (`RfqQuote`, `PUT /rfqs/:id/suppliers/:rowId/quote`; a line left
  blank is not quoted) with their quotation no., received date, lead time,
  terms and validity, in a panel under the suppliers (never a dialog), the
  supplier's own paper attached to the row (`rfq_supplier`, guarded as the
  RFQ is read; written while open by whoever may edit it). **Printed
  only** (the owner's call — no email): `GET /rfqs/:id/pdf?supplier=` is
  ONE supplier's paper, addressed to them, every line with blank Unit
  price, Amount and Lead time columns for them to fill, never another
  supplier's name or price; without it the RFQ whole, with each supplier's
  totals. Both print **Prepared by** with its timestamp and nothing else to
  sign (rule 6: the people who acted). The list (`rfqListWhere`, its paper
  `GET /rfqs/pdf`, `?ids=`), Ctrl+K and the audit trail as every register.
  A purchase request is not cancelled while an RFQ is open on it, and its
  delete takes its cancelled RFQs' files. **The canvass gave the RFQ its
  code**: `moveCanvassCode()` (`shared/canvassCode.ts`, the seed, once,
  marked `seed.canvassCountersMoved`, audited) moves the canvass's numbering
  from 'RFQ' to 'CVS' — the template AND every period counter, because a
  counter prints with its own copy of the code (Admin › Numbering changes
  every row for the same reason); the first version moved the template
  alone under `seed.canvassCodeMoved`, so an install that ran it is put
  right once. Only while the template carries 'RFQ' or 'CVS' — an
  administrator's own code stays. Numbers already issued keep their print.
  Procurement holds `gchain.rfq.*`, Back Support reads them.
- **The canvass is the COMPARISON SHEET** (push 3; the owner's sample
  sheet). "Start canvass" on the RFQ page (its next step once a quote is
  in; `POST /canvasses { rfqId, supplierRowIds? }`) raises it from an RFQ
  that went out, one live sheet per RFQ, and SNAPSHOTS the RFQ's lines
  (`Canvass.lineIds`), the suppliers that quoted — six at most
  (`MAX_SHEET_SUPPLIERS`; more and the page asks which six) — with their
  quotes, contact, lead time, terms and quotation no. (`CanvassSupplier.
  rfqSupplierId`); a quote changed on the RFQ later moves nothing until
  "Refresh from RFQ" (⋯, edit_all, OPEN only) copies again. A canvass from
  a request with no RFQ (`{ requestId }`, a quote already in hand) still
  compares every line, suppliers typed on it — `lineIds` empty is "every
  line", as every canvass before. **The arithmetic is
  `canvassFigures()`** (`shared/canvassMath.ts`, pure, verify-chain): the
  REFERENCE BUDGET is the request's estimated amount over the sheet's
  lines; per supplier `total` = Σ qty × price over the lines it quoted
  (centavos, half away from zero), `savings` = the estimate over THOSE
  lines less the total, `savingsPct` to two decimals; a partial quote says
  "n of m lines" / "on the lines quoted" and is never "lowest complete".
  The buyer may **Recommend** a column (`PATCH { recommendedRowId }`, the
  opener or edit_all — the header's primary button becomes "Award to …");
  **Award** (edit_all) is claimed on OPEN, records `awardedById` /
  `awardedAt`, refuses a supplier that quoted none of the sheet's lines and
  CLOSES the RFQ; the order then takes only the lines the winner quoted.
  Cancelling an award no order was placed on opens the RFQ again (QUOTED);
  an RFQ is not cancelled while a live sheet compares it. Prices typed on
  the sheet only for its own lines, audited. **The paper** `GET
  /canvasses/:id/pdf` is LANDSCAPE "Canvass Sheet": the reference line (PR
  and its approval date, RFQ, project), the lines with the reference
  budget's unit cost and amount, then per supplier a unit cost and amount
  under its name, Tel No. and contact — the table's **`groups`** band, a
  `renderDocument` table option naming runs of columns over the head,
  redrawn with it on every page — "not quoted" where it gave none; then
  TOTAL, SAVINGS vs reference budget (pesos | %) and Lead time · Terms,
  each figure in its own column (those rows are the sheet's structure, as
  a costing's subtotals are the estimate's); three suppliers to a table, a
  second table for four to six; Remarks (`notes`, with the
  recommendation); the order raised; signed **CANVASSED BY** (the opener,
  its timestamp) and **AWARDED BY** ("Pending" until awarded). The list
  (`canvassListWhere`, view_own narrowed to what one opened, filters
  `status`, `rfqId`, `requestId`, `supplierId`) shows the RFQ, the
  reference budget and the saving of the award (else the lowest complete
  quote), with Open and Awarded cards; its paper is landscape. The page is
  `pages/chain/Canvass.tsx` (moved out of `Orders.tsx`).
- **Incoming and Outgoing go for approval** (push 4a; the owner's call:
  "approval of his/her report to"). Seeded "Incoming — the receiver's
  supervisor" (`receiving`) and "Outgoing — the issuer's supervisor"
  (`stock_issue`): one SUPERVISOR step each, the warehouse person's
  "Reports to", falling back to the new **Warehouse Supervisor** role
  (`warehouse_supervisor`, seeded from the warehouse role's rights) on
  their team, else any holder. **Assign "Reports to" on every warehouse
  login, or give somebody Warehouse Supervisor** — until then a submit is
  refused for want of an approver and `audit-workflows.ts` says so.
  `ReceivingStatus` DRAFT → PENDING_APPROVAL → RECEIVED, or CANCELLED with
  `cancelReason` (the column defaults to RECEIVED, so every report on file
  stays as it was); `IssueStatus` gains PENDING_APPROVAL. **A draft moves
  nothing**: `POST /receivings` saves a DRAFT while the route is active
  (`needsApproval` in its answer) and posts at once only when the route is
  switched off — the sales order's rule; `/submit` claims the draft on
  `updatedAt`, files the request in the RECEIVER's name, and goes back to
  DRAFT if the engine refuses; `/withdraw` and `/cancel { reason }`
  withdraw through `cancelOpenRequest` in the same transaction. A report
  waiting for approval COUNTS against what its order can still take
  (`checkOutstanding`), so two cannot both receive the last ten; a
  cancelled one gives it back. `settleReceiving()` / `settleStockIssue()`
  (exported, idempotent) claim PENDING_APPROVAL and post in the same
  transaction — the stock, the order's received quantities and status,
  the job's commitment and cost (`postReceiving`, `postStockIssue`, the one
  posting each, shared with the unrouted path); a return or rejection puts
  it back to a draft; a decision after a cancel or withdrawal is "… — not
  applied"; an approval the shelf or the order can no longer honour goes
  back to a draft, said on its trail and by a `warehouse.not_posted` bell,
  never half posted. **Issue is refused while the Outgoing route is
  active** ("goes for approval"); a slip is checked against the shelf at
  submit. Only goods RECEIVED count anywhere money looks: a supplier bill
  is matched to a RECEIVED report only (`billLinks`), finance's unbilled
  queue, Supplier 360 and the Incoming list's "Total received" (the rest in
  brackets) read RECEIVED. **Attachments**: the packing list, the DR and
  photos on `receiving`, the signed gate pass on `stock_issue` — read as
  the document is (a decider through `mayDecide`), written while DRAFT or
  pending by whoever may move it on — and both papers print them behind
  (`withAttachments`, `?attachments=0` bare). The papers sign RECEIVED BY /
  PREPARED BY, then the route's step ("Pending" until signed), then on
  the Delivery Receipt the driver and the receiver (see "Outgoing is the
  requestor's RECEIVE PROOF"); an unrouted slip still prints "Issued by".
  The record pages show "Submit for approval sends it to …", the Approval
  panel once sent, and Pull back / Cancel in ⋯; the supervisor's door is
  `requireAnyOrDecider` on the record and its paper.
- **Incoming Reports, with or without a purchase order** (2026-10-14,
  the owner's call). `Receiving.orderId` and `ReceivingItem.orderItemId`
  are nullable: a report WITHOUT an order names `supplierId` or
  `sourceName`, a `reason`, a warehouse (required), and per line an item
  (`ReceivingItem.itemId`, `description`, `unit`) with the unit cost it is
  taken into stock at; approved, it builds stock only — no order, no
  project, no supplier bill (finance's unbilled queue and bill matching
  skip it). `checkReceivingSheet()` is the one check for create and
  `PUT /receivings/:id/sheet` (a draft, modified whole, claimed on
  `version`); `postReceiving()` posts either kind. The page is
  `pages/chain/IncomingEditor.tsx` (`/g-chain/incoming/new`,
  `?order=` from the purchase order's "Receive goods" — the pop-up is gone;
  `/:id/edit` on a draft), fed by `GET /receivings/options`, `/order/:id`
  (each line's ordered, received, pending and left), `/items` and
  `/route`, all behind the receiving rights. The list is **Incoming
  Reports** (+ New incoming, a From column, cards, `?against=order|none`).
  **The route is "Incoming — back support, purchasing manager"**
  (`preparerSigns`, `standIns`; Back Support team-scoped), the
  supervisor's route RETIRED. The paper is the purchase order's dress:
  ORDER DETAILS, Received from / Received at, the lines, Prepared by and
  the steps. The record page has no web Guard (the API decides — the
  approvers may hold no warehouse right). verify-chain pins both kinds.
- **The inventory screen** (2026-10-14, then the owner's PPTX of
  2026-10-15): cards (Total items, Total valuation, Reorder warning,
  Critical, Pending POs) from the list's `summary` under its own query; a
  **category tile** per item category (its items, value, low/critical
  flags, what it covers — `ItemCategory.description`, `sortOrder`; the
  first eight always, any other holding stock), each a link that sets
  `?categoryId=`; Filters Category, **Stock status** (`?state=`), Warehouse,
  Reorder; columns Part number, Item description, Category, **Brand / OEM**
  (`Item.brand` — the manufacturer, not the supplier; the item form, the
  import's `Brand` column, the item paper), Bin / Rack
  (`InventoryBalance.locationId`, set on the stock card by
  `gchain.inventory.edit_all` through `PATCH /inventory/balances/:id`, or
  by a receipt into a named bin while empty), Stock qty, Unit cost, Reorder
  pt, Status; a "Stock value by category" bar chart; the movement log and
  Quick operations under it. **`stockState()` in `shared/chain.ts` is the
  one rule**: CRITICAL (nothing available, or at/under `minStock`),
  LOW_STOCK (at/under the reorder level), ON_ORDER (either, with an issued
  PO still to arrive), IN_STOCK — the column, the filter, the cards, the
  tiles and the paper. The seed adds the owner's eight categories (PMP,
  CTL, INS, PRT, CNS, FLT, DRY, PIP) and moves the first nine after them.
- **The automatic reorder** (2026-10-15, the owner's call: "Automatic").
  `shared/reorder.ts`: `issueStock` and `borrowStock` queue the item and
  warehouse (`queueReorderCheck`, run ~1 s after, outside the caller's
  transaction; an item master save that touches the level queues it too);
  `runReorderCheck()` adds an item at or under its reorder level, with
  nothing already on the way (open request lines left to order, issued POs
  left to receive), to its warehouse's ONE `PurchaseRequest.autoReorder`
  DRAFT stock replenishment — under an advisory lock, never twice —
  quantity 2 × level − available − on the way, the estimate the item's
  standard cost (else last, else average), the line's description saying
  why. **The system never submits it** (rule 2): the requester — the first
  active Warehouse Supervisor, else the Purchasing Manager (the seed gives
  the supervisor own-scope purchase-request rights and delete) — is told
  (`reorder.raised`) and checks and submits it. With neither role held,
  nothing is raised and the trail says why. verify-chain pins it.
- **Outgoing is the requestor's RECEIVE PROOF** (2026-10-15, the owner's
  call: "Outgoing = internal receive proof to the requestor … no customer
  involved"; his "Outgoing Delivery Receipt Slip" as the guide).
  `pages/chain/Outgoing.tsx` holds the list, the PAGE editor
  (`/g-chain/outgoing/new`, `/:id/edit` on a draft — the modals and the
  per-line routes' UI are gone) and the record page, which has no web
  Guard: the API lets in the register's readers, the supervisor while it
  waits on them, and **the person it was issued to** (`issuedToId`,
  `visibleIssue`, the attachment guard), who may hold no warehouse right.
  The slip names who asked (`issuedToId`, else a name for someone with no
  login), `referenceNo`, `deliverTo`, `carrier`, `driverName`, the
  `instructions` (terms of receipt — `OUTGOING_TERMS` on a new slip,
  editable) and per line `serialNo`, `condition`, `remarks`, `sortOrder`.
  One save: `POST /stock-issues { lines }` and `PUT /:id/sheet` (DRAFT,
  claimed on `version`, lines replaced and re-priced) through
  `checkIssueLines()` — each item held at the warehouse with that much
  AVAILABLE, a project line's budget line from the item — before a number
  is issued; `GET /stock-issues/options` (warehouses, what one holds, the
  terms) and `/route` sit above `/:id`. **Issued, the receiver confirms
  it**: `POST /:id/receive { note }` — the person it went to, or
  `edit_all` recording a signed paper copy (the note says who entered it
  for whom) — once, claimed on `receivedAt` being empty; the issuer is
  told (`warehouse.received`). Issue and approval tell the receiver
  (`warehouse.issued_to_you`) and My Work lists their unconfirmed slips.
  The list: Requested by and Received columns, `?received=yes|no` and
  `?warehouseId=`, cards Waiting for approval / Drafts / Issued / Not yet
  confirmed received, counted under everything but those two filters
  (`issueListWhere` → `{ base, where }`). **The paper is a "Delivery
  Receipt" with no prices**: DELIVERY DETAILS (reference, project, dispatch
  warehouse, carrier), "Received by" beside "Deliver to", the items with
  serial and condition, the purpose, notes, terms and what was noted on
  receipt, then Prepared & dispatched by → the route's step → Delivered by
  (the driver, dated at issue) → Received in good order by (dated when
  confirmed, "Pending" until). A list paper is "Outgoing", its rows
  "outgoing slips".
- **An email prints on ONE line** (2026-10-14, the owner's call): in the
  `blocks` sections and `renderDocument`'s sign-offs an address too wide
  for its column is drawn smaller (`fitSize()`, 6pt the floor), never
  broken; an email in a block is never underlined.
- **Anyone asks to borrow** (push 4b; the owner's call: "anyone can request
  to borrow; approval by the Team Leader / Technical Manager they report to
  or within the team; the warehouse processes it, with its reports-to's
  approval"). `gchain.borrow_slips` is OWNED_KEPT now and the `employee`
  role holds its own scope, so everyone has Borrow Slips. `BorrowStatus`
  gains DRAFT → PENDING_APPROVAL → APPROVED before OUT, and CANCELLED with
  `cancelReason`; `requestedById`, `neededOn` and `releasedAt` are new and
  `issuedById` (who RELEASED it) is null until the release. **Nothing leaves
  the shelf before the release**: `POST /borrow-slips` saves a DRAFT request
  in the caller's own name (a borrower or `borrowerId` for somebody else is
  the warehouse's alone — `edit_all` writes a walk-in's slip), checked
  against what the warehouse holds AVAILABLE and never due back before
  today (`checkBorrowSheet`); `PUT /:id/sheet` modifies a draft whole;
  `/submit` (in the REQUESTER's name), `/withdraw` and `/cancel { reason }`
  (draft, pending or approved — the warehouse's "not on the shelf" tells
  the requester) as every routed document; `POST /:id/release` (`edit_all`)
  claims APPROVED and moves every line out of available in the same
  transaction (`lendItems`), dated that day; `/return` takes only a slip
  on loan. Route switched off: the warehouse's own slip goes OUT at once,
  anyone else's is saved APPROVED for the release. Seeded **"Borrow slip —
  team leader, warehouse"** (`preparerSigns`): step 1 SUPERVISOR named Team
  Leader / Technical Manager — the "Reports to", else Team Leaders on the
  requester's team — **plus every Technical Manager on the requester's own
  team**: the engine's new **`ApprovalStep.alsoRoleIds`** (SUPERVISOR only;
  `teamHoldersOf()` in `shared/approvals.ts`, strictly the team, never
  every holder; `holdsStep` counts them, so a Technical Manager's own
  request is signed at submit; Admin › Approval Workflows edits it as "Also
  decides it, on the requester's team" and a PUT that leaves it out keeps
  it), then step 2 ROLE `warehouse_supervisor`. Approval tells the warehouse
  (`borrow.to_release`, the warehouse and Warehouse Supervisor roles); the
  release tells the requester and borrower. Reading: `view_all`, or the
  requester / borrower (`view_own`), or a decider through
  `requireAnyOrDecider` — the record page has no web Guard. The list
  (`borrowListWhere` → `{ base, where }`, Mine · All for the warehouse,
  Mine only otherwise) carries summary cards — Waiting for approval, To
  release, On loan, Overdue — and prints; the slip's own paper `GET
  /:id/pdf` signs REQUESTED BY, the two steps and RELEASED BY (ISSUED BY on
  a slip from before requests). My Work lists the warehouse's approved
  requests to release and what a person holds due back within three days.
  The clearance scan counts only slips on loan. `pages/chain/
  BorrowSlips.tsx` holds the list, the request page (`/new`, `/:id/edit`)
  and the slip, moved out of `Warehouse.tsx`.
- **Pull-out slips** (push 4c; the owner's call: "Pull-out Slip — approved
  Sales Order, or from Purchase Request"; "if no project was created, the
  sales order is enough"). `PulloutSlip` + `PulloutItem` (new tables;
  numbering `pullout_slip`, GT-PS-2026-0001; `gchain.pullout_slips`
  SHARED_KEPT, held by the warehouse roles; Warehouse › **Pull-out Slips**,
  last on the strip — verify-foundation pins it), `routes/pullouts.ts` at
  `/api/pullout-slips`, `pages/chain/PulloutSlips.tsx`. `kind` SALES_ORDER
  (an ISSUED order — the customer's delivery) or PURCHASE_REQUEST (an
  APPROVED or partly ordered DIRECT_TO_JOB request — the project takes from
  the shelf instead of buying; a stock-replenishment request is refused).
  `loadSource()` is the one reading of a source: its lines with what is
  LEFT (a sales order line less what pending and pulled-out slips took; a
  request line less `orderedQty`, `pulledQty` and pending slips) and, for a
  sales order line, the item whose part number or code matches; the project
  charged is the request's, or the one built from the order's quotation,
  else none. `checkSheet()` is the one rule for create, modify, submit and
  posting: each line answers a source line and takes no more than is left,
  a request line that names its item takes that item, the warehouse holds
  enough AVAILABLE, and a project charged knows each line's budget line.
  DRAFT → PENDING_APPROVAL → PULLED_OUT, or CANCELLED with its reason;
  seeded **"Pull-out slip — the warehouse's supervisor"** (SUPERVISOR,
  fallback `warehouse_supervisor`); with the route off "Pull out" posts at
  once (the Outgoing rule). **Posting is `postPullout()`**, in the claim's
  transaction: the stock out at the warehouse's average (`issueStock`); a
  request line's new **`PurchaseRequestItem.pulledQty`** grows — what is
  left to order is quantity − ordered − pulled (`fromRequestItem`, the PO's
  "fully ordered" test), the request becomes PARTIALLY_ORDERED or ORDERED as
  it is covered, and its commitment is released by the pulled quantity at
  its estimate; a project is charged INCURRED + CONSUMED by budget line, the
  stock issue's rule; a sales order with no project posts no job cost.
  `settlePullout()` (exported, idempotent; a shelf that can no longer honour
  it sends the slip back to a draft with a bell; "not applied" after a
  cancel). The sales order's or request's owner is told (`pullout.done`).
  The paper "Pull-out Slip" prints NO cost (it travels with the delivery):
  the lines against the source lines they answer, PREPARED BY, the step,
  RELEASED BY and RECEIVED BY (the name on the slip), attachments behind
  (`pullout_slip`). A request is not cancelled, and a sales order not
  reopened or cancelled (`refuseWhilePulledOut`), while a slip stands on it.
  The sales order page's ⋯ "Pull out stock…" and the request page's ⋯ "Pull
  out from stock…" open `/g-chain/pullout-slips/new?salesOrder=` /
  `?request=`; both pages show a **Pulled out** card (`PulloutCard`, the
  register's own list, hidden without its right) and the request's lines
  say what came from stock. The list (`listWhere` → `{ base, where }`,
  cards Waiting for approval / Pulled out / Drafts) prints; Ctrl+K finds
  slips.
- **Inventory switches between List and Kanban** (push 4d; the owner's
  call, like gasiontech's). A List / Kanban switch in the page head;
  `?view=kanban|list` in the URL (a link's view wins), and the viewer's last
  CHOICE kept per browser in `gcore_view_inventory` (wrapped in try/catch —
  a browser that keeps nothing still switches). `GET /inventory/board`
  reads **the list's own query** (`inventoryListWhere`: search,
  warehouse, below reorder level) and answers a column per active
  warehouse (only the one a `warehouseId` narrows to; an inactive one still
  holding a row is shown too) with what it has AVAILABLE, and **Out of
  stock** for every row with nothing available (none on hand, or all lent),
  each card naming its warehouse; `total` is the list's, which
  verify-chain asserts, and a column draws 200 cards at most and says how
  many more. No dragging — stock moves by documents; a card is a link to
  the stock card. The board's toolbar writes the list's own URL keys (`q`,
  `warehouseId`, `needsReorder`), so switching views keeps the filter. The
  styles are the `inv-*` rules in `styles/procurement.css`.

## Spreadsheet attachments (2026-10-05)

A browser cannot show a workbook, so an attached price list downloaded every
time somebody only wanted one figure. `openAttachment()` now sends a
spreadsheet (by EXTENSION — `isSpreadsheet()`; Windows uploads a .csv as
`application/vnd.ms-excel`) to `/files/:id` (`pages/FileViewer.tsx`) in a tab
of its own, outside the Shell and in the day theme. Every screen that opens a
file goes through that one function, so all of them got it.

- **Read-only, values only**: the text Excel shows (`cell.w`, through the
  cell's own number format), one tab per visible sheet (a hidden sheet is
  named in the footer, a very hidden one is not), merged titles spanning their
  columns, the headings row guessed (`detectHeaderRow()`) and changeable, held
  under the column letters like Freeze Panes, and a search that is case- and
  comma-blind ("12500" finds 12,500.00) across every sheet. No formulas,
  links, colours or pictures — what reaches the page is plain text, rendered
  as text. Download stays, from the bytes already fetched.
- **The bytes come through `/api/attachments/file/:id`**, so each record's
  attachment guard still decides; refused or missing reads "not available".
  No API change: the name comes from its Content-Disposition.
- **Parsed in a worker** (`lib/spreadsheet.worker.ts`) — an upload is
  untrusted input, so a hostile or broken file fails, or hits the 60-second
  stop, in a thread holding no token and no page. Caps: 25 MB, 50,000 rows a
  sheet, 256 columns, each said on screen when it bites.
- **`lib/spreadsheet.ts` never imports the library**, so the main bundle does
  not carry it; only `lib/spreadsheetRead.ts` does, and it reaches the browser
  inside the worker chunk alone. verify-foundation pins both.
- **The library is SheetJS CE 0.20.3 from the vendor's CDN**, pinned in
  `web/package.json` by URL and in the lockfile by integrity hash. The npm
  registry's `xlsx` (0.18.5) is years stale with known flaws reading crafted
  files — never `npm install xlsx` by name. The first `npm install` after
  pulling this fetches it from cdn.sheetjs.com, so the server must reach it
  then; after that it is in `node_modules`.

## Costing sheet notes

The costing is patterned on gasiontech G-CORE's costing (and its "Material
Cost Estimate" PDF) in G-CORE's own style.

- **The sheet is a page, never a dialog**: `/g-ops/costing/new` and
  `/g-ops/costing/:id/edit` (`CostingSheet.tsx`). **One save = one
  transaction**: `POST /costings` and `PUT /costings/:id/sheet` take the header,
  `lines[]` and `sections[]` (with `tasks[]`) and write them through
  `writeSheet()`; every reference is checked before `nextNumber`, so a refused
  sheet burns no number. Rows sent with their `id` are updated in place, rows
  left out are deleted — never delete-and-recreate. The old
  `?new=1&leadId=&customerId=` list links redirect to `/new`. The per-line,
  per-section and per-task routes are gone (2026-10-10): nothing called
  them, and a second way to write a sheet is a second set of checks to keep
  in step — scripts write through the sheet too.
- **One arithmetic: `shared/costingMath.ts`**, exact in BigInt: line amount =
  qty (3 dp) × cost (2 dp) rounded half away from zero; **contract value =
  cost ÷ (1 − margin)**, rounded once to the centavo, **net of VAT** (the SOV
  and billing are unchanged); VAT and grand total are shown, not stored.
  `web/src/lib/costingMath.ts` is a COPY for the page's live figures, pinned
  equal on 400 random sheets by verify-costing. `recalc()` is the only
  writer of `totalCost`/`contractValue`.
  **The margin replaced the markup on 2026-10-09** (the owner's call:
  "remove markup and replace with margin", "6th category contingency",
  "remove footer contingency and less discount"): `Costing.marginPct` is
  the gross margin on the PRICE, a fraction to six decimals (`Decimal(9,6)`;
  the API refuses ±95% and beyond — at 100% there is no price; a negative
  one is a loss-making bid, priced below cost and said as such). The
  summary is cost, `Margin (x% of the price)`, subtotal, VAT, grand total —
  no contingency % and no discount: **Contingency is the SIXTH system cost
  category** (`CON`, after Indirect Cost), a cost LINE like any other, and
  a discount is the quotation's business. The sheet's "set the grand
  total" solves for the margin (a share of the price cannot always land on
  the centavo, and the toast says where it landed); the note under the box
  says the markup on cost it amounts to. `present()` reads the summary off
  the STORED cost and contract value (`vatOn()` on the stored contract),
  never re-derived from the rate. The three legacy columns (`markupPct`,
  `contingencyPct`, `discountAmount`) stay on the table because the server's
  `prisma db push` would refuse to drop data: **`migrateCostingMargins()`
  in `shared/costingLegacy.ts`** (the seed, every deploy; idempotent) writes
  a costing's contingency % as a Contingency line at its amount, derives
  the margin from the stored contract value over that cost (the contract
  value never moves) and zeroes the three; a template saved with a markup
  reads as the margin it amounts to (`marginOfMarkup`). The board's
  "Average discount" is now the valued revision's own `discountPct`.
  **A fixed price** (2026-10-13, the owner's call: "the percentage is hard
  to hit the desired value"): `Costing.targetContractValue` (nullable,
  net of VAT). "Set the grand total" STORES it — typed with VAT by
  default (the contract value whose VAT lands nearest, `priceTo()`; the
  toast says when VAT's own rounding cannot land on the figure), or before
  VAT with the tick — and `costingFigures({ targetContractValue })` /
  `recalc()` then write `contractValue` = it exactly and `marginPct` = what
  it amounts to (six decimals; `figures.marginPct`, `fixedPrice`), so a
  line changed later keeps the price and moves the margin. The Margin box
  shows the derived margin greyed with **Release**, which prices from that
  margin again (the price may move by a few centavos — a margin at six
  decimals cannot always reproduce it). A save whose fixed price lands
  outside a ±95% margin of the cost is refused (`recalc(…, { strict })`
  in the save's transaction), as is a fixed price with no cost lines; a
  background recalculation never refuses. The paper's margin row reads
  "(x% of the price, fixed price)"; a duplicated costing keeps it.
- **A line has `name` (bold) and `description`**; a line typed as a name alone
  carries it as its description too, because every older reader prints
  `description`. **`isHeading` is a subheading**: amount 0, no code.
  **Codes are derived, never stored**: `lineCodes()` numbers cost lines 101,
  102… per bucket by the bucket's rank (Materials 1 … Indirect 5,
  Contingency 6).
- **A new sheet opens on the owner's scope of work** (2026-10-13,
  `SCOPE_OF_WORK_PRELOADED.xlsx`): `SCOPE_PRELOAD` in
  `shared/scopePreload.ts` — PLANNING & ENGINEERING, SITE PREPARATION,
  DELIVERY, UNLOADING & PLACEMENT, INSTALLATION & INTEGRATION (main work),
  TESTING & COMMISSIONING (`TESTING_COMMISSIONING`), HAND OVER & CLOSURE
  (`TURNOVER`), fifteen tasks under them, each one working day to start
  with — sent by `GET /costings/suggest/lists` as `scopePreload` and
  loaded by `/new` once; every phase and task stays removable. A template
  chosen on a new sheet REPLACES the preload while nobody has touched it
  (`sectionsSignature()`), and appends otherwise; "Start from the standard
  scope" brings it back to a sheet with no phases. A change to the list
  is a commit to that file.
- **The plan is working days, not dates** (`planTasks()`): a task with a
  `startDay` keeps it; one without starts the day after the previous task ends.
  **A phase with no tasks but a typed duration takes its place in the same
  sequence** (2026-10-09): Day 11–15 after a ten-day phase, a bar on the
  Gantt chart like any other, and the plan lasts through it; a phase with
  neither is unplanned and moves nothing. On save a phase with tasks takes
  their span as `durationDays` and the costing the plan's total — the job
  schedule reads those. "Sequence tasks" only writes the computed starts
  down. `spread: true` on a save runs `spreadSections()` (the same rule as
  `/sections/distribute`) so the SOV equals the contract value.
- **A start date gives the plan its dates** (2026-10-13, the owner's call:
  "if there is Start Date there should be Finished Date … Mon–Sat"):
  `Costing.plannedStart` (DATE, nullable; "Start date" under Valid until on
  the sheet, never copied by Duplicate). With one, `present()` derives —
  never stores — `plannedFinish` (`workingDayDate(plannedStart, planDays)`)
  and each phase's and task's `startDate` / `endDate`; the sheet works the
  same out live (`workingDayKey`, `web/src/lib/day.ts`) and shows "Duration:
  85 working days (Mon–Sat) · Oct 14, 2026 – Jan 23, 2027" over the scope,
  the Finish date under the start and each phase's dates beside its days.
  The paper prints Start date and Finish date in its DETAILS block, the
  legend "Planned duration in working days (Mon–Sat) — N working days in
  all, <start> to <finish>." (`planLegend()`), and the Gantt appendix dates
  its columns ("Oct 14", the `gantt` section's `startDate`).
- **A line names its supplier and a note** (2026-10-14, the owner's call:
  "maximize this space" — the room under the unit cost):
  `CostingLine.supplierId` (SetNull), `supplierName` (a name not on file,
  kept as typed) and `lineNote`, all nullable. The sheet's cost cell has a
  Supplier box (free text, offering active suppliers through `GET
  /costings/suggest/suppliers`, names only, behind the costing's own right —
  an engineer need not read the supplier master) and a Note box. At save a
  typed name equal (case- and space-blind) to ONE active supplier is linked
  (`suppliersByName()` in `routes/costing.ts`); an unknown `supplierId` is a
  400; Duplicate keeps both. **The paper prints them under the unit cost** —
  the supplier in the subheading green, the note in the description grey,
  the figure regular: `costingLineRow({ supplier, note })` gives that cell
  `{ title, plain, accent, note }` (`PdfCell`'s optional fields; only the
  designed engine draws `accent`/`note`), and the line table's **`lineNotes`**
  switch (default on; "A line's supplier and note, under its unit cost" in
  Admin › PDF Templates) leaves them off. **They carry to a purchase
  requisition**: `lineSuggestions()` sends each costing line's `supplier`,
  and picking lines (typed or "Add from costing…") fills an EMPTY Preferred
  supplier with their suppliers, each once (`preferredFrom()` in
  `lib/prLines.ts`, pinned by verify-foundation) — never over one typed.
- **VAT is the company rate or 0%** (`checkVatRate`, as on the quotation),
  snapshotted at creation; a draft keeps its rate after Settings change.
- **Approval is the seeded `costing` workflow — TWO signatures since the
  routing sheet of 2026-10-13**: "Costing — technical manager, team leader"
  (Technical Manager, then the author's Team Leader); the route below with
  the CEO (CTG) third is RETIRED, and a costing pending on it finishes on
  it. A Technical Manager who is also the author's Team Leader signs both
  with one Approve (verify-costing). As built on 2026-10-09 ("creator
  engineer › reviewer technical manager › approval team leader › 2nd
  approval CTG"): "Costing — technical manager, team leader, CTG" — step 1 ROLE `technical_manager` (**Technical
  Manager**, a seeded role that reads every costing), step 2 a SUPERVISOR
  step named **Team Leader** (the author's "Reports to", falling back to
  `team_leader` on the author's team since 2026-10-12 — it was
  `sales_manager` — as the quotation's and the sales order's do), step 3
  "CEO (CTG)" ROLE `executive` — **CTG is the CEO's initials, Carter T.
  Gasiong**, so the step is the executive role like every other CEO step
  (a `ctg` role seeded for a few minutes is deleted by the seed where
  nobody holds it). The `project_engineer` role now raises and edits its
  own costings. "Costing — management approval" (one step, executive) is
  in the seed's RETIRED list; a costing pending on it finishes on it.
  The route has `preparerSigns` and `standIns` (2026-10-12): a Technical
  Manager's own costing is signed at step 1 when submitted, and its paper
  prints that and Prepared by under one timestamp.
  **Assign Technical Manager in Admin › Users** — until somebody holds it,
  costings stall at step 1 and `audit-workflows.ts` says so (it also knows
  engineers raise costings).
  FINAL takes every signature (verify-costing proves the technical
  manager's alone leaves it pending, and that the team leader cannot sign
  out of turn). With the route active the
  author cannot PATCH to FINAL; `POST /:id/submit` claims DRAFT →
  PENDING_APPROVAL with a conditional update, submits in the AUTHOR's name, and
  reverts to DRAFT if the engine refuses. `settleCosting()` moves APPROVED →
  FINAL, REJECTED → DRAFT. A PENDING costing refuses edits, deletion and
  `POST /jobs`. To run without costing approval, DEACTIVATE the workflow — a
  deleted seeded workflow is recreated by the next seed; the page then offers
  "Mark final" again. Reopen (FINAL → DRAFT) stays the author's, and needs a
  fresh approval.
- **The Costing page has three tiles** (2026-10-06): Being costed (DRAFT),
  Awaiting approval, Final this month. `GET /costings/summary` counts them
  through `costingListWhere()`, the list's own query, under the page's
  Mine/All scope, so a tile equals the total of the list it opens
  (`?status=`, `?finalised=this-month`) — verify-costing asserts it. "Final
  this month" reads `Costing.finalAt`, set when the costing becomes FINAL
  (approval, "Mark final", a job built on a draft) and cleared on reopen;
  the seed dates older final costings from `updatedAt`, once. The G-OPS
  funnel no longer has a "Being costed" stage.
- **The PDF is "Project Costing"** (2026-10-13, the owner's call; it was "Material Cost Estimate", and its file name's kind follows: "Project Costing <number> - …"), a designed document since the same day (see "Quotation PDF template": the layout is Admin › PDF Templates › Costing, the chart joined behind it): details, one table with
  bucket headings by name alone ("Materials", never "1 Materials" — the owner's call, 2026-10-14; the line codes 101, 102 … stay), name-over-description cells, subtotals, the summary
  as `totals`, Terms & Conditions — **never the internal notes** — the
  sign-offs, then the Scope of Work as the engine's **`gantt` section** on
  landscape pages of its own. **A trailing landscape `gantt` section is an
  APPENDIX** (2026-10-09, the owner's call: "Gantt chart on PDF have 2nd
  page"): `renderDocument` draws the sign-offs BEFORE it (`isAppendix` in
  `shared/pdf.ts`), so the chart is the last page and no near-empty portrait
  page follows it; the Scope of Work is always the chart — a phase without
  tasks is a bar over its own planned days (`PdfGanttGroup.start`/`days`,
  which `safeSpec` must carry through) — never a table. The sign-offs come
  from `approvalSlots('costing', …)`: Prepared by, then one line per step
  of the route with the step's name as the capacity it signs in (TECHNICAL
  MANAGER, TEAM LEADER, CEO (CTG)), who signed and when, "Pending" until they do;
  a draft prints the route submitting would take, and a costing with no
  route at all one open APPROVED BY.
- **Predictions never widen visibility**: `GET /costings/suggest?q=` offers past
  lines (newest price, use count) only from costings the caller may read, plus
  the item master; `/suggest/lists` feeds the datalists (units, System / Unit,
  phase and task names, your own last terms, the company VAT rate). Both sit
  above `/:id`.
- **A template is `CostingTemplate.body` JSON**, categories by CODE, with
  nothing pointing at it and no link back from a costing made from it. Saved
  from a costing (`costingId`) or the unsaved sheet (`sheet`); `withPrices:
  false` zeroes every unit cost. Author or `edit_all` renames/deletes; anyone
  who reads costings uses it. No new permission keys — `gops.costing.*` covers it.

