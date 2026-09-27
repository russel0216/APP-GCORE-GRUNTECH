# SCORO-style quotations (key Q)

Quotations now carry what SCORO carried: a group, a product title and a
description per line, a quote-level discount, PR Number / Delivery / Payment
Terms, and, internally, each line's cost and who carries it.

## The one arithmetic: `api/src/shared/quotation.ts`

`quotationTotals({ lines, discountPct, vatRate, vatInclusive })` is the only
place quotation money is computed. It uses Decimal inside and rounds half-up to
the centavo at each named step:

```
subtotal       = sum of line amounts               (stored, BEFORE discount)
discountAmount = round2(subtotal x pct / 100)      (stored)
net            = subtotal - discountAmount          (derived)
VAT exclusive:  vatAmount = round2(net x rate);  total = net + vatAmount
VAT inclusive:  vatAmount = round2(net - net/(1+rate));  total = net
netOfTax       = net, or net - vatAmount when inclusive   ("Sum without tax")
```

- **Margin is measured against `netOfTax`**, never against a VAT-inclusive
  price. On a VAT-exclusive quote this is `net`.
- **The cost panel:** `totalCost` is split by provider. A line with
  `providerUserId` is in-house, one with `providerSupplierId` is outsourced, and
  a line with neither is unassigned. A line may not name both, and the route
  refuses that. `totalMargin = netOfTax - totalCost`. The in-house and
  outsourced margins take the discount **pro rata**
  (`revenue x netOfTax/subtotal - cost`). The unassigned margin is the
  remainder, so the three always add up to the total to the centavo. Every
  percentage is a percentage of `netOfTax`.
- **The line margin** (`amount - costAmount`, and its % of amount) is shown
  **before** the discount, as SCORO shows it.
- `recalcQuotationRevision(revisionId, tx)` stores the result. Every writer of
  a revision's totals goes through it: the line routes, a new revision, filling
  from a costing, and the revision PATCH. **The SCORO "Continue in G-CORE"
  action must call it too** after it creates the lines.
- `lineAmount(qty, price)` gives the stored `amount` and `costAmount`. The
  server computes both and never accepts them from the client.
- `quotationValue()` in `shared/pipeline.ts` is unchanged. It reads
  `revision.total`, which now already has the discount taken off.

## Who sees cost

`canSeeQuotationCost(user, ownerId)` returns true for whoever may edit the
quotation (`canEditRecord`) or holds `gops.costing.view_all`. For everybody
else, `GET /quotations/:id` removes the line keys `unitCost`, `costAmount`,
`providerSupplierId`, `providerSupplier`, `providerUserId`, `providerUser` and
`costNote` on the **server** (`stripLineCost`). It also leaves out `costPanel`,
and it drops `totalCost` from the linked costing summary. The response carries
`canSeeCost` so the screen knows whether to draw the columns. With the seeded
roles, the author, a sales manager (edit_all and costing), an executive and a
super admin see cost. A salesperson looking at a colleague's quotation does not.

The PDF never reads a cost field.

## Routes (all in `api/src/routes/sales.ts`)

- `GET /quotations/providers?kind=user|supplier&q=` returns names only. It is
  gated by quotations create or edit. Its own route exists because
  `/suppliers/lookup` needs `gchain.suppliers.view_all`, which the sales role
  does not hold (the same reasoning as `/overtime/chargeable`). It is declared
  above `/:id`.
- The item POST and PATCH accept `group`, `title`, `description`, `quantity`,
  `unit`, `unitPrice`, `unitCost` (null clears it), `providerSupplierId`,
  `providerUserId` and `costNote`. A line needs a title or a description. On
  PATCH, choosing one kind of provider clears the other. Line add, change and
  removal are now audited, which they were not before.
- The revision PATCH accepts `discountPct` (0-100), `prNumber`, `delivery` and
  `paymentTerms`, and is audited.
- `POST /quotations` accepts the same three header fields. **Payment terms
  default to `Customer.paymentTerms`.**
- A new revision copies the new line and header fields.
- `GET /quotations` and `GET /quotations/:id` include
  `legacyQuote { id, number, status }`.

## PDF

The PDF keeps the `renderDocument` layout and carries SCORO's content: Date,
Quote No., Client (name, address, phone, website), Attention (name, position,
mobile, email), Payment Terms, PR Number, Delivery and Validity. It then prints
the opening sentence and the lines, with the group as an upper-case sub-heading
row and the title above the description. The totals are Sub Total Price, Less
discount (n%) and Sub Total after discount (only when there is a discount), then
VAT and Total Price. The terms and notes follow, then the closing sentence,
"Sincerely yours," with the author's name, `User.phone` and email, and "This
document is system generated...". The sign-off lines are unchanged.
`footerNote` is now just `number Rn`, because the engine's footer carries the
company block and strapline. The header `reference` was dropped: the Client
field names the customer, and a long reference wrapped into the first field row.

**For the pdf.ts owner:**
1. Table cells cannot be bold, so the line title prints on its own line rather
   than in bold. A `{ text, bold }` cell (or a bold-first-line flag) would give
   SCORO's look.
2. The header's `Reference:` line does not advance `doc.y` for a wrapped value,
   so it overprints whatever follows.

## Web

`web/src/pages/sales/Quotations.tsx`:

- **Lines table:** Group, Product | Description, Qty | Unit, Unit price and
  Amount, plus Cost & provider and Margin when `canSeeCost`.
- **Totals block:** the discount % is edited in place and saved on Enter or
  blur. Beside it is the SCORO cost panel.
- **Line modal:** an in-house / supplier toggle with a searchable picker, the
  unit cost and a cost note.
- **Modify:** now takes PR number, payment terms (prefilled from the customer)
  and delivery.
- **SCORO link:** "Continued from SCORO <number>" links to
  `/g-ops/quote-archive/<id>`.

The styles are appended to `web/src/styles/pipeline.css`, which `main.tsx`
already imports, so no import line is needed.
