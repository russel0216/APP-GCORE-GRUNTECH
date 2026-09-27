# C: company details, author phone, PDF letterhead and footer

Part of the SCORO migration. SCORO's quote PDF carries a fuller letterhead
than G-CORE's did: Tel/Fax, TIN, REG. NO. and a strapline ("INDUSTRIAL UTILITY
SOLUTIONS  WWW.GRUNTECHNOLOGY.COM"). The content now prints on every document,
and the layout stays rule 6's layout.

## What prints, and where

The company block is still the footer (rule 6). Three columns and a strapline
row, drawn by `paginate()` in `api/src/shared/pdf.ts`:

| Column 1          | Column 2        | Column 3                             |
|-------------------|-----------------|--------------------------------------|
| NAME (bold)       | Tel: ...        | TIN: ...          (Page n of m)      |
| address           | Fax: ...        | REG. NO.: ...                        |
| city, country     | email           | footerNote (wraps to 2 rows, then ...) |
| STRAPLINE: tagline + website, slate, letter-spaced | | |

- Any line whose value is unset is left out. Nothing prints a label with no
  value after it.
- `footerTagline(company)` returns the tagline with the website added
  (`http://www.x.com/` becomes `WWW.X.COM`), unless the tagline already
  contains the website. With no tagline, the website prints on the strapline
  row by itself. The website never prints twice.
- "Page n of m" moved to the right end of the TIN row. That leaves the rows
  below free for a module's `footerNote` to wrap into. It is still left out on
  single-page documents.
- `FOOTER_TOP` did not change, so pagination is unchanged. The existing
  "60 rows paginate to 3 pages" assertion still holds.
- Bank details (`bankName`, `bankBranch`, `bankAccount`) do **not** print in
  the footer. They belong on documents that ask for payment, which means
  invoices and billing. That module should read them from `prisma.company` and
  put them in a `fields` section. It must not draw them itself.

## pdfSafe: the "±" guard

Every string `renderDocument` puts on a page now goes through `pdfSafe()`:
title, number, reference, every section, sign-offs, footer note, and every
company field. The standard Helvetica only has WinAnsi glyphs. PDFKit writes
any other character as its two UTF-16 bytes, so `₱` came out as ` ±`.
`pdfSafe` handles this as follows:

- `₱` becomes `PHP ` (the `formatMoney` convention)
- common look-alikes such as the minus sign, thin and no-break spaces, `≤`,
  `≥` and `→` become ASCII
- an accented letter outside Latin-1 keeps its base letter
- anything else becomes `?`

Latin-1 and WinAnsi's typographic marks (curly quotes, dashes, bullet, euro,
ellipsis) pass through unchanged. A genuine `±` typed into a document, such as
a tolerance on a service report, is Latin-1 and still prints.

## Phone

- `User.phone` is exposed on `/api/users` (list, get, create, patch) and in
  Admin > Users as "Mobile".
- `GET/PATCH /api/auth/profile` lets a signed-in user read and set **their own
  phone only**. Name, position and reporting line stay with Admin > Users,
  because position prints beside sign-offs and the reporting line routes
  approvals. The PATCH is audited ("Updated own contact details").
- `/api/auth/me` now returns `user.phone`. The `Me` type in
  `web/src/lib/api.ts` does not declare it yet (that file is not owned here).
  The Account page reads `/auth/profile` instead.
- The quotation PDF's "Sincerely Yours," block should read the **author's**
  `User.phone` and `User.email` from the database. It should not read the
  viewer's.

## Company settings

`PUT /api/company` accepts `regNo`, `fax`, `bankName`, `bankBranch`,
`bankAccount` and `documentTagline`, each trimmed and length-capped (tagline
140). A blank value is stored as `null`, not `""`, so the footer drops the
line. The Company Settings screen has these fields, plus a new "Bank details"
card. The logo hint now says top-right, which is where the engine has always
drawn it.

## Tests

`verify-foundation.ts` has a "Letterhead" section with 11 assertions.
`REG. NO.`, the registration number, the tagline, `Fax:` and the website on
the strapline all print. A `₱` in a table cell and in the footer note never
reaches the page as `±` and prints as `PHP`. The strapline stays more than
12pt off the bottom edge, content still starts 14pt from the left, and the
letterhead does not add a page.

The test only *borrows* `regNo`, `fax` and `documentTagline` when the database
has none, and resets exactly those to null afterwards. A value an
administrator has set is asserted as it stands and never overwritten.
