# C: company details, author phone, PDF letterhead and footer

Part of the SCORO migration. SCORO's quote PDF carries a fuller letterhead
than G-CORE's did: Tel/Fax, TIN, REG. NO. and a strapline ("INDUSTRIAL UTILITY
SOLUTIONS  WWW.GRUNTECHNOLOGY.COM"). The content now prints on every document,
and the layout stays rule 6's layout.

## What prints, and where

Since 2026-10-10 every document wears one dress, the quotation template's
(`renderDocument` in `api/src/shared/pdf.ts`; CLAUDE.md rule 6):

- **The letterhead, top-left of page 1**: the logo, the registered name (else
  the trading name) in purple capitals, then the address, "Tel No.: … | Fax
  No.: … | Email: …", "Website: www.…" and "TIN: … | REG NO: …". A part whose
  fields are all empty drops out of its line; a line with nothing left drops
  out. Nothing prints a label with no value after it.
- **The strapline, along the foot of every page**: the tagline in green
  capitals — or, with no tagline, the website. Never both.
- **"Page n of m"** bottom-right, on multi-page documents only; a running
  header (reference · document # number · date) from page two.
- A module's `footerNote` prints above the strapline rule.
- Bank details (`bankName`, `bankBranch`, `bankAccount`) do **not** print in
  the letterhead. They belong on documents that ask for payment, which means
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
