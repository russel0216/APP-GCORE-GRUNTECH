import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import { formatShortDate, statusLabel, type PdfSection } from './pdf';

/**
 * THE PRINTED LISTS (rule 6, A5) — the one copy of what every list's paper
 * says. Every register has a printed twin, `GET <list>/pdf` declared above
 * `/:id`: the SAME where-builder the list reads (with `?ids=`, the rows
 * ticked, ANDed with the visibility rule), the list's own sort, at most
 * LIST_CAP rows, a reference naming every filter that narrowed it, figures
 * as `formatAmount` under a head naming the currency, totals over EVERY row
 * the filter matched (not only those printed), and an EXPORTED audit row
 * with entityId 'list'.
 *
 * Five module groups each carried a copy of these until 2026-10-10, and the
 * copies had drifted (one filter day was a 400, another a 500 from the
 * database; one enum check let 'toString' through). A route imports them
 * from here; no route exports a list helper for another route.
 */

/** The most rows a printed list carries; the reference says when it was cut. */
export const LIST_CAP = 1000;

type Said = string | null | false | undefined;

/**
 * A printed list's reference: "12 invoices", or, cut at the cap, "first
 * 1,000 of 1,234 invoices printed" — then every filter that narrowed it, so
 * the paper says which set it is.
 */
export function listReference(count: number, printed: number, noun: readonly [string, string], filters: Said[]): string {
  const n = (v: number) => v.toLocaleString('en-PH');
  const head = count > printed ? `first ${n(printed)} of ${n(count)} ${noun[1]} printed` : `${n(count)} ${count === 1 ? noun[0] : noun[1]}`;
  const named = filters.filter(Boolean);
  return named.length ? `${head} — ${named.join(' · ')}` : head;
}

/** A total's label — which, on a list cut at the cap, says it covers every row, not only those printed. */
export const totalLabel = (label: string, count: number, printed: number) =>
  count > printed ? `${label}, all ${count.toLocaleString('en-PH')}` : label;

/**
 * A stored rate as a money block's label prints it — 0.12 → "12%", 0.125 →
 * "12.5%", 0.075 → "7.5%" — to two places at most, in Decimal, so a rate is
 * never rounded to a whole percent ("VAT (13%)" on a 12.5% order) nor
 * printed with a float's tail. Every document's "VAT (…)" and "Less: EWT (…)"
 * reads it.
 */
export const ratePct = (rate: number | { toString(): string }) => `${Number(new Prisma.Decimal(rate.toString()).mul(100).toFixed(2))}%`;

/** A figure that is listed but not summed (a cancelled, rejected or draft document's), in brackets. */
export const bracketed = (amount: string, counted: boolean) => (counted ? amount : `(${amount})`);

/** "1 draft invoice" / "3 draft invoices" — a count in a note under a list. */
export const counted = (n: number, noun: readonly [string, string]) => `${n.toLocaleString('en-PH')} ${n === 1 ? noun[0] : noun[1]}`;

/**
 * The note under a list whose bracketed rows are left out of its totals —
 * "1 cancelled job order, in brackets, is not counted." — one sentence for
 * one rule, in every module.
 */
export const bracketNote = (n: number, noun: readonly [string, string]) =>
  n ? `${counted(n, noun)}, in brackets, ${n === 1 ? 'is' : 'are'} not counted.` : null;

/** A list's notes under its totals, as one paragraph — or nothing when there is nothing to say. */
export const listNotes = (notes: Said[]): PdfSection[] => {
  const said = notes.filter((v): v is string => !!v);
  return said.length ? [{ kind: 'text', body: said.join(' ') }] : [];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a real calendar day written 'YYYY-MM-DD' — 2026-02-30 is not. */
const isDay = (value: string) => {
  if (!DAY.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
};

/**
 * A 'YYYY-MM-DD' a list's filter names, checked: a malformed or impossible
 * day is a 400 naming the filter, never a 500 from the database and never a
 * silently different day. Returns the key — a DATE column's edge is
 * `dayOf(key)`, a timestamp's `manilaDayStart`/`manilaDayEnd` (shared/day).
 */
export function filterDay(value: string | undefined, label: string): string | null {
  if (!value) return null;
  if (!isDay(value)) throw badRequest(`${label} is a date written YYYY-MM-DD`);
  return value;
}

/** A day key as a DATE column holds it: UTC midnight of that date. */
export const dayOf = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** A 'YYYY-MM-DD' a filter names, as a list prints a date (MM/DD/YYYY); a half-open range's missing end as "…". */
export const listDay = (key: unknown) => (typeof key === 'string' && isDay(key) ? formatShortDate(dayOf(key)) : '…');

/** A from–to pair as a filter line prints it — "added 10/01/2026 to …" — or null when neither end is set. */
export const rangeNamed = (label: string, from: string | undefined, to: string | undefined) =>
  from || to ? `${label} ${listDay(from)} to ${listDay(to)}` : null;

/**
 * A choice filter's value, checked against what it can be: an unknown one is
 * a 400 naming the choices in words ("Status is one of Draft, Pending
 * approval, Approved"), never a 500 from the database and never a raw enum.
 * Matched against the VALUES, so a prototype key ('toString', 'constructor')
 * is just another unknown value. `words` names a choice where `statusLabel`
 * would not (a module's own vocabulary).
 */
export function choice<T extends string>(
  value: string | undefined,
  allowed: Readonly<Record<string, T>> | readonly T[],
  label: string,
  words: (v: T) => string = statusLabel,
): T | undefined {
  if (!value) return undefined;
  const values = (Array.isArray(allowed) ? allowed : Object.values(allowed)) as readonly T[];
  if (!(values as readonly string[]).includes(value)) throw badRequest(`${label} is one of ${values.map(words).join(', ')}`);
  return value as T;
}

type Named = 'customer' | 'supplier' | 'person' | 'project' | 'site' | 'advance' | 'budget request';

/** What a filter line calls the record an id names: a name, or a document's number. */
async function nameOf(kind: Named, id: string): Promise<string | undefined> {
  switch (kind) {
    case 'customer':
      return (await prisma.customer.findUnique({ where: { id }, select: { name: true } }))?.name;
    case 'supplier':
      return (await prisma.supplier.findUnique({ where: { id }, select: { name: true } }))?.name;
    case 'person':
      return (await prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name;
    case 'project':
      return (await prisma.job.findUnique({ where: { id }, select: { number: true } }))?.number;
    case 'site':
      return (await prisma.customerSite.findUnique({ where: { id }, select: { name: true } }))?.name;
    case 'advance':
      return (await prisma.cashAdvance.findUnique({ where: { id }, select: { number: true } }))?.number;
    case 'budget request':
      return (await prisma.budgetRequest.findUnique({ where: { id }, select: { number: true } }))?.number;
  }
}

/**
 * The record a `?<key>Id=` filter names, as a filter line prints it —
 * "customer ACME Hospital", "project GT-PRJ-2026-0112" — or "… not found"
 * for an id that matches nothing (the list is then empty, and says why).
 * Read for the paper only.
 */
export async function recordNamed(
  kind: Named,
  id: string | undefined,
  /** What the line says before the name, when not the kind — "requested by", "with". */
  label: string = kind,
): Promise<string | null> {
  if (!id) return null;
  return `${label} ${(await nameOf(kind, id)) ?? 'not found'}`;
}

/**
 * The names behind several ids at once, bare — for a filter line that words
 * them itself ("for ACME Hospital at the North plant"). An id that names
 * nothing reads "not found" rather than printing the id.
 */
export async function namedInFilter(ids: {
  customerId?: string;
  jobId?: string;
  userId?: string;
  siteId?: string;
}): Promise<{ customer: string | null; project: string | null; person: string | null; site: string | null }> {
  const bare = async (kind: Named, id: string | undefined) => (id ? ((await nameOf(kind, id)) ?? 'not found') : null);
  const [customer, project, person, site] = await Promise.all([
    bare('customer', ids.customerId),
    bare('project', ids.jobId),
    bare('person', ids.userId),
    bare('site', ids.siteId),
  ]);
  return { customer, project, person, site };
}

/**
 * The scope a printed list stands in, as its filter line names it: "team
 * KAT" for the Team view (Mine for a viewer with no team — the where-
 * builders' own fallback), "mine only" for Mine, and also when the caller
 * may only ever see their own (`onlyOwn`), so a salesperson's paper never
 * reads as everybody's. All says nothing.
 */
export function scopeNamed(scope: string, team: { code: string } | null, onlyOwn: boolean, mine = 'mine only'): string | null {
  if (scope === 'team' && team && !onlyOwn) return `team ${team.code}`;
  return onlyOwn || scope === 'mine' || scope === 'team' ? mine : null;
}

/** A printed list goes out inline, under its own file name. */
export function sendListPdf(res: Response, pdf: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(pdf);
}
