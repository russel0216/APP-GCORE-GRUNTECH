"""Convert the SCORO company export into G-CORE's Customers and Suppliers
import files, plus a review sheet of every industry decision."""
import csv, io, re, sys
from collections import Counter

import datetime, os

# Usage: python scoro_convert.py <companies_export.csv> <out-dir> [--show]
args = [a for a in sys.argv[1:] if not a.startswith('--')]
if len(args) < 2:
    sys.exit('Usage: python scoro_convert.py <companies_export.csv> <out-dir> [--show]')
SRC, OUT = args[0], args[1]
os.makedirs(OUT, exist_ok=True)
TODAY = datetime.date.today().isoformat()

rows = list(csv.DictReader(io.open(SRC, encoding='utf-16'), delimiter='\t'))


def repair(v):
    """SCORO's export replaced some characters with U+FFFD. Between two capitals
    it was an Ñ (SACAPAÑO), before an s an apostrophe (Zed's), spaced a dash."""
    if not v or '\ufffd' not in v:
        return v
    v = re.sub(r'(?<=[A-Z])\ufffd(?=[A-Z])', 'Ñ', v)
    v = re.sub(r'(?<=[a-z])\ufffd(?=[a-z])', 'ñ', v)
    v = re.sub(r'(?<=\w)\ufffd(?=s\b)', "'", v)
    v = re.sub(r'\s\ufffd\s', ' – ', v)
    return v.replace('\ufffd', '')


for r in rows:
    for k in r:
        r[k] = repair(r[k])

g = lambda r, k: (r.get(k) or '').strip()

# Same company under two spellings in SCORO → the spelling kept.
ALIAS = {
    'CORDILLERA HOSPITAL OF THE DIVINE GRACE (CHDG)': 'CORDILLERA HOSPITAL OF THE DIVINE GRACE',
    'NUTRIBAKED FOOD PRODUCTS': 'NUTRIBAKED FOOD PRODUCTS, INC.',
}

# ── merge duplicates: keep the row with a TIN, fill blanks from the other ────
by_name = {}
for r in rows:
    key = re.sub(r'\s+', ' ', g(r, 'company_name')).upper()
    key = ALIAS.get(key, key)
    if key not in by_name:
        by_name[key] = dict(r, _ids=[g(r, 'company_scoro_id')])
        continue
    cur = by_name[key]
    primary, other = (r, cur) if g(r, 'company_vat_no') and not g(cur, 'company_vat_no') else (cur, r)
    merged = {k: v for k, v in primary.items() if not k.startswith('_')}
    for k, v in other.items():
        if not k.startswith('_') and not (merged.get(k) or '').strip() and (v or '').strip():
            merged[k] = v
    for flag in ('company_is_client', 'is_supplier'):
        merged[flag] = '1' if '1' in (g(r, flag), g(cur, flag)) else '0'
    merged['_ids'] = cur['_ids'] + [g(r, 'company_scoro_id')]
    by_name[key] = merged
for key, c in by_name.items():
    if key in ALIAS.values():
        c['company_name'] = key
companies = list(by_name.values())

# ── industry ─────────────────────────────────────────────────────────────────
TAG = {
    'Healthcare': 'HI', 'Pharmaceutical': 'HI',
    'Commercial Building and Land Development': 'BI',
    'Building Materials ( Stone, Clay, Glass, Cement )': 'BI', 'Furniture and Fixture': 'BI',
    'Water Utilities': 'UI', 'Power Utilities': 'UI',
    'Government': 'SI',
}
GOV = re.compile(r'\b(CITY GOVERNMENT|MUNICIPAL|MUNICIPALITY|PROVINCIAL|PROVINCE OF|GOVERNMENT|DEPARTMENT OF|DEPT\.? OF|BUREAU|'
                 r'WATER DISTRICT|REGIONAL HOSPITAL|DISTRICT HOSPITAL|PROVINCIAL HOSPITAL|BENGUET GENERAL HOSPITAL|'
                 r'PHILHEALTH|DOH|DPWH|DEPED|AFP|PNP|ARMED FORCES|NATIONAL|STATE UNIVERSITY|AUTHORITY|COMMISSION|'
                 r'BARANGAY|LGU|CITY OF|OFFICE OF|COUNCIL|ADMINISTRATION)\b')
SPECIAL = re.compile(r'\b(GRUNTECH|GRUNTECHNOLOGY|GAS ION|WORLD WIDE FUND|WWF)\b')
CONTRACTOR = re.compile(r'\b(CONSTRUCTION|CONTRACTORS?|BUILDERS|CONSTRUCTORS?|EPC|INFRASTRUCTURE|BALFOUR|WABAG|PROJECT MANAGEMENT)\b')
HEALTH = re.compile(r'\b(NEPHROPLUS|MEDICOP|MEDECINS|HOSPITAL|MEDICAL|MEDICINE|CLINIC|HEALTH|HEALTHCARE|DIALYSIS|DIAGNOSTIC|'
                    r'LABORATORY|LABORATORIES|PHARMA|PHARMACEUTICAL|DOCTORS?|INFIRMARY|SANITARIUM)\b')
UTIL = re.compile(r'\b(WATER|AGUA|ACEN|TRIENERGY|COREGEN|POWER CORP|POWER PLANT|ELECTRIC COOPERATIVE|ENERGY|UTILITIES|UTILITY|HYDRO|RENEWABLE)\b')
BUILD = re.compile(r'\b(REALTY|LAND|LANDS|PROPERTIES|PROPERTY|DEVELOPERS?|ESTATES?|MALL|CONDOMINIUM|HOMES)\b')


def classify(c):
    """Returns (code, reason, needs_checking). Government outranks everything,
    including a Healthcare tag: a government hospital is SI by the owner's rule."""
    name = g(c, 'company_name').upper()
    tags = [t.strip() for t in g(c, 'company_tags').split('|') if t.strip()]
    if 'Government' in tags:
        return 'SI', 'government (SCORO tag)', False
    if GOV.search(name):
        return 'SI', 'government (name)', True
    if SPECIAL.search(name):
        return 'SI', 'special account (own/sister company or NGO)', True
    if CONTRACTOR.search(name) or 'contractor' in g(c, 'company_comment').lower():
        return 'SI', 'contractor (name or SCORO comment)', True
    for t in tags:
        if t in TAG:
            return TAG[t], f'SCORO tag: {t}', False
    if tags:
        return 'GI', f'SCORO tag: {" | ".join(tags)}', False
    if HEALTH.search(name):
        return 'HI', 'from name (health)', True
    if UTIL.search(name):
        return 'UI', 'from name (utility)', True
    if BUILD.search(name):
        return 'BI', 'from name (property/building)', True
    return 'GI', 'no SCORO tag, nothing in the name: default', True


def addr(c):
    parts = [g(c, 'street'), g(c, 'municipality').rstrip(','), g(c, 'county'), g(c, 'zipcode')]
    country = g(c, 'country').split('|')[0].upper()
    if country and country != 'PHL':
        parts.append(country)
    seen, out = set(), []
    for p in parts:
        p = re.sub(r'\s+', ' ', p).strip(' ,')
        if p and p.lower() not in seen:
            seen.add(p.lower())
            out.append(p)
    return ', '.join(out)


def notes(c, industry_note=''):
    lines = [f'Imported from SCORO on {TODAY} (SCORO id {", ".join(c["_ids"])}). '
             'History before this date is in SCORO; nothing here links to it.']
    if len(c['_ids']) > 1:
        lines.append('Merged from two SCORO records for the same company.')
    for label, key in [('SCORO client profile', 'company_client_profile'), ('SCORO company manager', 'company_manager'),
                       ('Bank account', 'company_bank_account'), ('Fax', 'fax')]:
        if g(c, key):
            lines.append(f'{label}: {g(c, key)}')
    if g(c, 'company_tags'):
        lines.append('SCORO tags: ' + g(c, 'company_tags').replace('|', ', '))
    if g(c, 'related_users'):
        lines.append('SCORO account team: ' + g(c, 'related_users').replace(',', ', '))
    if g(c, 'company_comment'):
        lines.append('SCORO comment: ' + re.sub(r'\s*\n\s*', ' / ', g(c, 'company_comment')))
    if industry_note:
        lines.append(industry_note)
    return '\n'.join(lines)


cust_h = ['Name', 'Code', 'Legal Name', 'TIN', 'Industry', 'Payment Terms', 'Credit Limit', 'Phone', 'Email', 'Website', 'Active',
          'Contact Name', 'Contact Position', 'Contact Email', 'Contact Mobile', 'Site Name', 'Site Address', 'Site City', 'Notes']
supp_h = ['Name', 'Code', 'Legal Name', 'TIN', 'Category', 'Payment Terms', 'Address', 'City', 'Phone', 'Email', 'Website', 'Active',
          'Contact Name', 'Contact Position', 'Contact Email', 'Contact Mobile', 'Notes']
cust, supp, review = [], [], []
for c in sorted(companies, key=lambda c: g(c, 'company_name').upper()):
    is_supp = g(c, 'is_supplier') == '1'
    is_client = g(c, 'company_is_client') == '1' or not is_supp   # the one "neither" row is a hospital → customer
    name = re.sub(r'\s+', ' ', g(c, 'company_name'))
    tin = g(c, 'company_vat_no') or g(c, 'company_id_code')
    phone = g(c, 'phone') or g(c, 'mobile')
    if is_client:
        code, why, check = classify(c)
        site = addr(c)
        cust.append({
            'Name': name, 'TIN': tin, 'Industry': code, 'Phone': phone, 'Email': g(c, 'email'),
            'Website': g(c, 'website'), 'Active': 'Yes', 'Contact Name': g(c, 'related_person_name'),
            'Site Name': 'Main' if (site or g(c, 'city')) else '', 'Site Address': site, 'Site City': g(c, 'city'),
            'Notes': notes(c, 'Industry set from the company name, not a SCORO tag. Check and correct if wrong.' if check else ''),
        })
        review.append({'Company': name, 'Industry': code, 'Why': why, 'Check this': 'YES' if check else '',
                       'SCORO id': ', '.join(c['_ids'])})
    if is_supp:
        supp.append({
            'Name': name, 'TIN': tin, 'Category': g(c, 'company_tags').replace('|', ', '),
            'Address': addr(c), 'City': g(c, 'city'), 'Phone': phone, 'Email': g(c, 'email'), 'Website': g(c, 'website'),
            'Active': 'Yes', 'Contact Name': g(c, 'related_person_name'), 'Notes': notes(c),
        })


def write(path, header, data):
    # UTF-8 with BOM so Excel opens it correctly; G-CORE's parser strips the BOM.
    with io.open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        for d in data:
            w.writerow({k: d.get(k, '') for k in header})


write(os.path.join(OUT, 'gcore_customers_import.csv'), cust_h, cust)
write(os.path.join(OUT, 'gcore_suppliers_import.csv'), supp_h, supp)
write(os.path.join(OUT, 'gcore_industry_review.csv'), ['Company', 'Industry', 'Why', 'Check this', 'SCORO id'], review)

print('companies after merge', len(companies), '| customers', len(cust), '| suppliers', len(supp))
print('industry', dict(Counter(r['Industry'] for r in review)))
print('to check', sum(1 for r in review if r['Check this']))
if '--show' in sys.argv:
    for r in review:
        if r['Check this'] and 'default' not in r['Why']:
            print(f"  {r['Industry']}  {r['Why']:45} {r['Company']}")
