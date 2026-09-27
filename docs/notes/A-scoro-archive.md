# SCORO Archive: import, numbering continuation, Continue in G-CORE (key A)

The read-only history of quotations raised in SCORO, and the one door out of it:
continuing an open SCORO quote as a live G-CORE quotation under the same number.

## Files

| File | What it holds |
|---|---|
| `api/src/shared/legacyQuotes.ts` | `importBundle`, `seedCounters` / `planCounters` / `counterTargets`, `continueLegacyQuote`, the OPEN/CLOSED status sets, `outcomeFor`, `storeLegacyPdf` |
| `api/src/routes/quoteArchive.ts` | `/api/quote-archive`: list, `/facets`, `/export.csv`, `/import`, `/:id`, `/:id/pdf`, `/:id/continue`, `PATCH /:id/customer` |
| `api/scripts/import-scoro-quotes.ts` | The console import. Dry run by default, `--commit` to apply, `--as <email>` |
| `api/scripts/verify-archive.ts` | 88 assertions. Needs the API running |
| `api/src/shared/search.ts` | The `legacy_quote` Ctrl+K provider |
| `api/src/routes/customers.ts` | `legacyQuotes` on `GET /customers/:id` (50, newest first, behind `gops.quote_archive.view_all`) |
| `web/src/pages/sales/QuoteArchive.tsx` | List, detail, import dialog, continue and link-customer dialogs. Exports `SCORO_STATUS_TONES` and `ScoroStatus` |
| `web/src/pages/masters/Customer360.tsx` | The "SCORO history" collection. `Collection` gained an optional `action` slot for "View all" |
| `web/src/styles/archive.css` | Tokens only. **Needs `import './styles/archive.css';` in `web/src/main.tsx`** |
| `tools/scoro/` | The workstation converters and a README for the whole run |

## Rules worth keeping

- **The archive is history, not a quotation.** No live record points at a
  `LegacyQuote`. Its only link is the one-way `continuedQuotationId`, written
  once, in the same transaction that creates the quotation. The write is
  conditional (`WHERE continuedQuotationId IS NULL`), so two people clicking
  at the same moment cannot both win.
- **Re-import is an upsert on `(source, sourceId)`.** It updates the fields but
  never clears `continuedQuotationId`. It also never clears a `customerId` or
  `ownerUserId` that the bundle fails to match, because an unmatched re-import
  must not undo a link someone made by hand. A number already archived under a
  different source id is skipped and reported, not overwritten.
- **Customer match.** It tries the exact name first, case-folded with whitespace
  collapsed. Failing that, it looks for a customer whose Notes carry
  `SCORO id <n>`. `scoro_convert.py` writes `(SCORO id 39, 40)` when it merges
  two SCORO companies, so the id list is parsed, and each id is a whole token:
  39 never matches 390.
- **Owners match by user name**, case-insensitively. The report compares each
  owner's commonest SCORO code (first three digits of the 10-digit numbers)
  with `employeeToken(employeeNoFor(user))` and flags a mismatch. Fix a
  mismatch before that person raises a quotation, or their G-CORE numbers will
  not follow on from SCORO's.
- **Counters are only ever raised.** For each `<YYYY-MM>@<emp>` from the
  current Manila month on, `lastNumber` becomes `max(existing, highest SCORO
  seq)`. A new row copies label, pattern, type code, period, scope and padding
  from the template, exactly as `nextNumber` does. The raise is a conditional
  `updateMany ... lastNumber < seq`, so a number issued in between is never
  undone. Earlier months are left alone because nothing is ever issued into
  them again.
- **Counters are seeded whatever the template says.** Admin > Numbering's
  update rewrites every row of a type, so a counter seeded while the template
  is still `{PREFIX}-{TYPE}-{YYYY}-{SEQ}` takes the house pattern the moment
  the template switches. The dry run warns when the template is not
  `{EMP}{YY}{MM}{SEQ}`, MONTH, OWNER. **The dev database's quotation template
  is currently the stock YEAR/GLOBAL one.**
- **PDFs go through the one attachment store** as entity `legacy_quote`, under
  a random stored name in `UPLOAD_DIR`. The same bytes are kept (sha256);
  different bytes replace the old file. A file that does not start `%PDF-` is
  refused. An attachment guard gives the generic attachment routes the same
  rule as the archive: `gops.quote_archive.view_all`.
- **Continue** needs `gops.quotations.create`, an OPEN status (Opportunity,
  Negotiation, Closing, Hold, This Month Forecast, Confirmed), a linked customer
  (400 `Link this SCORO quote to a customer first`), and no existing quotation
  with that number (409). It creates revision 0 DRAFT with the parsed lines,
  `discountPct`, `prNumber`, `delivery` and `paymentTerms`. Totals come from
  `recalcQuotationRevision` in the Q package's `shared/quotation.ts`, so there
  is no second copy of the arithmetic. The owner is the matched SCORO owner,
  else whoever continues it. The contact is matched by name on the customer,
  else created. Both the quotation and the archive row are audited. A quote
  whose lines did not reconcile gets a note telling the author to check them.
- **SCORO's cost** follows `canSeeQuotationCost` (the author, edit_all, or
  `gops.costing.view_all`). The server strips it for everyone else, and the CSV
  drops the column for them.
- **Every CSV is audited before the bytes go out** (`legacy_quote` / `export` /
  `EXPORTED`).
- **The browser import** uses the same `importBundle`, fed from a temporary
  folder shaped like the bundle. The folder is removed in `finally`. The PDFs
  are optional, so a dry run can be made from `quotes.json` alone.

## Real bundle (dry run on dev, 2026-09-27)

- 191 quotes: 71 open, 120 closed. All 191 PDFs are present.
- 13 quotes have lines that do not reconcile.
- Every quote belongs to one owner, Carter Gasiong. His codes are 001 ×181,
  015 ×2 and 034 ×2. There is no G-CORE user of that name on dev yet.
- On the dev database 0 customers match (it has 4 customers, none imported from
  SCORO). The report lists all 70 SCORO customers.
- Counter plan: `2026-09@001`, SCORO last 59, so the next number is `0012609060`.
