# Plan — module order, RFQ apart from Canvass, and the warehouse flow (2026-10-14)

The owner's six, with five screenshots and a sample canvass sheet:

1. "Pic 1, rearrange the panel: G-OPS, G-CHAIN, G-FIN and G-HR."
2. "Pic 2, rearrange Project Management: Costing, Projects, Job Orders, CAD J.O."
3. "Pic 3, separate the RFQ and Canvass: Purchase Request, RFQ, Canvass, Purchase Order."
4. "Flow from PR to RFQ; a standard form and list; printed documents show
   Prepared by (standard digital time stamp)."
5. "Canvass: a standard form and list; printed documents show who prepared
   (standard digital time stamp); the sample canvass sheet; add a row for
   Percentage Savings (the reference budget is the approved Purchase Request,
   total at the bottom)."
6. "Pic 5: instead of Receiving, Stock Issuance, Borrow Slips, Inventory the
   flow is Incoming › Inventory › Outgoing › Borrow Slips › Pull-out Slip" —
   Incoming: the warehouse receives, approval of their reports-to, packing
   list attached; Inventory: Kanban or list, as gasiontech G-CORE; Outgoing:
   the warehouse issues, approval of their reports-to, attachments; Borrow
   Slip: anyone requests, approved by the Team Leader / Technical Manager
   they report to or on their team, the warehouse processes it, approval of
   its reports-to; Pull-out Slip: from an approved sales order or a purchase
   request.

Status: **planned**, not built. Previews: `docs/mockups/chain-flow-*.png`.

## What runs today, and what changes

| Area | Today | After |
|---|---|---|
| Launcher | G-OPS, G-HR, G-FIN, G-CHAIN (`Home.tsx` `MODULES`, the registry's order) | **G-OPS, G-CHAIN, G-FIN, G-HR** — the launcher, the top bar and Ctrl+K alike |
| Project Management strip | Costing, Job Orders, CAD J.O., Projects | **Costing, Projects, Job Orders, CAD J.O.** |
| Procurement strip | Purchase Requests, Canvass / RFQ, Purchase Orders | **Purchase Requests, RFQ, Canvass, Purchase Orders** |
| RFQ | Part of the canvass (`Canvass` + `CanvassSupplier` + `CanvassQuote`, numbered `canvass` with code RFQ) | **Its own document** (`Rfq`), raised from an approved PR, printed per supplier, Prepared by with the digital timestamp |
| Canvass | Suppliers and quotes typed on the canvass, award → PO | **The comparison sheet**: built from the RFQ's quotes, suppliers across, the approved PR's estimate as the reference budget, totals, **Savings %**, award → PO; Canvassed by and Awarded by with timestamps |
| Warehouse strip | Receiving, Stock Issuance, Borrow Slips, Inventory | **Incoming, Inventory, Outgoing, Borrow Slips, Pull-out Slips** |
| Incoming (Receiving) | Posts stock and job cost the moment it is saved | **Approved by the receiver's "Reports to"** before it posts; packing list / DR attached |
| Inventory | A list | **List or Kanban**, the choice remembered |
| Outgoing (Stock Issuance) | DRAFT → ISSUED by the warehouse | **Approved by the issuer's "Reports to"** before it issues; attachments |
| Borrow Slips | The warehouse writes one for a borrower | **Anyone requests**; route: the requester's Team Leader / Technical Manager, then the Warehouse Supervisor; the warehouse releases |
| Pull-out Slips | — | **New**: stock pulled against an issued sales order or an approved purchase request, approved by the warehouse's "Reports to" |

## 1. Order of the panels and the strips (pushes 1)

- **Launcher**: `MODULES` in `web/src/pages/Home.tsx` and the module order in
  `api/src/permissions/registry.ts` both go G-OPS, G-CHAIN, G-FIN, G-HR
  (Insights and Admin stay after). The top bar's module pills and Ctrl+K's
  screen list read the registry, so they follow.
- **Project Management**: reorder the four entries in the registry (the
  hidden ones keep their place); verify-foundation's strip pin changes to
  `Costing,Projects,Job Orders,CAD J.O.`.
- **Procurement**: `purchase_requests`, **`rfq`** (new key), `canvass`
  (label "Canvass"), `purchase_orders`.
- **Warehouse**: `receiving` keeps its KEY and permission strings (nothing
  revokes anybody's right), its label becomes **Incoming** and its path
  `/g-chain/incoming` (`/g-chain/receiving` redirects); `stock_issuance` →
  **Outgoing**, `/g-chain/outgoing` (`/g-chain/stock-issuance` redirects);
  `inventory` moves to second; `borrow_slips` stays; **`pullout_slips`** is
  new. The numbering labels follow ("Incoming Report", "Outgoing Slip");
  the stored codes RR and SI stay unless an administrator changes them in
  Admin › Numbering.

## 2. RFQ — Request for Quotation (push 2)

**The record** `Rfq`: `number` (numbering type `rfq`, code RFQ, "GT-RFQ-
2026-0001"), `requestId` (an APPROVED purchase request; one request may
have several RFQs — a second round, or split by category), `status`
(DRAFT → SENT → QUOTED → CLOSED, or CANCELLED with a reason),
`preparedById`, `sentAt`, `dueDate` (quote by), `deliverTo` (the request's
project or warehouse by default), `notes`, `terms` (what is asked of the
supplier: VAT status, validity, payment terms, lead time).
`RfqSupplier`: `supplierId` (the master; `SupplierPicker`, "Add … as a new
supplier" for the create right), `contactName`, `contactPhone`, `email`
(the supplier's own, editable on the row), `sentAt`, `quoteRef`,
`quoteReceivedAt`, `leadTimeDays`, `terms`, `validUntil`, `remarks`, and
its quotes `RfqQuote` (`requestItemId`, `unitPrice`, `remarks`; a line not
quoted has no row). The supplier's quotation file is an attachment on
`rfq_supplier` (guard: the RFQ's own visibility).
`RfqLine` is NOT a table: the RFQ's lines ARE the request's lines
(`PurchaseRequestItem`), chosen by tick when the RFQ is raised
(`RfqItem { rfqId, requestItemId }` — a subset, so one PR can be split
over two RFQs by category).

**The form** (`/g-chain/rfq/new?fromRequest=`, `/g-chain/rfq/:id/edit` on
a draft — the requisition page's dress, `prq-*`): the request and its
approved estimate (read-only, with the budget line), the lines ticked (all
by default), Quote by, Deliver to, Terms, Notes, and the suppliers asked
(a `SupplierPicker` row each with contact, phone, email). **Save** keeps
the draft; **Mark sent** sets SENT and dates it (G-CORE sends no email to
suppliers — the paper is sent by the buyer; an email hand-off can come
later). **Record quotes** on the record page: a panel per supplier
(unit price per line, lead time, terms, validity, quote ref, remarks,
the file) — the first quote recorded moves the RFQ to QUOTED. **Raise
canvass sheet** (below) once at least one supplier has quoted; CLOSED
when its canvass is awarded; "Cancel" with a reason.

**The list** `/g-chain/rfq` — the shared DataList: Number, Request,
Project / Warehouse, Suppliers asked (n), Quoted (n of asked), Quote by,
Status, Prepared by, Date, PDF; filters status, request, supplier, dates;
Mine / All; the printed list `GET /rfq/pdf`.

**The paper** `GET /rfq/:id/pdf?supplier=<rowId>`: ONE PER SUPPLIER —
"REQUEST FOR QUOTATION", TO (the supplier, attention, tel, email),
DETAILS (date, reference PR and project, quote by, deliver to), the lines
with Part No., Description, Unit, Qty and BLANK Unit price / Amount / Lead
time columns for the supplier to fill, the terms, and the sign-offs:
**PREPARED BY** (the preparer, contact lines, the digital timestamp —
`preparedAt`, the document's own created-at, printed as the quotation's
Prepared by is) and **SENT** (date and time, "Pending" until marked sent).
Without `?supplier=` the paper prints the RFQ whole with every supplier
listed. The record page's Print opens a menu: one entry per supplier and
"All suppliers". Every PDF route audits EXPORTED. No approval route: an
RFQ is an enquiry, not a decision (the PR was approved; the PO will be).

**Rights**: `gchain.rfq.*` OWNED (the canvass's holders: Procurement,
Purchasing Manager, Back Support; `view_all` to the Technical Manager and
Team Leader roles so they read what their PR became). The never-offered
rule carries the pairs to the live install.

## 3. Canvass — the comparison sheet (push 3)

**The record** keeps the `Canvass` table (existing canvasses stay
readable and awardable) with: `rfqId` (nullable; the RFQ it compares),
`preparedById` (new; `createdById` stays), `remarks`, `recommendedRowId`
(the buyer's recommendation, before the award). `CanvassSupplier` /
`CanvassQuote` become a **snapshot** of the RFQ's suppliers and quotes
taken when the sheet is raised (`JobScopeItem`'s rule: the abstract is a
record, so a quote edited on the RFQ later never moves an awarded sheet;
"Refresh from RFQ" on an OPEN sheet copies again). Each supplier row
also snapshots `contactName`, `contactPhone`, `leadTimeDays`, `terms`.
The numbering type `canvass` keeps its counter; its default code becomes
**CVS** ("Canvass Sheet") on a fresh install — the live install keeps RFQ
on the canvass until an administrator changes the pattern in Admin ›
Numbering, which the plan recommends (the RFQ now carries RFQ).

**The arithmetic** (`shared/canvassMath.ts`, pure, pinned by
verify-chain): per supplier column, `total` = Σ unit price × request qty
over the lines it quoted; `budgetOnQuoted` = Σ the PR's estimated amount
over the SAME lines; `savings` = `budgetOnQuoted − total`; `savingsPct`
= `savings ÷ budgetOnQuoted` (two decimals; null when nothing quoted); a
supplier that quoted every line is **complete**, and the sheet says
"(n of m lines)" and "(on lines quoted)" on a partial one so a cheap
partial quote never reads as the best. The reference budget column's
total is the PR's estimate over the sheet's lines. The award refuses a
supplier that quoted none of the lines; a partial winner is allowed and
said on the PO (the unquoted lines are left to order).

**The form** (`/g-chain/canvass/new?fromRfq=`, Modify while OPEN): the
RFQ and request named, the lines with the reference budget, the supplier
columns from the snapshot (unit prices editable here too — a buyer may
type a quote received by phone — with the change audited), lead time and
terms per supplier, Remarks, "Recommend" per column, **Award** (the
existing route, now also closing the RFQ) and "Raise order" → the PO page
at the awarded prices (existing). A canvass raised from a PR with no RFQ
stays possible for a quote already in hand ("+ New canvass" asks for the
request and the suppliers, as today) — the old way is not removed.

**The list** `/g-chain/canvass`: Number, Request, RFQ, Suppliers,
Lowest complete, Reference budget, Savings % (of the awarded, else the
lowest complete), Status, Canvassed by, Date, PDF; filters status,
request, supplier, awarded dates; the printed list.

**The paper** `GET /canvasses/:id/pdf` — **landscape** (the sales
order's rule: more columns than portrait holds): "CANVASS SHEET", the
reference line (PR, its approval date, the RFQ, the project), the table
as the owner's sample — Item code | Description | U/M | Qty | **Reference
budget** (unit cost, amount) | one pair of columns per supplier headed by
the supplier's name with its Tel No. and Contact person under it (unit
cost, amount; "not quoted" on a missing line) — then the **TOTAL** row,
the **SAVINGS vs reference budget** row (pesos and %, per supplier), and
a Lead time · Terms row; the awarded column marked ★ and tinted. The
sign-offs: **CANVASSED BY** (the preparer, the digital timestamp),
**AWARDED BY** (who awarded, when; "Pending" until awarded — a real act,
never a slot nobody fills) and, once raised, the PO's number. The
owner's sample has "Noted by / Approved by" blanks: G-CORE prints only
people who act, so the sheet carries the canvasser and the awarder, and
the purchase order carries the approvals. More than four suppliers run
onto a second table (the engine's row split cannot split columns) —
the build caps a sheet at six suppliers and says so.

## 4. The warehouse flow (push 4, the large one)

### Incoming (was Receiving)

`Receiving.status` (new: DRAFT → PENDING_APPROVAL → RECEIVED, or
CANCELLED; existing rows are RECEIVED — their stock and cost were posted
when they were saved). Today a receiving posts INCURRED and builds stock
in its create transaction; after this, the create writes the DRAFT, Submit
claims DRAFT → PENDING_APPROVAL (the `updatedAt` claim, the purchase
request's rule) and files a `receiving` approval in the receiver's name;
`settleReceiving()` (exported, idempotent, a conditional claim on
PENDING_APPROVAL) does what the create did — the stock movement, the
average cost, the INCURRED rows, the order's received quantities and
status — and a rejection goes back to DRAFT; a decision after a cancel
"not applied". Seeded route **"Incoming — the receiver's supervisor"**:
one SUPERVISOR step, fallback role `warehouse_supervisor` (new, below).
Attachments on `receiving` (the packing list, the DR, photos; guard: the
record's own visibility, written on a draft), printed behind the paper
through `withAttachments` (`?attachments=0` bare). The paper gains the
sign-offs RECEIVED BY (the preparer, timestamp) and the route's step.
The G-CHAIN "awaiting delivery" tile and the PO's received figures keep
reading RECEIVED rows only — verify-chain asserts a pending receiving
moves nothing.

### Inventory — list or Kanban

`?view=list|kanban` on `/g-chain/inventory` (a declared key, rule 16),
the choice remembered per browser (`gcore_view_inventory`), a List ·
Kanban segment in the toolbar. The Kanban is `components/Board.tsx`'s
column grid (the pipeline board's dress, tinted neutral): **one column
per active warehouse** plus "Out of stock" last, a card per item with its
code, part number, on hand, available, average value, a red edge below
the reorder level, an amber edge with "n on loan · BS-…" while a borrow
slip is out, and the same search and filters as the list (both read
`inventoryListWhere`, so the two views never disagree). No drag — stock
does not move by dragging a card; a card opens the stock card. Default
view: the list, until the owner says otherwise.

### Outgoing (was Stock Issuance)

`IssueStatus` gains PENDING_APPROVAL: Submit claims DRAFT →
PENDING_APPROVAL and files a `stock_issue` approval in the issuer's name;
`settleStockIssue()` runs what `POST /:id/issue` runs today (the
movements at the warehouse's average, CONSUMED on the job) on approval;
`POST /:id/issue` stays for an install that deactivates the route
(refused while a route is active — the sales order's rule). Seeded
**"Outgoing — the issuer's supervisor"**: one SUPERVISOR step, fallback
`warehouse_supervisor`. Attachments on `stock_issue` (the signed gate
pass), the paper's sign-offs ISSUED BY and the step. Existing issued
slips are untouched.

### Borrow Slips — anyone requests

Today the warehouse writes the slip. After: `BorrowSlip.status` gains
REQUESTED → PENDING_APPROVAL → APPROVED → OUT (released) → PARTIALLY_
RETURNED / RETURNED / OVERDUE, and CANCELLED; `requestedById` (new;
`borrowerId` stays the person who holds the items — the requester by
default), `neededOn`, `issuedById` nullable until released. The create
right goes to everyone (`gchain.borrow_slips.create` on the `employee`
role; own scope), the release and return stay the warehouse's
(`edit_all`). **The route** "Borrow slip — team leader, warehouse": step
1 SUPERVISOR — the requester's "Reports to", falling back to
`team_leader` on the requester's team, and a **Technical Manager on the
requester's team qualifies too** (the engine's `OWN_TEAM_ROLES` rule,
given a second role on the step: `fallbackRoleIds[]`, a small engine
change pinned by verify-foundation); step 2 ROLE **`warehouse_supervisor`**
— the owner's "approval of his/her report to" for the warehouse's own
processing; a person holding both signs once (one signature per person).
On approval the warehouse **releases** (`POST /:id/release`: the stock
moves to `borrowedQty`, OUT, the due date set) — or returns it with a
note when the item is not on the shelf. The form is the requester's
(`/g-chain/borrow-slips/new`: the warehouse, the items from that
warehouse's stock with what is available, quantities, needed on, due
back, purpose, the project if any); the warehouse's own quick slip for a
walk-in borrower stays (`edit_all`), approved the same way. My Work
lists a Team Leader's pending borrow requests and the warehouse's
approved-not-released ones. The paper: REQUESTED BY, the two steps,
RELEASED BY, RETURNED (date) — people who acted.

### Pull-out Slips — new

`PulloutSlip` (`number`, type `pullout_slip`, code PS): `kind`
SALES_ORDER | PURCHASE_REQUEST, `salesOrderId` (an ISSUED sales order) or
`requestId` (an APPROVED purchase request), `warehouseId`, `status`
(DRAFT → PENDING_APPROVAL → PULLED_OUT, CANCELLED), `preparedById`,
`releasedById`, `releasedAt`, `receivedByName` (who took it: the
customer's representative or the project's), `notes`; `PulloutItem`
(`itemId`, `sourceLineId` — the sales order line or the request line —
`quantity`, `unitCost` at the warehouse's average). **What it is**: stock
leaving for a customer's delivery (the sales order's lines matched to
items — a sales order line names a product, so the form matches by part
number or item and lets the warehouse pick), or stock a project takes
from the shelf instead of buying (the request's lines; the request then
shows "pulled from stock" against each line, and a PO raised later
offers only what is left). **Posting** on approval (`settlePullout()`):
the movement out at average cost; for a request on a project a CONSUMED
row on the job (the stock issue's rule — the receipt already incurred
it); for a sales order no job cost — a `StockMovement` with the order as
its reference, and the order page's new "Pulled out" card. Route
**"Pull-out slip — the warehouse's supervisor"**: SUPERVISOR, fallback
`warehouse_supervisor`. The form (`/g-chain/pullout-slips/new?salesOrder=
| ?request=`, the Outgoing form's dress), the list, the paper (PREPARED
BY, the step, RELEASED BY, RECEIVED BY — the name written on the slip).
Rights `gchain.pullout_slips.*` SHARED_KEPT like the borrow slip; the
sales order page's ⋯ gains "Pull out stock…" for a holder.

### The new role and the seams

- **`warehouse_supervisor` Warehouse Supervisor** (seeded from the
  `warehouse` role's rights plus the four `edit_all`s): the fallback of
  every warehouse SUPERVISOR step and step 2 of the borrow route. Assign
  in Admin › Users; `audit-workflows.ts` knows the four new routes and
  their typical requesters.
- Four `onApprovalSettled` subscribers in `routes/warehouse.ts`
  (`receiving`, `stock_issue`, `borrow_slip`, `pullout_slip`), each a
  conditional claim on the pending status, each "not applied" after a
  cancel; four cancel routes through `cancelOpenRequest`; `DocumentApproval`
  on each record page.
- `Receiving.status` and the new borrow statuses are the two places
  existing rows change meaning: the seed backfills RECEIVED on every
  receiving and OUT / RETURNED stay as they are (a slip with no
  `requestedById` is the warehouse's own).

## 5. The papers' "standard digital time stamp"

Every paper named here prints its first slot as the quotation does
(`preparedAt(slots) ?? createdAt`, "October 14, 2026, 2:41 PM", the
contact lines) through `slotSignatories(approvalSlots(…))` — the RFQ and
the canvass have no route, so their slots are the record's own acts
(prepared, sent, awarded), dated by the record, never a slot nobody
fills. Nothing new in the engine for this: the costing's and the
requisition's papers already do it.

## 6. Pushes, checks and effort

| Push | What | Checks | Effort |
|---|---|---|---|
| 1 | Launcher, PM strip, Procurement and Warehouse strips (labels, paths, redirects, numbering labels) | verify-foundation: the three strips pinned; the redirects | **medium** · ~½ day |
| 2 | RFQ: schema, routes, form, record page, list, per-supplier paper, PR's "Request quotations" | verify-chain +12 (the subset of lines, a second RFQ on one PR, quotes recorded, the paper per supplier, Prepared by's timestamp, rights) | **high** · ~1½ days |
| 3 | Canvass: `rfqId`, the snapshot, `canvassMath`, the landscape sheet with Savings %, the list, award closes the RFQ | verify-chain +10, verify-foundation +3 (the arithmetic, a partial quote's savings, the ★, the capped suppliers) | **high** · ~1 day |
| 4a | Incoming and Outgoing on approval, attachments, `warehouse_supervisor`, two routes, the papers | verify-chain +12 (nothing posts while pending; posts once on approval; a late decision after cancel) | **xhigh** · ~1½ days |
| 4b | Borrow slips anyone requests, the two-step route, the engine's second fallback role, My Work | verify-chain +8, verify-foundation +2 | **xhigh** · ~1 day |
| 4c | Pull-out slips: schema, routes, form, list, paper, the sales order's card, the request's "pulled from stock" | verify-chain +10 | **high** · ~1 day |
| 4d | Inventory Kanban | verify-chain +2 (both views one query) | **medium** · ~½ day |

About **7 Opus days** in seven pushes, each one a deploy. Run 4a before
4b and 4c (they share the role and the subscribers' pattern); 4d is
independent and can go any time. CLAUDE.md gets one section per push;
the model document's §4.3 (warehouse) and §4.2 (procurement) are updated
with the flow.

## 7. Questions for the owner (defaults in bold)

1. **The canvass has no approval route of its own** — the award is the
   Purchasing Manager's act and the PO carries the approvals. Or should
   the sheet route through the Purchasing Manager before award?
2. **The Kanban's columns are the warehouses** (+ Out of stock). The
   alternative is columns by state (In stock · Below level · Out of
   stock · On loan). Which did gasiontech G-CORE show?
3. **A pull-out against a sales order posts no job cost** (the order has
   no project); it is a stock movement referenced to the order. Should it
   also close the order's lines as delivered?
4. **The Warehouse Supervisor is a role** held by whoever the warehouse
   staff report to. If the warehouse people have a "Reports to" set in
   Admin › Users, the SUPERVISOR steps read that first and the role is
   only the fallback — so set it for them.
5. **The RFQ is sent by hand** (printed or saved as PDF and emailed by
   the buyer). An "Email to suppliers" button through `shared/mail.ts`
   can follow once SMTP is on the live server.
