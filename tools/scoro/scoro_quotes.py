"""Turn a SCORO quotes export (CSV + the combined Quotes PDF) into a bundle
G-CORE's archive importer reads:

  <out>/quotes.json      one object per quote: CSV header fields + parsed lines
  <out>/pdf/<number>.pdf the quote's own pages, cut from the combined PDF(s)

SCORO prints a large selection as several PDFs, so any number may be given; a
quote found in none of them is still archived, with pdf null and no lines.

Line items exist only in the PDF, so they are read from its text and every
quote's parsed lines are checked against the CSV total. A quote whose lines do
not reconcile is still archived (the PDF is the record); it is just marked
`linesReconcile: false`, and 'Continue in G-CORE' tells the salesperson to
check the lines.

Usage: python scoro_quotes.py <export.csv> <Quotes.pdf> [<more.pdf> ...] <out-dir>
"""
import csv, io, json, os, re, sys
from decimal import Decimal, InvalidOperation

import fitz  # PyMuPDF — used here on the workstation only, never on the server

CSV_PATH, PDF_PATHS, OUT = sys.argv[1], sys.argv[2:-1], sys.argv[-1]
if not PDF_PATHS:
    sys.exit(__doc__)
os.makedirs(os.path.join(OUT, 'pdf'), exist_ok=True)

rows = list(csv.DictReader(io.open(CSV_PATH, encoding='utf-16'), delimiter='\t'))
by_no = {r['doc_no'].strip(): r for r in rows}

# (number, document, first page, last page) for every quote in every PDF
spans = []
for path in PDF_PATHS:
    d = fitz.open(path)
    starts = []
    for i in range(d.page_count):
        t = d[i].get_text()
        m = re.search(r'Quote No\.\s*([0-9][0-9.]*)', t)
        if m and 'GRUNTECHNOLOGY CORPORATION' in t[:300]:
            starts.append((i, m.group(1).strip()))
    spans += [(n, d, s, (starts[k + 1][0] if k + 1 < len(starts) else d.page_count) - 1) for k, (s, n) in enumerate(starts)]
found = {}
for n, d, s, e in spans:
    found.setdefault(n, (d, s, e))   # the first copy wins if two PDFs repeat a quote

# PDF text can carry control characters (SCORO's PDFs leave NULs in some
# descriptions); PostgreSQL refuses a NUL, so every string is cleaned before it
# is written. Line breaks and tabs stay.
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def clean(o):
    if isinstance(o, str):
        return CONTROL.sub('', o)
    if isinstance(o, list):
        return [clean(v) for v in o]
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    return o


MONEY = re.compile(r'^-?[\d,]+\.\d{2}$')
# "2 set", "1 lot", "0.5 lot" — or a bare "1": some salespeople left the unit
# blank, and a line is still only a line item when two amounts follow it.
QTY = re.compile(r'^(-?[\d,]*\.?\d+)(?:\s+(\S.*))?$')
STOP = re.compile(r'^(Sub Total Price|Total Price|VAT|Discount|Delivery:|I trust that|Sincerely)', re.I)


def money(s):
    try:
        return Decimal(s.replace(',', ''))
    except InvalidOperation:
        return None


def body_lines(doc, first, last, number):
    """The table text of one quote, with page furniture removed."""
    out = []
    for p in range(first, last + 1):
        lines = [l.strip() for l in doc[p].get_text().split('\n')]
        # everything before the table header is letterhead / client block
        try:
            h = lines.index('PRODUCT DESCRIPTION')
            lines = lines[h + 4:]   # PRODUCT DESCRIPTION, QTY, UNIT PRICE, TOTAL
        except ValueError:
            pass
        for l in lines:
            if not l or l == number:
                continue   # blanks; a lone page number is left to parse_lines,
                           # because a unit-less quantity looks exactly like one
            if 'INDUSTRIAL UTILITY SOLUTIONS' in l or 'WWW.GRUNTECHNOLOGY.COM' in l:
                continue
            out.append(l)
    return out


def parse_lines(lines):
    items, block = [], []
    i = 0
    while i < len(lines):
        l = lines[i]
        if STOP.match(l):
            break
        q = QTY.match(l)
        # a line item ends with: "<qty> <unit>", "<unit price>", "<amount>"
        if q and i + 2 < len(lines) and MONEY.match(lines[i + 1]) and MONEY.match(lines[i + 2]):
            qty = money(q.group(1)) or Decimal(1)
            title = block[0] if block else ''
            desc = '\n'.join(block[1:]).strip()
            items.append({'title': title, 'description': desc, 'quantity': str(qty), 'unit': (q.group(2) or '').strip(),
                          'unitPrice': str(money(lines[i + 1])), 'amount': str(money(lines[i + 2]))})
            block = []
            i += 3
            continue
        if re.fullmatch(r'\d{1,2}', l):
            i += 1           # a page number: a lone number with no amounts after it
            continue
        block.append(l)
        i += 1
    return items


def iso(d):
    d = (d or '').strip()
    return None if not d or d.startswith('0000') else d


bundle, bad = [], []
unmatched = sorted(set(found) - set(by_no))
for number, r in by_no.items():
    src = found.get(number)
    items = []
    if src:
        doc, first, last = src
        part = fitz.open()
        part.insert_pdf(doc, from_page=first, to_page=last)
        part.save(os.path.join(OUT, 'pdf', f'{number}.pdf'), garbage=3, deflate=True)
        items = parse_lines(body_lines(doc, first, last, number))
    lines_total = sum((Decimal(it['amount']) for it in items), Decimal(0))
    sum_before_discount = Decimal(r['total_sum'])
    disc = Decimal(r['discount'] or '0')
    if disc:
        # SCORO's total_sum is after discount; the lines are before it
        sum_before_discount = (Decimal(r['total_sum']) / (1 - disc / 100)).quantize(Decimal('0.01'))
    ok = bool(items) and abs(lines_total - sum_before_discount) <= Decimal('1.00')
    if src and not ok:
        bad.append((number, str(lines_total), str(sum_before_discount), len(items)))

    bundle.append({
        'scoroId': r['id'], 'number': number, 'date': iso(r['doc_date']), 'dueDate': iso(r['doc_deadline']),
        'estimatedClosing': iso(r['estimated_closing_date']), 'confirmedAt': iso(r['confirmed_date']),
        'owner': r['owner_name'].strip(), 'customer': r['payer'].strip(), 'customerScoroId': r['payer_id'].strip(),
        'contact': r['contact_person'].strip(), 'name': r['quote_name'].strip(), 'project': r['project_name'].strip(),
        'status': r['status_name'].strip(), 'previousStatus': r['previous_status'].strip(),
        'statusChangedAt': iso(r['status_changed_date']), 'statusChangedBy': r['status_changed_by'].strip(),
        'currency': r['currency'].strip() or 'PHP', 'discountPct': r['discount'], 'subtotal': r['total_sum'],
        'vat': r['total_vat'], 'total': r['total_sum_vat'], 'cost': r['total_cost'],
        'prNumber': r['c_prnumber'].strip(), 'delivery': r['c_delivery'].strip(), 'paymentTerms': r['c_paymentterms'].strip(),
        'comment': r['doc_description'].strip(), 'invoiceNos': r['invoice_no'].strip(), 'isSent': r['is_sent'] == '1',
        'lines': items, 'linesReconcile': ok, 'pdf': f'pdf/{number}.pdf' if src else None,
    })

with io.open(os.path.join(OUT, 'quotes.json'), 'w', encoding='utf-8') as f:
    json.dump(clean({'source': 'SCORO', 'quotes': bundle}), f, ensure_ascii=False, indent=1)

with_pdf = sum(1 for q in bundle if q['pdf'])
print(f'quotes in CSV {len(rows)} | documents in PDFs {len(spans)} | bundled {len(bundle)} ({with_pdf} with a PDF)')
print(f'lines reconcile with the CSV total: {with_pdf - len(bad)} of {with_pdf}')
print('CSV quotes with no PDF:', sorted(set(by_no) - set(found))[:10])
print('PDF documents with no CSV row:', unmatched[:10])
for b in bad[:12]:
    print('  does not reconcile', b)
