import { prisma } from '../prisma';

/**
 * Telling one company from another by its NAME (2026-11-15, the owner's audit
 * of the customer list: "ABOITIZ LAND , INC." beside "ABOITIZ LAND, INC.",
 * "OLEO FATS, INC" beside "OLEO-FATS, INCORPORATED").
 *
 * `customerNameKey()` is what two spellings of one company share: capitals,
 * punctuation and spacing dropped, and the legal form (Inc., Corp., Co.,
 * Ltd. …) left out. It only SUGGESTS a duplicate — a person confirms every
 * merge — so it never drops a word that tells two companies apart (a place,
 * "Philippines", a branch).
 */
const LEGAL_FORMS = ['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'THE'];

export function customerNameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_FORMS.includes(w))
    .join(' ');
}

/**
 * Payment terms typed as a number of days read ONE way: "30", "30 days" and
 * "30 DAYS" are all "30 Days". Anything else ("C.O.D.", "20% downpayment …")
 * is kept as typed.
 */
export function tidyPaymentTerms(terms: string | null | undefined): string | null {
  const t = (terms ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const days = /^(\d{1,3})\s*(days?)?$/i.exec(t);
  return days ? `${Number(days[1])} Days` : t;
}

/** Every customer's payment terms brought to the one spelling — the seed, every deploy; idempotent. */
export async function tidyCustomerTerms(): Promise<number> {
  const rows = await prisma.customer.findMany({ where: { paymentTerms: { not: null } }, select: { id: true, paymentTerms: true } });
  let changed = 0;
  for (const r of rows) {
    const tidy = tidyPaymentTerms(r.paymentTerms);
    if (tidy === r.paymentTerms) continue;
    changed += (await prisma.customer.updateMany({ where: { id: r.id, paymentTerms: r.paymentTerms }, data: { paymentTerms: tidy } })).count;
  }
  return changed;
}

/** The sub-industry a SCORO import's note names ("SCORO tags: Healthcare, …"), matched by name; null when none of its tags is one. */
export function subIndustryFromNotes(notes: string | null | undefined, subIndustries: { id: string; name: string }[]): { id: string; name: string } | null {
  const line = /SCORO tags?:\s*(.+)/i.exec(notes ?? '');
  if (!line) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const tag of line[1].split(/[,;]/)) {
    const hit = subIndustries.find((s) => norm(s.name) === norm(tag));
    if (hit) return hit;
  }
  return null;
}
