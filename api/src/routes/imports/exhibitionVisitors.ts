import { prisma } from '../../prisma';
import { badRequest } from '../../http/kit';
import type { ImportSpec, ImportActor } from '../../shared/csv';
import { brandKey, exhibitionDays, matchBrand, parseBadgeWith, splitProducts } from '../../shared/marketing';
import { recordVisitor } from '../marketing';
import type { Registered } from '../imports';

/**
 * Exhibition visitors from a spreadsheet (2026-10-27, the owner: "I will
 * input also the data of Day 1" — kept on a spreadsheet). The file is read as
 * people write one, not as a template demands: every heading is matched by
 * name, case- and punctuation-blind, through the words below, and none is
 * required but a name (a badge's QR text in a "QR" column will do).
 *
 * Brands come three ways, any mix: a Brands column ("Schneider, Nidec" — a
 * short form is enough when it names one brand), a Products column
 * ("Schneider Electric: UPS; Nidec Drives: F600", or plain products when one
 * brand is named), or a column per brand whose cell is ticked (✓, x, yes, 1)
 * or holds the products. A brand not on the list stops the file naming it
 * — add it on Admin › Categories or correct the cell.
 *
 * The rows go to the latest active exhibition, on the Day the row says, else
 * Day 1. Rows of the same person (the same email, else name and company) are
 * one visitor; a person already on file is ADDED to, as a second scan is.
 */

const ALIASES: Record<string, string[]> = {
  day: ['day', 'eventday', 'dayno', 'date'],
  name: ['name', 'fullname', 'visitor', 'visitorname', 'contactname', 'contactperson', 'attendee', 'firstnamelastname'],
  firstName: ['firstname', 'givenname'],
  lastName: ['lastname', 'surname', 'familyname'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'employer', 'firm'],
  position: ['position', 'designation', 'title', 'jobtitle', 'role'],
  email: ['email', 'emailaddress', 'mail'],
  mobile: ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'contactno', 'contactnumber', 'cellphone', 'cellno', 'tel', 'telephone'],
  brands: ['brand', 'brands', 'brandofinterest', 'brandsofinterest', 'interest', 'interests', 'inquiry', 'inquiringbrand'],
  products: ['product', 'products', 'productofinterest', 'productinquiry', 'productsinquired'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment'],
  qr: ['qr', 'qrcode', 'qrtext', 'vcard', 'badge'],
};

const headKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(row: Record<string, string>, field: keyof typeof ALIASES): string {
  for (const [h, v] of Object.entries(row)) if (ALIASES[field].includes(headKey(h)) && v.trim()) return v.trim();
  return '';
}

const TICK = /^(✓|✔|x|yes|y|1|true|ok|\/)$/i;

interface Brand {
  id: string;
  name: string;
}

type Context = { at: number; brands: Brand[]; exhibition: { id: string; name: string; startDate: Date; endDate: Date; qrFormat: string; qrSeparator: string | null; qrFields: string[] } | null };
const caches = new Map<string, Context>();
const EXHIBITION_SELECT = { id: true, name: true, startDate: true, endDate: true, qrFormat: true, qrSeparator: true, qrFields: true } as const;

/** The exhibition the rows go to — the one the screen names (`?exhibitionId=`), else the latest running one — and the brands. Read once a run. */
async function contextOf(exhibitionId: string): Promise<Context> {
  const cached = caches.get(exhibitionId);
  if (cached && Date.now() - cached.at < 10_000) return cached;
  const [brands, exhibition] = await Promise.all([
    prisma.exhibitionBrand.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    exhibitionId
      ? prisma.exhibition.findUnique({ where: { id: exhibitionId }, select: EXHIBITION_SELECT })
      : prisma.exhibition.findFirst({ where: { isActive: true }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }], select: EXHIBITION_SELECT }),
  ]);
  const made = { at: Date.now(), brands, exhibition };
  caches.set(exhibitionId, made);
  return made;
}

export interface VisitorRecord {
  day: number;
  name: string;
  company: string | null;
  position: string | null;
  email: string | null;
  mobile: string | null;
  notes: string | null;
  qrText: string | null;
  interests: { brandId: string; brand: string; products: string }[];
}

function brandsFromRow(row: Record<string, string>, brands: Brand[], rowNumber: number) {
  const out = new Map<string, { brand: Brand; products: string[] }>();
  const add = (b: Brand, products: string[] = []) => {
    const e = out.get(b.id) ?? { brand: b, products: [] };
    for (const p of products) if (!e.products.some((x) => x.toLowerCase() === p.toLowerCase())) e.products.push(p);
    out.set(b.id, e);
  };
  // A column per brand.
  for (const [h, v] of Object.entries(row)) {
    const b = brands.find((x) => brandKey(x.name) === headKey(h));
    if (!b || !v.trim()) continue;
    if (/^(no|n|0|false|-)$/i.test(v.trim())) continue;
    add(b, TICK.test(v.trim()) ? [] : splitProducts(v));
  }
  // A Brands column.
  const named = pick(row, 'brands');
  const inBrandsColumn: Brand[] = [];
  for (const word of named.split(/[,;/|\n]+|\s+&\s+|\band\b/i).map((w) => w.trim()).filter(Boolean)) {
    const b = matchBrand(word, brands);
    if (!b) throw badRequest(`Row ${rowNumber}: "${word}" is not a brand on the list — use one of ${brands.map((x) => x.name).join(', ')}, or add it on Admin › Categories`);
    add(b);
    if (!inBrandsColumn.includes(b)) inBrandsColumn.push(b);
  }
  // A Products column: "Brand: product, product; Brand: product", or plain products under the one brand named.
  const products = pick(row, 'products');
  const loose: string[] = [];
  for (const part of products.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const at = part.search(/[:–—]| - /);
    const b = at > 0 ? matchBrand(part.slice(0, at), brands) : null;
    if (b) add(b, splitProducts(part.slice(at).replace(/^(\s*-\s*|[:–—]\s*)/, '')));
    else loose.push(...splitProducts(part));
  }
  if (loose.length) {
    // Plain products belong to the one brand the Brands column names, else to the one brand ticked anywhere.
    if (inBrandsColumn.length === 1) add(inBrandsColumn[0], loose);
    else if (out.size === 1) add([...out.values()][0].brand, loose);
    else if (out.size === 0) {
      // A product that names its brand inside it ("Schneider UPS").
      for (const p of loose) {
        const b = matchBrand(p.split(/\s+/)[0], brands);
        if (!b) throw badRequest(`Row ${rowNumber}: which brand is "${p}" under? Write it "Brand: product", or fill the Brands column`);
        add(b, [p]);
      }
    } else throw badRequest(`Row ${rowNumber}: several brands are named — write the products as "Brand: product; Brand: product"`);
  }
  return [...out.values()];
}

async function buildOne(exhibitionId: string, rows: Record<string, string>[], rowNumber: number): Promise<VisitorRecord> {
  const { brands, exhibition } = await contextOf(exhibitionId);
  if (!exhibition) throw badRequest('No exhibition is on file — add one on Sales › Marketing first');
  const first = rows[0];
  const qrText = pick(first, 'qr') || null;
  const badge = qrText ? parseBadgeWith(qrText, exhibition) : null;
  const name = pick(first, 'name') || [pick(first, 'firstName'), pick(first, 'lastName')].filter(Boolean).join(' ') || badge?.name || '';
  if (name.length < 2) throw badRequest(`Row ${rowNumber}: no name — a Name column (or First name / Last name, or the badge's QR text) is needed`);
  const dayText = pick(first, 'day');
  let day = 1;
  if (dayText) {
    const n = /^\d{4}-\d{2}-\d{2}/.test(dayText)
      ? Math.round((new Date(`${dayText.slice(0, 10)}T00:00:00Z`).getTime() - exhibition.startDate.getTime()) / 86_400_000) + 1
      : Number(dayText.replace(/[^0-9]/g, ''));
    if (!Number.isInteger(n) || n < 1 || n > exhibitionDays(exhibition)) throw badRequest(`Row ${rowNumber}: "${dayText}" is not a day of ${exhibition.name} (Day 1 – Day ${exhibitionDays(exhibition)})`);
    day = n;
  }
  const interests = new Map<string, { brandId: string; brand: string; products: string[] }>();
  for (const [i, r] of rows.entries()) {
    for (const b of brandsFromRow(r, brands, rowNumber + i)) {
      const e = interests.get(b.brand.id) ?? { brandId: b.brand.id, brand: b.brand.name, products: [] };
      for (const p of b.products) if (!e.products.some((x) => x.toLowerCase() === p.toLowerCase())) e.products.push(p);
      interests.set(b.brand.id, e);
    }
  }
  const notes = [...new Set(rows.map((r) => pick(r, 'notes')).filter(Boolean))].join('\n') || null;
  return {
    day,
    name,
    company: pick(first, 'company') || badge?.company || null,
    position: pick(first, 'position') || badge?.position || null,
    email: (pick(first, 'email') || badge?.email || '').toLowerCase() || null,
    mobile: pick(first, 'mobile') || badge?.mobile || null,
    notes,
    qrText,
    interests: [...interests.values()].map((i) => ({ brandId: i.brandId, brand: i.brand, products: i.products.join(', ') })),
  };
}

const groupKeyOf = (row: Record<string, string>) => {
  const email = pick(row, 'email').toLowerCase();
  if (email) return email;
  const name = pick(row, 'name') || [pick(row, 'firstName'), pick(row, 'lastName')].filter(Boolean).join(' ');
  return `${name}|${pick(row, 'company')}`.toLowerCase().replace(/\s+/g, ' ');
};

/** The import into one exhibition (`''` is the latest running one). */
export function exhibitionVisitorsSpecFor(exhibitionId: string): ImportSpec<VisitorRecord> {
  return {
    entity: 'exhibition_visitors',
    label: 'Exhibition visitors',
    columns: [
      { header: 'Day', example: '1', hint: '1, Day 1 or the date — blank is Day 1' },
      { header: 'Name', example: 'Juan dela Cruz', hint: 'Or First name and Last name' },
      { header: 'Company', example: 'ABC Semiconductor Inc.' },
      { header: 'Position', example: 'Facilities Engineer' },
      { header: 'Email', example: 'juan@abc.com', hint: 'The same email on two rows is one visitor' },
      { header: 'Mobile', example: '+639171234567' },
      { header: 'Brands', example: 'Schneider Electric, Nidec Drives', hint: 'Short forms work: Schneider, Nidec, Omega, Suto' },
      { header: 'Products', example: 'Schneider Electric: UPS; Nidec Drives: F600', hint: 'Brand: product; or plain products when one brand is named' },
      { header: 'Notes', example: 'Wants a quotation next week' },
    ],
    groupBy: groupKeyOf,
    build: (row, n) => buildOne(exhibitionId, [row], n),
    buildGroup: (rows, n) => buildOne(exhibitionId, rows, n),
    existing: async (row) => {
      const { exhibition } = await contextOf(exhibitionId);
      if (!exhibition) return null;
      const email = pick(row, 'email').toLowerCase();
      const name = pick(row, 'name') || [pick(row, 'firstName'), pick(row, 'lastName')].filter(Boolean).join(' ');
      const hit = email
        ? await prisma.exhibitionVisitor.findFirst({ where: { exhibitionId: exhibition.id, email: { equals: email, mode: 'insensitive' } }, select: { id: true } })
        : name
          ? await prisma.exhibitionVisitor.findFirst({ where: { exhibitionId: exhibition.id, email: null, name: { equals: name.trim(), mode: 'insensitive' }, company: pick(row, 'company') ? { equals: pick(row, 'company'), mode: 'insensitive' } : null }, select: { id: true } })
          : null;
      return hit?.id ?? null;
    },
    describe: (r) => `Day ${r.day}${r.interests.length ? ` · ${r.interests.map((i) => (i.products ? `${i.brand} — ${i.products}` : i.brand)).join('; ')}` : ' · no brand'}`,
    summarize: async () => {
      const { exhibition } = await contextOf(exhibitionId);
      return exhibition ? { facts: [{ label: 'Exhibition', value: exhibition.name }] } : undefined;
    },
  };
}

export const exhibitionVisitorsSpec = exhibitionVisitorsSpecFor('');

export async function exhibitionVisitorsWrite(records: { record: VisitorRecord; existingId: string | null }[], actor?: ImportActor, exhibitionId = ''): Promise<void> {
  if (!actor) throw badRequest('Who is importing?');
  caches.delete(exhibitionId);
  const { exhibition } = await contextOf(exhibitionId);
  if (!exhibition) throw badRequest('No exhibition is on file');
  for (const { record } of records) {
    await prisma.$transaction((tx) =>
      recordVisitor(tx, actor, exhibition, {
        day: record.day,
        name: record.name,
        company: record.company,
        position: record.position,
        email: record.email,
        mobile: record.mobile,
        notes: record.notes,
        qrText: record.qrText,
        interests: record.interests.map((i) => ({ brandId: i.brandId, products: i.products })),
        source: 'IMPORT',
      }),
    );
  }
}

function importInto(exhibitionId: string): Registered {
  return {
    spec: exhibitionVisitorsSpecFor(exhibitionId) as ImportSpec<never>,
    permission: 'gops.marketing.create',
    write: ((records: { record: VisitorRecord; existingId: string | null }[], actor?: ImportActor) => exhibitionVisitorsWrite(records, actor, exhibitionId)) as unknown as Registered['write'],
  };
}

export const exhibitionVisitorsImport: Registered = { ...importInto(''), forContext: (ctx) => importInto(ctx.exhibitionId ?? '') };
