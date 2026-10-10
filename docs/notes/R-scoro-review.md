# R — SCORO integration review (2026-09-27)

What the review changed after the C and Q packages landed, and why. (The
review's findings on the SCORO archive package went with the archive on
2026-10-10, the owner's call; what remains is the PDF engine.)

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
- `sales.ts`'s `footerNote` no longer repeats the company name. It was already
  changed when this pass started.
