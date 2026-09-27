# SCORO → G-CORE

Two workstation-side converters for the move from SCORO. They run on the
workstation that has the SCORO exports. **Nothing here runs on the server**, and
the server never needs Python.

| Script | Reads | Writes |
|---|---|---|
| `scoro_convert.py` | SCORO's companies export | `gcore_customers_import.csv`, `gcore_suppliers_import.csv`, `gcore_industry_review.csv` for G-CORE's CSV import |
| `scoro_quotes.py` | SCORO's quotes export (CSV) and one or more combined Quotes PDFs | a **bundle** folder: `quotes.json` plus `pdf/<quote number>.pdf` |

Import the customers **first**, because the quote import matches each SCORO
quote to a G-CORE customer. It tries the exact company name (case-insensitive)
first, then the `SCORO id <n>` that `scoro_convert.py` writes into each
customer's Notes.

## What you need on the workstation

- Python 3.10 or later.
- PyMuPDF, for `scoro_quotes.py` only: `pip install pymupdf`.

## 1. Export from SCORO

- **Companies**: Contacts → Companies → export → `companies_export.csv`. SCORO
  writes it as UTF-16, tab-separated, and the scripts expect exactly that.
- **Quotes**: Sales → Quotes → select all → export → `quotes_export.csv`.
- **Quote PDFs**: from the same list, select all → Print / PDF → save the
  combined `Quotes.pdf`. SCORO splits a large selection into several PDFs;
  keep them all, the converter takes any number.
- Export per salesperson if that is easier (one CSV and its PDFs each) and
  convert each into its own bundle; the import is keyed on SCORO's id, so the
  bundles can be imported one after another in any order.

## 2. Convert on the workstation

```bash
python tools/scoro/scoro_convert.py companies_export.csv out/
# → out/gcore_customers_import.csv, gcore_suppliers_import.csv, gcore_industry_review.csv
#   Add --show to list the industry guesses worth checking.

python tools/scoro/scoro_quotes.py quotes_export.csv Quotes.pdf scoro_bundle/
python tools/scoro/scoro_quotes.py quotes_export.csv "Quotes (1).pdf" "Quotes (2).pdf" scoro_bundle/
# usage: scoro_quotes.py <export.csv> <a.pdf> [<b.pdf> ...] <out-dir>
# → scoro_bundle/quotes.json and scoro_bundle/pdf/*.pdf
```

The CSV comes first and the output folder last; every argument between them is
a PDF. A quote the PDFs repeat takes its first copy.

Load the two customer and supplier CSVs through G-CORE's own import on the
Customers and Suppliers screens, after checking `gcore_industry_review.csv`.

`scoro_quotes.py` reads each quote's lines out of the PDF text, because SCORO's
CSV does not carry them, and checks them against the CSV total. A quote whose
lines do not add up is still archived, with `linesReconcile: false`. The PDF is
the record, and the archive and "Continue in G-CORE" both say so.

**No PDF.** A quote in the CSV that none of the PDFs contain is still bundled,
with `"pdf": null` and no lines. The import archives it without an attachment
and counts it as `no PDF: n` in the report (apart from "missing", which means
the bundle names a PDF that is not in it). Its archive page says "No PDF was
exported from SCORO for this quote", and with no lines a "Continue in G-CORE"
starts from an empty revision. Re-export and re-run the converter to add the
PDF later; the import replaces nothing else.

## 3. Copy the bundle to the server

Copy the whole `scoro_bundle` folder, including `quotes.json` and `pdf/`,
anywhere on the server, for example `C:\G-CORE-GRUNTECH\imports\scoro_bundle`.
It is about 13 MB for 191 quotes.

## 4. Import

Start with a dry run. It writes nothing.

```bash
cd api
npx tsx scripts/import-scoro-quotes.ts C:\G-CORE-GRUNTECH\imports\scoro_bundle
```

It reports:

- how many quotes there are, and how many are open or closed;
- the SCORO customers it could not match. Import or rename those customers, or
  link the quotes one by one afterwards;
- each SCORO owner's employee code (the first three digits of the number,
  `001` in `0012609059`) against the employee number of the G-CORE login with
  the same name. A mismatch needs fixing **before** that person raises a
  quotation in G-CORE, or their numbers will not follow on from SCORO;
- the numbers **not in the house format** — no counter is seeded for them. A
  number counts only when it is `{EMP}{YY}{MM}{SEQ}` and its YY and MM are the
  quote's own date. `8326090163` (a two-digit `83`, YYMM, then a four-digit
  run) would otherwise read as code 832 in the year 2060;
- the quotes whose lines do not add up;
- the quotation counters it would raise, one per **code** per month, and the
  next number each would issue (`2026-09@001  SCORO last 59 … next number
  0012609060`). The code is the number's, not the owner's: a quote raised
  under a colleague's code raises the colleague's counter, which is exactly
  what keeps G-CORE from issuing that number again.

Then import:

```bash
npx tsx scripts/import-scoro-quotes.ts C:\G-CORE-GRUNTECH\imports\scoro_bundle --commit
# optional: --as admin@gruntech.com  (defaults to the first active super admin)
```

It is safe to run again. Quotes are keyed on SCORO's id, so a second run
updates them rather than adding duplicates, and replaces a PDF that changed. It
never clears a link somebody made in G-CORE: a quote already continued stays
continued, and a customer linked by hand stays linked. Counters are only ever
raised.

A super admin can also run the same import from the browser: **G-OPS → Sales →
SCORO Archive → Import from SCORO**. Choose `quotes.json` and every PDF in the
bundle's `pdf` folder (a bundle with no PDFs at all is fine), check the dry run,
then import.

## Numbering

The quotation number continues from SCORO only when Quotation numbering is
`{EMP}{YY}{MM}{SEQ}`, monthly, per employee (Admin → Numbering). The import
seeds the counters whatever the setting. If the setting is different, the dry
run warns that the counters will only take effect once the numbering is
switched.
