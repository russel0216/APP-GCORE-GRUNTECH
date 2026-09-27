# PROC — procurement and warehouse: notes worth carrying forward

Package scope: PO header and line editing, procurement chain links, the PR
prefill from a job, the G-CHAIN dashboard rewired to `/gchain/overview`, the
inventory summary switched to `stockOnHand()`, the receivings `jobId` filter,
and Ctrl+K providers for every procurement and warehouse document.

## Invariants

- **A purchase order is edited only while DRAFT, and only by its author or an
  `edit_all` holder.** The PO edit routes (`PATCH /purchase-orders/:id`,
  `POST|PATCH|DELETE /purchase-orders/:id/items[/:itemId]`) now take
  `requireAny(edit_all, edit_own)` and check `canEditRecord(me, 'gchain',
  'purchase_orders', po.createdById)` in `poForEdit()`. The detail response
  carries `canEdit`, and the page shows Modify / + Add line / per-row Modify
  and Remove only when it is true. Every one of those writes is audited
  (`UPDATED`); they were not before.
- **A direct-to-job PO line must name its cost category**, the same rule the
  PR line has always had. The server refuses it (`requireCategory()`) and the
  line modal disables Add until one is chosen. Without it an approved order
  commits nothing to the job's budget for that line: `onApprovalSettled`
  groups by `costCategoryId` and skips a null.
- **The supplier of an order placed from an awarded canvass is fixed.** The
  PO has no `canvassId`; the link is derived — the request's AWARDED canvass
  whose selected supplier is the order's supplier (`awardedCanvass()`), and
  returned as `fromCanvass`. `PATCH` refuses a supplier change on such an
  order; the modal disables the select and says why.
- **A rejected order says why.** `onApprovalSettled('purchase_order')` still
  reverts a rejection to DRAFT silently; `GET /purchase-orders/:id` now
  returns `returned: { by, comment, at }` when the latest approval request is
  REJECTED and the order is DRAFT. The page shows "Returned by <name>:
  <comment>" and mounts `DocumentApproval` for the chain.
- **Supplier bills appear on a PO and a receiving only for `gfin.ap.view_all`.**
  Both responses carry `bills` (PO: `id, number, status, total, dueDate`;
  receiving: `id, number, status`) plus `billsVisible`. Without the key the
  array is empty — a link to a bill the reader cannot open is a 403 waiting to
  happen, and payables are finance's register.
- **Stock value is `stockOnHand()` everywhere.** `/inventory/reports/summary.
  totalValue` now calls it; `verify-chain.ts` asserts the summary, the
  dashboard's `stock` tile and the function agree. The per-warehouse rows on
  the same report are still summed from the balances there (they are a
  breakdown, not a second total).
- **The G-CHAIN dashboard never prints a zero it could not count.** It reads
  `GET /gchain/overview`; a null figure prints "—", the sub-line says it is
  outside the reader's access, the tile stops being a link, and a footnote
  explains the dash. An error loading the overview is an error box, not four
  zeros.
- **A dashboard tile opens exactly what it counted.** "Orders awaiting
  delivery" counts ISSUED + PARTIALLY_RECEIVED, so the PO list gained an
  `awaiting=true` filter (declared on the DataList, so the URL seeds it) and
  the tile links to `/g-chain/purchase-orders?awaiting=true`. Asserted:
  `overview.ordersAwaitingDelivery === GET /purchase-orders?awaiting=true .total`.

## Decisions

- **Receivings by job go through the order.** A receiving has no `jobId`;
  `GET /receivings?jobId=` filters `where.order = { jobId }`. `GET
  /borrow-slips?jobId=` was added alongside for the job workspace's
  Procurement tab (`/stock-issues` already had it).
- **Search providers live in the route files** (`procurement.ts`: purchase
  request, canvass, purchase order; `warehouse.ts`: receiving, stock issue,
  borrow slip, warehouse), the pattern `advances.ts` and `meetings.ts` already
  use. Purchase requests narrow to `requestedById` for own-scope holders (the
  list's rule). Canvass and PO narrow to `createdById` — stricter than their
  list screens, which do not yet apply an own scope at all (see open items).
  Warehouse hits link to `/g-chain/warehouses` (no per-record page; matches
  `links.ts`).
- **The PR register follows the menu it was opened from.** `usePrBase()` in
  `PurchaseRequests.tsx` derives `/g-ops/purchase-requests` or
  `/g-chain/purchase-requests` from `useLocation()`, so row clicks, the
  created-request redirect and the breadcrumb keep the sidebar in G-OPS for
  the engineers who raise PRs.
- **`?new=1&jobId=` opens a direct-to-job request for that job**, with the
  project shown as text rather than a picker and the kind switch hidden.
  Closing the modal removes both keys so a reload does not reopen it.
  `neededBy` defaults to today + 7 days (local date).
- **Enter supplier bill** on a receiving links to `/g-fin/ap?fromReceiving=<id>`
  for `gfin.ap.create` holders while no bill covers the receipt (or always,
  when the reader cannot see bills). The AP screen owns what the bill carries.
- **Reorder rows carry `itemId` and `warehouseId`** and link to
  `/g-chain/inventory/:itemId?warehouseId=`. `StockCard` now reads
  `warehouseId` through `useSearchParams` (it read `window.location` once, so
  a second reorder link from the same page showed the first warehouse) and
  offers "Show every warehouse" when narrowed.
- The hand-rolled KPI cards in Orders, Reports and the stock card are
  `charts.tsx` `Stat`; the reports' overdue-borrows card was a `<div onClick>`
  (rule 13) and is now a linked `Stat`. Every raw-pixel inline style in
  `web/src/pages/chain/*` is gone, replaced by `proc-*` classes in
  `styles/procurement.css` (tokens only). Local status pills there are
  `StatusBadge` (canvass `AWARDED` and borrow `RETURNED` passed as `extra`).

## Open items for the owner

- `GET /purchase-requests/:id`, `GET /canvasses` and `GET /purchase-orders`
  (and their `/:id`) do not enforce own scope for a `view_own`-only holder: the
  list and detail show every record. Narrowing them changes what approvers
  holding only `view_own` can open from an approval link, so it was left for a
  deliberate decision rather than slipped in here.
- The PO header modal's supplier list comes from `/suppliers/lookup`; a PO
  whose supplier has since been deactivated keeps it selectable (the current
  one is always offered).
