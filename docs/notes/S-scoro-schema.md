# SCORO continuation: schema, registry, seed, stubs (key S)

The groundwork for moving from SCORO to G-CORE. Schema, permission, seed and
route changes only. The screens and routes themselves are stubs that other work
packages fill in.

## Schema (additive, nothing migrates destructively)

- **Company**: `regNo`, `fax`, `bankName`, `bankBranch`, `bankAccount`,
  `documentTagline`. These are what SCORO's letterhead and footer print.
- **User.phone**: the author's mobile, printed under "Sincerely Yours,". It
  lives on `User` rather than `Employee` because a login does not need an
  employee record behind it (`Employee.mobile` still exists for HR).
- **QuotationRevision**: `discountPct`, `discountAmount`, `prNumber`,
  `delivery`, `paymentTerms`. `subtotal` stays the sum of line amounts
  **before** discount. After that: `net = subtotal - discountAmount`,
  `vatAmount = net x vatRate`, `total = net + vatAmount`. `discountAmount` is
  stored so a printed revision cannot drift.
- **QuotationItem**: `group`, `title`, `unitCost`, `costAmount`
  (= quantity x unitCost, stored), `providerSupplierId` (outsourced) /
  `providerUserId` (in-house, relation `QuoteLineProvider`), `costNote`.
  **Internal only**: cost and margin never print on the customer PDF, and the
  server strips them for callers who may not see them.

(The read-only SCORO archive this package also laid the groundwork for — its
table, its permission entry and its seeded grants — was removed on
2026-10-10, the owner's call; the retired model waits for a later push to
drop it.)

## Company seed

On a **fresh** database, the company row is created from SCORO's company data:
name, address, TIN, Reg. No., phone, fax, email, website, BPI Marikina account
and the tagline. `update` is still `{}`, so the seed never touches an existing
database. On the current dev and production databases these new columns stay
empty until someone enters them in Admin > Company.
