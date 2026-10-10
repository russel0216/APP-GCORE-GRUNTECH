# SCORO → G-CORE

One workstation-side converter for the move from SCORO. It runs on the
workstation that has the SCORO exports. **Nothing here runs on the server**, and
the server never needs Python.

| Script | Reads | Writes |
|---|---|---|
| `scoro_convert.py` | SCORO's companies export | `gcore_customers_import.csv`, `gcore_suppliers_import.csv`, `gcore_industry_review.csv` for G-CORE's CSV import |

The quotation converter that used to sit beside it (`scoro_quotes.py`, which
read each quote's lines out of SCORO's PDFs into a bundle for a read-only
archive) was removed on 2026-10-10 with the archive — the owner's call,
"remove also scoro data". SCORO's quotations and invoices will come across
later, as real quotations and sales orders, through an upload of their own.

## What you need on the workstation

- Python 3.10 or later.

## 1. Export from SCORO

- **Companies**: Contacts → Companies → export → `companies_export.csv`. SCORO
  writes it as UTF-16, tab-separated, and the script expects exactly that.

## 2. Convert on the workstation

```bash
python tools/scoro/scoro_convert.py companies_export.csv out/
# → out/gcore_customers_import.csv, gcore_suppliers_import.csv, gcore_industry_review.csv
#   Add --show to list the industry guesses worth checking.
```

Load the two customer and supplier CSVs through G-CORE's own import on the
Customers and Suppliers screens, after checking `gcore_industry_review.csv`.
The converter writes each company's `SCORO id <n>` into its Notes, so a record
can still be traced back to SCORO's own id.
