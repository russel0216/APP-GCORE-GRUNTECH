# Plan — the sales order paper as the owner's slide (2026-10-12)

Written 2026-10-12 for the next session (Opus 5.5). It is a plan, not a
change: nothing below is built. Read `CLAUDE.md` first — rule 6 (one dress,
`renderDesigned`), "Sales orders (2026-10-07)" (the designed order, its
cost columns, the one-row approvals table) and "Quotation PDF template"
(anchors `first` / `after` / `last`, `designSchema`, the editor's copy in
`web/src/lib/pdfTemplate.ts`).

## What the owner asked

Two files: the slide `…6f5d75c6….pptx` (the target, an A4 landscape page
drawn as a picture of the current PDF with the money redrawn) and the
PDF `…6f5d75c6….pdf` (what GT-SO-2026-0005 prints today: two pages, the
totals and the approvals on page 2). His words: "This is what we expect
the content of sales order to reflect on the output PDF and the position
of the boxes; don't reflect the discount, and the approval always sits
at the bottom of the document."

### The target, measured (slide 28.56 × 20.21 cm = A4 landscape; 1 cm ≈ 29.5 pt)

Everything above the line table is as today: letterhead, SALES ORDER,
`# number`, the rule, CUSTOMER and ORDER DETAILS at the same places, the
line table at x 1.3 / y 7.9 cm with the same seven columns (GROUP, PRODUCT
NAME AND ADDITIONAL INFO, QTY, UNIT PRICE (PHP), TOTAL (PHP), COST +
SUPPLIER, MARGIN). What differs:

1. **The line prints AFTER the discount.** The order carries a 17.04 %
   discount: today the line reads unit price 1,130,000.00, total
   1,130,000.00, margin 345,221.16 / 30.6 % — and the totals box then
   says Discount −192,500.00, Sum without tax 937,500.00, Margin sum
   152,721.16, Margin % 16.3 %: two margins for one line. The target
   reads unit price **937,500.00**, total **937,500.00**, cost 784,778.84
   with the supplier under it, margin **152,721.16 / 16.29 %**. No
   discount row anywhere: the discount is applied into the prices.
2. **The totals are two three-cell grids**, right-aligned under the table
   (x 19.1 cm, w 9.3 cm ≈ 541 / 264 pt; the first at y 11.4 cm, the second
   at 12.6 cm, each 1.1 cm high, a 0.1 cm gap), bordered cells, the figure
   bold on top and the label in small capitals under it:

   | TOTAL PRICE | TOTAL COST | MARGIN |
   |---|---|---|
   | 937,500.00 | 784,778.84 | 152,721.16 |

   | VAT (%) | VAT INCLUDED | MARGIN (%) |
   |---|---|---|
   | 112,500.00 | 1,050,000.00 | 16.29 |

   TOTAL PRICE is the sum without tax (the net); VAT INCLUDED is the
   total; MARGIN (%) is margin ÷ net, two decimals, no "%" sign in the
   cell. "Cost (PHP):", "Margin sum:", "Subtotal:", "Discount:", "Sum
   without tax:" are gone. The "Internal booking record …" note stays
   under the table, left (y 10.9 cm).
3. **The approvals table sits at the foot of the page** (x 1.2 / y 16.9
   cm, w 27.2, h 2.1 cm → y ≈ 479–539 pt, right above the footer rule at
   540), the one-row table already built: PREPARED BY · TEAM LEADER ·
   BACK SUPPORT · COST CONTROLLER · CEO / PRESIDENT, the name bold and
   the timestamp or "Pending" under it. (The owner's slide shortens
   "ADMIN BACK SUPPORT" to "BACK SUPPORT"; the step's name is the seeded
   route's — rename the step in the seed's `previously` or leave it; ask.)
4. **A note above the approvals**, italic, small, grey, left (y 16.3 cm):
   "The name, date and time are considered a digital signature of
   approval".
5. **One page** for an order this size — the current print runs to two
   because the eight-row totals box (≈ 125 pt) under the table leaves no
   room above the approvals' top, so `lastPage()` moves them (and the
   totals went with the overflow) to a page of their own.

## Decisions (defaults; the owner has called 1–3)

- **D1 — prices net of the discount, on the paper.** `quotationTotals`
  (`shared/quotation.ts`) gains, per line, `netAmount`, `netUnitPrice`,
  `netMargin`, `netMarginPct`: `netAmount = r2(amount × (net ÷
  subtotal))` with the rounding remainder on the LARGEST line so the
  lines add to `net` exactly (the `groupShares` rule); `netUnitPrice =
  r2(netAmount ÷ quantity)` (a quantity of 0 → the list price);
  `netMargin = netAmount − cost`; `netMarginPct = netMargin ÷ netAmount`.
  The factor is `net ÷ subtotal` (the discount alone) — NOT `netOfTax ÷
  subtotal`, so a VAT-inclusive order still prints VAT-inclusive prices.
  `web/src/lib/quotationMath.ts` mirrors it (verify-sales pins the two
  equal on random inputs — extend that check). **The sales order paper
  reads the net figures**; the quotation paper, the quotation page and
  the sales order page keep the list figures and their discount row
  (a quotation shows the customer the discount; only the booking record
  hides it). Open to the owner: show net figures on the sales order PAGE
  too (default no — one push, the paper only).
- **D2 — the totals block gets a `style`: `rows` (today, the quotation's)
  or `grid`.** `totalsBlock` in `shared/pdfDesign.ts` takes `style:
  z.enum(['rows','grid']).default('rows')`, `columns: num(1, 6)
  .default(3)`, `gridGap: num(0, 20).default(3)`; `drawTotals` lays the
  data rows into cells left to right, `columns` per band, each band
  `rowHeight` tall (the standard order sets 32), the cell's value bold at
  `size + 1.5` on top and its label in `size − 1` capitals under, borders
  in `ruleColor` (0.75), the last band's cells no different (no accent
  rule — the grid has no "total" row; `bold` on a row is ignored in grid
  style). `totalsHeight` follows (`bands × rowHeight + (bands − 1) ×
  gridGap`, scaled by `size / 9`). A band with fewer rows than `columns`
  (a reader with no cost rights gets three cells) fills from the left
  with equal cell widths. Keep `labelWidth` for `rows` only.
- **D3 — the order's rows, in `salesOrderPrintData(order, showCost)`
  (`routes/salesOrders.ts`)**: cost viewers `[Total price, Total cost,
  Margin, VAT (12%), VAT included, Margin (%)]` (six cells, two bands);
  others `[Total price, VAT (12%), VAT included]` (one band). Values:
  `amount(net)`, `amount(totalCost)`, `amount(netOfTax − totalCost)` (=
  today's "Margin sum"), `amount(vatAmount)`, `amount(total)`,
  `marginPct` to TWO decimals without "%" (`16.29`). The label of VAT
  names the stored rate; on a VAT-inclusive order "VAT included (12%)"
  and the total cell "Total" — say so in the label, never a second
  layout. Drop the discount row and `Sum without tax`; `order.discount`
  stays in the field catalogue (an administrator's saved layout may name
  it — `unknownFields()` would refuse it otherwise) but the standard
  layout never places it, and `order.net` is documented as "Total price
  (after the discount)". The line rows take `netUnitPrice`, `netAmount`,
  `{ title: amount(netMargin), body: marginPctText(netMarginPct) }` (the
  margin cell's two-decimal "16.29%").
- **D4 — `STANDARD_SALES_ORDER_DESIGN`** (`shared/salesOrderTemplate.ts`):
  totals → `anchor: 'after', x: 541, y: 372, w: 264.89, h: 70, style:
  'grid', columns: 3, rowHeight: 32, gridGap: 4, size: 8.5`; the
  internal note stays `after` at the left; a new text box `signature-note`
  (`anchor: 'last', x: L, y: 462, w: 480, h: 8.5, size: 7.5, italic,
  color: GREY`, "The name, date and time are considered a digital
  signature of approval"); the approvals box `anchor: 'last', y: 477, h:
  62` (bottom 539, the footer rule at 540 — the engine keeps a `last`
  box's BOTTOM edge, so a fifth wrapped name grows it upward into the
  room above). Several `last` boxes already move together (`lastPage()`).
  The sample data (`salesOrderSample`) carries a discount so the editor's
  preview and the verify fixture show net figures.
- **D5 — "always at the bottom" is the engine's existing `last` rule**,
  which needs no change: the approvals print at the foot of the LAST
  page, on a page of their own only when the lines run into them. The
  compact totals are what keep a one-line order on one page. Add a
  verify case for a long order (40 lines): the approvals and the note
  are on the last page, bottom at 539, the totals grid directly above
  them on that page.

## The changes, in order

1. `shared/quotation.ts` + `web/src/lib/quotationMath.ts`: the net
   per-line figures (D1); verify-sales pins the mirror. ~1.5 h, high
   (the remainder rule and the inclusive-VAT case).
2. `shared/pdfDesign.ts`: `style`/`columns`/`gridGap` on the totals
   block, `drawTotals` + `totalsHeight` for the grid. ~2 h, high.
3. `routes/salesOrders.ts` `salesOrderPrintData`: the six cells, the net
   line figures, no discount row. ~1 h, medium.
4. `shared/salesOrderTemplate.ts`: the standard layout (D4), the
   signature note, the sample with a discount; `DOCS` registry untouched.
   ~1 h, medium.
5. Web `pages/admin/PdfTemplates.tsx` + `lib/pdfTemplate.ts`: the totals
   box's "Layout: rows / grid", "Columns", "Gap" fields and a grid
   preview (`.pt-totals-grid`, tokens only); the quotation's box keeps
   rows. ~1.5 h, medium.
6. Verify: verify-foundation — the two-line sample on one page with the
   six cells (replace the "six totals rows" check), the grid's height,
   the 40-line order's last page (D5); verify-sales — the net figures of
   a discounted order's paper (937,500.00 / 152,721.16 / 16.29 on a
   fixture shaped like GT-SO-2026-0005: one line 1,130,000 at 17.035398 %
   discount, cost 784,778.84), no "Discount" on the paper, a non-cost
   reader's three cells. ~2 h, high.
7. CLAUDE.md: the "Sales orders" paragraph (the grid, the net figures,
   the note), the quotation-template section (`style: grid`), counts.
   ~½ h.

**Effort: 9–10 h for Opus 5.5, two pushes** — (a) 1–4 + their verify
cases, (b) 5–7. Reasoning effort **high** on 1, 2 and 6; medium elsewhere.
Run `cd api && npx tsc --noEmit && npx tsx scripts/verify-foundation.ts
&& npx tsx scripts/verify-sales.ts`, then print GT-SO-2026-0005's shape
and compare with the slide before pushing.

**Live server note**: the layout is a Setting (`pdfTemplate.sales_order`).
If an administrator has SAVED an order layout on gruntech.gcore.tech, the
new standard does not replace it — Admin › PDF Templates › Sales order ›
"Put the standard back" (or the seed must not touch it: rule, "never carry
a layout in the seed"). Say so to the owner on delivery.

## Questions (defaults given)

1. Net figures on the sales order PAGE too, or the paper only (default)?
2. Rename the step "Admin Back Support" to "Back Support" as the slide
   has it (default: keep the seeded name; the slide shortened it)?
3. The grid's MARGIN (%) cell without a "%" sign, as drawn (default: as
   drawn — `16.29`)?
