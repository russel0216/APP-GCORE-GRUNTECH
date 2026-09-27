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
- **LegacyQuote**: the read-only SCORO archive. It is *not* a quotation, and
  nothing in live work links to it. Its only link is the one-way
  `continuedQuotationId` (unique), set when an open SCORO quote is continued as
  a live Quotation under the same number. `@@unique([source, sourceId])` and
  `number @unique` make a repeated import an upsert, not a duplicate.

## Permissions

`gops.quote_archive` sits in the G-OPS **Sales** group right after Quotations,
with the actions `view_all`, `export` and `create`. `create` means *run the SCORO
import*. Continuing a quote is gated by `gops.quotations.create`, not by this
entry.

Seeded grants (the never-offered rule is unchanged):

| Role | view_all | export | create |
|---|---|---|---|
| sales | yes | | |
| sales_manager | yes | yes | |
| project_manager | yes | | |
| executive (computed) | yes | yes | |
| super admin | yes (by being super admin) | yes | yes |

## Company seed

On a **fresh** database, the company row is created from SCORO's company data:
name, address, TIN, Reg. No., phone, fax, email, website, BPI Marikina account
and the tagline. `update` is still `{}`, so the seed never touches an existing
database. On the current dev and production databases these new columns stay
empty until someone enters them in Admin > Company.

## Sales group size

Sales now holds eight screens: Leads, Customers, Calendar, Quotations, SCORO
Archive, Pipeline, Costing and Partners. That is more than the "roughly six" in
CLAUDE.md rule 14. Once the migration is finished and the archive is only looked
up occasionally, consider moving it to its own group.
