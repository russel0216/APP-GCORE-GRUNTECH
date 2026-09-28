# Quotation editor — a page, not a dialog

The owner asked for quotation creation to work as SCORO's did: "+ New" opens a
full page, "Modify quote details", where the header and the lines are typed in
directly, rather than a popup that asks for a customer and a subject and then
drops you on a record page to add lines one dialog at a time.

## What changed

### Web

- **`web/src/pages/sales/QuotationEditor.tsx`** — one component, two routes:
  - `/g-ops/quotations/new` creates (guarded by `gops.quotations.create`);
  - `/g-ops/quotations/:id/edit` modifies the quotation's DRAFT revision. The
    API decides who may edit; the page says plainly when the viewer is not the
    author (or an `edit_all` holder), or when no revision is a draft.
- **Layout, SCORO's:** two header columns (collapsing to one under 860px) —
  Quote No. (preview, "assigned when saved"), Date of issue, Client, Attention,
  Site, Quote name, Author, Comment | Due date, Estimated closing date,
  Currency, Status (Opportunity), Probability, enquiry (lead), Costing — then
  PR Number / Delivery / Payment Terms and the terms. Then the lines table with
  an empty row to type into; then Subtotal, Discount %, Sum without tax, Tax,
  Total and, for anyone who may see cost, the cost panel (total / in-house /
  outsourced cost and margin, each with its %).
- **Mapped, not faked.** SCORO's "Due date" is the revision's `validityDays`
  counted from the date of issue; "Comment" is the revision's `notes` (printed
  under Notes); "Estimated closing date" is `expectedClosing`. Project and
  Pricing method are left out: G-CORE links a quotation to a project when the
  project is created from it, and has no pricing method.
- **The lines table:** drag handle replaced by keyboard-reachable ↑/↓ buttons,
  Group (with a datalist of the quotation's own groups), Product over
  Description, Quantity over Unit, Unit price, Amount, "Cost and provider
  info" (In-house / Supplier / Not named, a search-as-you-type provider, notes,
  unit cost) and Margin with its %. "+ Add line", Enter on the last row's price
  adds a row, ✕ removes one. Blank rows are ignored on save. `#line-3` on the
  URL (the detail page's per-line Modify) lands on that line.
- **Live figures are the server's arithmetic.** `web/src/lib/quotationMath.ts`
  mirrors `quotationTotals` / `lineAmount` from `api/src/shared/quotation.ts`
  step for step in exact BigInt fixed-point, rounding each intermediate to 20
  significant digits, half up, as decimal.js does. It is not a second rule:
  `verify-sales.ts` asserts it equals the server function on hand-picked cases
  (discount 0/10/33.3333%, VAT inclusive/exclusive, in-house/outsourced/none)
  and on 500 generated quotations, and that what the page showed before saving
  equals what was stored.
- **`web/src/components/CustomerPicker.tsx`** — "Create or choose a client":
  the lead form's lookup-or-add (debounced `/customers/lookup?q=`, capitals as
  typed, quick-add with the industry beside the button), as a component. The
  lead form keeps its own copy because its company name is also a free-text
  field of the lead; switching it over would change its behaviour.
- **Prefill, carried over from the old dialog:** `?leadId=` fills customer,
  contact (the lead's contact by name, else the customer's primary), site,
  subject (the enquiry's first line), expected closing and the lead's latest
  costing; `?costingId=` fills customer, site, subject and — when the costing
  came from a lead — everything the lead gives; `?customerId=` fills the
  customer. A costing chosen before anything is typed in the table previews its
  scope of work as the lines; after that only "Fill from costing" replaces them
  (with a confirm). Payment terms follow the chosen customer's until typed.
- **Author:** yourself, read-only — unless you hold `gops.quotations.edit_all`
  (or are super admin), when you may pick anyone holding
  `gops.quotations.create` (`/users/lookup?holding=`). The Quote No. preview
  follows the chosen author's employee digits.
- **Entry points:** the list's "+ New quotation" and the pipeline board's
  "+ New › Quotation" navigate to `/new`; the lead's, the costing's and Customer
  360's links point straight at `/new?…`. **`/g-ops/quotations?new=1&…` still
  works** — the list redirects it (replace) to `/new` with the same preset, so
  bookmarks survive. `NewQuotationModal` is deleted.
- **Detail page:** "Modify" opens the editor while a DRAFT revision exists;
  otherwise it keeps the small dialog for what may still change after a
  revision has left draft (subject, probability, expected closing). "+ Add
  line" became "Edit lines" and each line's Modify opens the editor on that
  line. The line dialog (`ItemModal`) and its `ProviderPicker` are deleted.
  View, approval, revisions, PDF, discount-in-place and outcome buttons are
  unchanged; non-draft revisions stay read-only.
- **Validation:** client and quote name required, at least one line, every
  kept line needs a product or a description, quantity/price/cost ≥ 0, discount
  0–100, due date after the date of issue. Errors show under their field (and
  in the ErrorBox), and focus moves to the first one. Cancel confirms when
  something was typed; leaving the tab with unsaved work gets the browser's
  prompt.
- **`components/ui.tsx` `Field`:** a child that brings its own `id` now has the
  label pointing at that id (it used to point at the generated one, leaving the
  label attached to nothing).
- Styles in `web/src/styles/quotation-editor.css`, tokens only. The lines table
  scrolls sideways inside its card on a phone; the page never does.

### API (`api/src/routes/sales.ts`, `api/src/shared/quotation.ts`)

- **`POST /quotations`** also takes `lines[]` (each an `itemSchema` row),
  `ownerId`, `notes`, `discountPct` and `vatInclusive`. ONE transaction: the
  number (`nextNumber('quotation', tx, { ownerId })`), the quotation and its R0,
  each line checked (`checkLine(line, tx, 'Line n: ')`) and written in order
  (`sortOrder` = position), `recalcQuotationRevision(revisionId, tx)`, and the
  lead's move to QUOTATION_CREATED. A refused line rolls all of it back,
  including the number. Without `lines`/`ownerId` it behaves exactly as before.
- **`ownerId`** is honoured only for `edit_all` (or super admin); anyone else
  naming somebody other than themselves gets a **403** rather than a quotation
  quietly filed under the caller. The named person must hold
  `gops.quotations.create` (else **400**).
- **`PUT /quotations/:id/revisions/:revisionId/lines { lines }`** replaces every
  line of a DRAFT revision atomically: `revisionForEdit()` (DRAFT only,
  `canEditRecord`), the status re-checked inside the transaction, lines checked,
  old ones deleted, new ones written in order, totals recomputed, one UPDATED
  audit row ("n → m lines"). Answers with `presentRevision(…, canSee)`.
  Idempotent — the editor can safely retry a save.
- **`GET /quotations/costing-lines?costingId=`** (above `/:id`) returns the
  lines a costing's scope of work gives — the same mapping
  `POST …/from-costing` writes, now one function:
  `quotationLinesFromSections()` + `costingScopeSections()` in
  `shared/quotation.ts`. Prices only (a section's value is its share of the
  contract). 400 without a costing, 404 for an unknown one.
- **`GET /quotations/next-number?ownerId=`** previews another author's number
  for `edit_all` (ignored for anyone else), and now also returns `vatRate` and
  `currency` — what the new revision will snapshot — so the editor's tax line
  is the one the saved quotation stores.
- `lineData()` is the one place a line's stored fields (amount and cost amount
  computed from quantity × unit figures) are built; the single-line POST, the
  create and the PUT all use it.

## Rules worth keeping

1. **The editor is a page, not a dialog.** Do not reintroduce a create modal;
   new entry points link to `/g-ops/quotations/new?leadId=&costingId=&customerId=`.
2. **One save = one transaction** on create. Lines go in the POST body, not in
   follow-up requests, so a failed line can never leave a numbered quotation
   with half its lines.
3. **The `?new=1` links redirect.** Keep the redirect in `Quotations` for
   bookmarks and old links.
4. **One arithmetic.** The page's figures come from `lib/quotationMath.ts`,
   which is pinned to `quotationTotals`. Change the server rule and the
   verify-sales check fails until the mirror follows.
5. **One costing-to-lines mapping** — `quotationLinesFromSections()`.
6. The editor only renders the cost column when the viewer may see cost; on the
   edit page that is the API's `canSeeCost` (cost keys absent = hidden). An
   editor can always see cost (`canSeeQuotationCost` includes the author and
   `edit_all`), and the page refuses to rewrite lines it could not see.

## Verification

`verify-sales.ts` gained 37 assertions (147 in all): the mirror against
`quotationTotals`; create with lines (number issued once and as previewed,
order kept, totals equal `quotationTotals`, lead moved, audited once); a refused
line (no product or description, an unknown provider, a negative quantity)
leaves no quotation and burns no number; `ownerId` refused (403) for a
salesperson, refused (400) for a non-author, honoured for a manager and
carrying the author's number; `next-number?ownerId=` followed for a manager and
ignored for a salesperson; PUT lines replaces in order and recomputes, refuses
atomically, 403s a non-author and 400s an approved revision; `costing-lines`
equals what `from-costing` writes.
