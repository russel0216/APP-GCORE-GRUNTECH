# R — SCORO integration review (2026-09-27)

What the review changed after the C, Q and A packages landed, and why.

## House-number counters follow the quote's own date

`parseHouseNumber(number, date)` and `counterTargets(quotes, currentMonth)` in
`api/src/shared/legacyQuotes.ts` accept a ten-digit number only when its YY
and MM equal the quote's own date. Two SCORO numbering habits made the shape
test alone wrong:

- Camille Guiling's numbers are `83` + YYMM + a four-digit run
  (`8326090163`, `8326010050`). The old parser read `8326010050` as code 832,
  month 2060-10, and would have seeded a counter 34 years out.
- Some quotes carry a number from another month (`0012608048` dated
  2026-09-03).

Everything that fails the test is archived unchanged and listed in the
report's `notHouseFormat` ("not in the house format — no counter seeded"), in
the CLI, and on the import dialog.

Counters are keyed by the number's code (`<YYYY-MM>@<code>`), never by the
owner's name. A salesperson who issued a number under a colleague's code
raises that colleague's counter, which is what stops G-CORE issuing the same
number again. Owner codes on the report use the same date test.

## "pdf": null

The converter now takes several PDFs. A quote in the CSV that none of them
contain is bundled with `"pdf": null`. `importBundle` archives it without an
attachment and counts it separately (`totals.noPdf`, `pdfs.noPdf`) from
`missing`, which means the bundle names a PDF it does not hold. The detail
page shows "No PDF was exported from SCORO for this quote" instead of the
Open PDF button, and `GET /quote-archive/:id/pdf` returns a 404 with that
message. An empty `pdf` no longer falls back to guessing `pdf/<number>.pdf`.

## PDF engine

- `PdfCell = string | { title; body? }` in `shared/pdf.ts`. A table cell can
  now print a bold title with regular text under it. Plain string cells are
  unchanged, and `safeSection` runs both parts through `pdfSafe`. The
  quotation uses it for the line title and for the group sub-heading row, so
  SCORO's "title in bold, description under it" look is complete.
- The header's `Reference:` line now wraps inside the space left of the logo,
  and the next line starts below it. Before this, a long reference overprinted
  the next section. The quotation still passes no reference. It could pass one
  again now.

## Other cross-file notes applied

- `web/src/lib/api.ts`: `Me.user.phone` is declared, because `/auth/me` already
  returns it.
- `web/src/main.tsx` imports `styles/archive.css`. A previous pass of this
  review had already added it.
- `sales.ts`'s `footerNote` no longer repeats the company name. It was already
  changed when this pass started.

## Tests

`verify-archive.ts` has 103 assertions. The new ones cover the date-matched
parse, the Camille-style number, a YYMM that differs from its date, a
colleague's code seeding its own counter, a `"pdf": null` quote (dry run,
commit, detail, and a 404 from /pdf), and a dry run of the Brian, Camille and
Daniel bundles that seeds no counter for a month still to come.
