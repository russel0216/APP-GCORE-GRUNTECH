import { prisma } from '../prisma';
import { dayKey, daysBetween } from './day';

/**
 * Marketing at an exhibition (2026-10-27, the owner's call during PSECE 2026:
 * "a QR scanner to save the info of the visitor; I will choose the brand
 * they are inquiring — several; every account user can scan and input the
 * specific product under the brand"). The rules every screen and the import
 * share live here; `routes/marketing.ts` only fetches and writes.
 */

/** The owner's nine, in his order — seeded once as system rows (Admin › Categories › Exhibition brands). */
export const EXHIBITION_BRANDS = [
  'Schneider Electric',
  'Horiba',
  'Nidec Drives',
  'Pentair',
  'KSB',
  'Suto-itec',
  'Omega Air',
  'Sure Purity',
  'Prevost',
] as const;

/** The exhibition running when the module was built: Day 2 was 2026-10-27, so Day 1 was the 26th. */
export const FIRST_EXHIBITION = { name: 'PSECE 2026', venue: 'Philippine Semiconductor & Electronics Convention & Exhibition', startDate: '2026-10-26', endDate: '2026-10-28' };

// ── The badge ───────────────────────────────────────────────────────────────

export interface Badge {
  name: string | null;
  company: string | null;
  position: string | null;
  email: string | null;
  mobile: string | null;
}

/**
 * Reads a badge's QR. PSECE's is a vCard 3.0 (FN, N, ORG, TITLE, EMAIL,
 * TEL;CELL — read off the owner's own badge); a MECARD, and a plain text with
 * an email or a number in it, are read as far as they go. Pure: the web keeps
 * a copy (`web/src/lib/badge.ts`) so the form fills before anything is sent,
 * and verify-sales pins the two equal.
 */
export function parseBadge(raw: string): Badge {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const out: Badge = { name: null, company: null, position: null, email: null, mobile: null };
  if (!text) return out;
  if (/^BEGIN:VCARD/i.test(text)) {
    // Folded lines (a line starting with a space continues the one before).
    const lines = text.replace(/\n[ \t]/g, '').split('\n');
    let n: string | null = null;
    for (const line of lines) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const head = line.slice(0, at).toUpperCase();
      const value = unescapeV(line.slice(at + 1)).trim();
      if (!value) continue;
      const prop = head.split(';')[0].replace(/^ITEM\d+\./, '');
      if (prop === 'FN') out.name ??= value;
      else if (prop === 'N') n ??= value;
      else if (prop === 'ORG') out.company ??= value.split(';').filter(Boolean).join(', ');
      else if (prop === 'TITLE' || prop === 'ROLE') out.position ??= value;
      else if (prop === 'EMAIL') out.email ??= value;
      else if (prop === 'TEL') {
        // A cell number first, else the first number given.
        if (/CELL|MOBILE/.test(head)) out.mobile = value;
        else out.mobile ??= value;
      }
    }
    if (!out.name && n) {
      const [last, first, middle] = n.split(';');
      out.name = [first, middle, last].map((p) => p?.trim()).filter(Boolean).join(' ') || null;
    }
    return out;
  }
  if (/^MECARD:/i.test(text)) {
    for (const part of text.slice(7).split(/(?<!\\);/)) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const key = part.slice(0, at).toUpperCase();
      const value = part.slice(at + 1).replace(/\\(.)/g, '$1').trim();
      if (!value) continue;
      if (key === 'N') out.name ??= value.includes(',') ? value.split(',').reverse().map((s) => s.trim()).join(' ') : value;
      else if (key === 'ORG') out.company ??= value;
      else if (key === 'TITLE') out.position ??= value;
      else if (key === 'EMAIL') out.email ??= value;
      else if (key === 'TEL') out.mobile ??= value;
    }
    return out;
  }
  // Plain text: an email and a number where there are any; nothing else is guessed.
  out.email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  out.mobile = text.match(/\+?\d[\d\s-]{8,}\d/)?.[0]?.replace(/\s+/g, ' ') ?? null;
  return out;
}

/** What a part of a DELIMITED badge can be. `skip` passes over a part (a badge number, a category). */
export const QR_FIELDS = ['name', 'firstName', 'lastName', 'company', 'position', 'email', 'mobile', 'skip'] as const;
export type QrField = (typeof QR_FIELDS)[number];

/** The separators offered; TAB and NEWLINE are named, the rest are the character itself. */
export const QR_SEPARATORS = ['|', ',', ';', 'TAB', 'NEWLINE', '^', '~'] as const;

export interface BadgeFormat {
  qrFormat: string;
  qrSeparator: string | null;
  qrFields: string[];
}

const sepOf = (s: string | null) => (s === 'TAB' ? '\t' : s === 'NEWLINE' ? '\n' : s || '|');

/**
 * Reads a badge the way ITS exhibition writes them (2026-10-27, "not only
 * this exhibit — modify based on the QR"). AUTO is `parseBadge` (a vCard, a
 * MECARD, plain text). DELIMITED splits the text on the exhibition's
 * separator and names each part in the exhibition's order; first and last
 * names join into the name. A vCard scanned at a DELIMITED exhibition is
 * still read as a vCard — a badge is read as what it is when it says so.
 */
export function parseBadgeWith(raw: string, format?: BadgeFormat | null): Badge {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!format || format.qrFormat !== 'DELIMITED' || /^(BEGIN:VCARD|MECARD:)/i.test(text)) return parseBadge(raw);
  const out: Badge = { name: null, company: null, position: null, email: null, mobile: null };
  const parts = text.split(sepOf(format.qrSeparator)).map((p) => p.trim());
  let first = '';
  let last = '';
  format.qrFields.forEach((field, i) => {
    const value = parts[i];
    if (!value) return;
    if (field === 'firstName') first = value;
    else if (field === 'lastName') last = value;
    else if (field === 'name' || field === 'company' || field === 'position' || field === 'email' || field === 'mobile') out[field] ??= value;
  });
  if (!out.name && (first || last)) out.name = [first, last].filter(Boolean).join(' ');
  return out;
}

function unescapeV(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

// ── Brands ──────────────────────────────────────────────────────────────────

/** A brand compared without case, spaces or punctuation: "Suto itec" is "Suto-itec". */
export const brandKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which listed brand a typed word means: the same letters, else the one
 * brand it starts (three letters at least — "Schneider", "Nidec", "Omega"),
 * else the one brand that starts it ("Schneider Electric UPS"). Two brands
 * matching, or none, is null — never a guess between two.
 */
export function matchBrand<T extends { name: string }>(typed: string, brands: T[]): T | null {
  const k = brandKey(typed);
  if (!k) return null;
  const exact = brands.find((b) => brandKey(b.name) === k);
  if (exact) return exact;
  const prefixed = k.length >= 3 ? brands.filter((b) => brandKey(b.name).startsWith(k)) : [];
  if (prefixed.length === 1) return prefixed[0];
  const within = brands.filter((b) => k.startsWith(brandKey(b.name)));
  return within.length === 1 ? within[0] : null;
}

/** "UPS, PLC" → ["UPS", "PLC"]: products typed under a brand, each once, case-blind. */
export function splitProducts(text: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of String(text ?? '').split(/[,;\n]/)) {
    const t = p.trim().replace(/\s+/g, ' ');
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

// ── Days ────────────────────────────────────────────────────────────────────

/** How many days the exhibition runs (Day 1 … Day n). */
export const exhibitionDays = (e: { startDate: Date; endDate: Date }): number => Math.max(1, daysBetween(e.startDate, e.endDate) + 1);

/** Today's day of the exhibition on Manila's calendar, held to Day 1 … Day n. */
export function todaysDay(e: { startDate: Date; endDate: Date }, now = new Date()): number {
  const n = daysBetween(e.startDate, dayKey(now)) + 1;
  return Math.min(Math.max(n, 1), exhibitionDays(e));
}

/** The calendar date of Day n. */
export function dateOfDay(e: { startDate: Date }, day: number): Date {
  return new Date(e.startDate.getTime() + (day - 1) * 86_400_000);
}

// ── The seed ────────────────────────────────────────────────────────────────

const ACCESS_MARK = 'seed.marketingAccess20261027';
/** What every role is given once — scan, read every visitor, change any (the owner: "make it editable"). */
export const MARKETING_COMMON = ['gops.marketing.view_all', 'gops.marketing.create', 'gops.marketing.edit_all'];

/**
 * The brands, the first exhibition and everybody's access — each once. The
 * brands are added when missing (an administrator's spelling stays); the
 * exhibition only when none is on file; the access ONCE
 * (`seed.marketingAccess20261027`): every role then on file gets
 * `MARKETING_COMMON` ("every account user can scan"), and from then on the
 * boxes are the owner's on Admin › Roles. Delete is not given: a visitor is
 * removed by whoever holds it there, or a super admin.
 */
export async function seedMarketing(): Promise<{ brands: number; exhibition: boolean; granted: number | null }> {
  let brands = 0;
  for (const [i, name] of EXHIBITION_BRANDS.entries()) {
    const all = await prisma.exhibitionBrand.findMany({ select: { id: true, name: true, isSystem: true } });
    const existing = all.find((b) => brandKey(b.name) === brandKey(name));
    if (existing) {
      if (!existing.isSystem) await prisma.exhibitionBrand.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    await prisma.exhibitionBrand.create({ data: { name, sortOrder: i, isSystem: true } });
    brands++;
  }
  let exhibition = false;
  if (!(await prisma.exhibition.count())) {
    await prisma.exhibition.create({
      data: {
        name: FIRST_EXHIBITION.name,
        venue: FIRST_EXHIBITION.venue,
        startDate: new Date(`${FIRST_EXHIBITION.startDate}T00:00:00Z`),
        endDate: new Date(`${FIRST_EXHIBITION.endDate}T00:00:00Z`),
      },
    });
    exhibition = true;
  }
  let granted: number | null = null;
  if (!(await prisma.setting.findUnique({ where: { key: ACCESS_MARK } }))) {
    const perms = await prisma.permission.findMany({ where: { key: { in: MARKETING_COMMON } }, select: { id: true } });
    const roles = await prisma.role.findMany({ select: { id: true } });
    granted = 0;
    if (perms.length && roles.length) {
      const made = await prisma.rolePermission.createMany({
        data: roles.flatMap((r) => perms.map((p) => ({ roleId: r.id, permissionId: p.id }))),
        skipDuplicates: true,
      });
      granted = made.count;
    }
    await prisma.setting.upsert({
      where: { key: ACCESS_MARK },
      create: { key: ACCESS_MARK, value: { at: new Date().toISOString(), granted }, description: 'Marketing (exhibition visitors) given once to every role on file.' },
      update: {},
    });
  }
  return { brands, exhibition, granted };
}
