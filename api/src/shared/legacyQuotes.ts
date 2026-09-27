import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request } from 'express';
import { Prisma, type QuotationOutcome } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prisma';
import { badRequest, conflict, notFound } from '../http/kit';
import { audit } from './audit';
import { attachmentPath, deleteAttachment, saveAttachment } from './attachments';
import { employeeNoFor, employeeToken } from './numbering';
import { manilaMonthKey } from './day';
import { quotationTotals, recalcQuotationRevision } from './quotation';

/**
 * The SCORO archive (LegacyQuote) — importing it, and continuing an open SCORO
 * quote as a live G-CORE quotation.
 *
 * The archive is READ-ONLY history. Nothing in live work points at it; the only
 * link is the one-way LegacyQuote.continuedQuotationId, written once when an
 * open quote is continued. The PDF SCORO produced is the record — the lines
 * were read back out of it on the workstation (tools/scoro/scoro_quotes.py) and
 * are kept for search and for seeding a continued quotation, not as a second
 * version of the truth.
 *
 * The import is idempotent: a quote is keyed by (source, sourceId), so running
 * it again updates the fields and replaces the PDF rather than duplicating
 * either, and it never clears a link somebody made in G-CORE (the continued
 * quotation, a customer linked by hand).
 *
 * Numbering continues from SCORO. The house scheme is {EMP}{YY}{MM}{SEQ}, one
 * counter per employee code per month. For every month from the current one on,
 * the import raises that month's counter to the highest SCORO sequence seen for
 * the code, so the next number G-CORE issues follows SCORO's last rather than
 * colliding with it. A counter is only ever raised, never lowered.
 *
 * A number counts as a house number only when its YY and MM are the quote's own
 * date. Not every salesperson used the scheme — "83" + YYMM + a four-digit run
 * (8326090163) reads as code 832, month 2060-90, and 8326010050 as a counter for
 * October 2060 — so the date is the test, not the shape. Everything else is
 * archived as it is and listed as "not in the house format". Counters are
 * seeded per CODE, never per owner name: a number issued under a colleague's
 * code is exactly the one that would collide if that code's counter were left
 * behind.
 */

export const LEGACY_QUOTE_ENTITY = 'legacy_quote';

/** Still in play in SCORO — these may be continued in G-CORE. */
export const OPEN_STATUSES = ['Opportunity', 'Negotiation', 'Closing', 'Hold', 'This Month Forecast', 'Confirmed'];
/** Settled in SCORO — view only. */
export const CLOSED_STATUSES = ['Completed', 'Rejected', 'Cancelled', 'Confirmed Project'];

const OPEN_KEYS = new Set(OPEN_STATUSES.map((s) => s.toUpperCase()));

export function isOpenStatus(status: string | null | undefined): boolean {
  return OPEN_KEYS.has((status ?? '').trim().toUpperCase());
}

/** SCORO's stage → the live quotation's outcome. */
export function outcomeFor(status: string): QuotationOutcome {
  switch (status.trim().toUpperCase()) {
    case 'NEGOTIATION':
    case 'CLOSING':
    case 'CONFIRMED':
      return 'NEGOTIATION';
    default:
      // Opportunity, This Month Forecast, Hold
      return 'OPEN';
  }
}

export const MSG_LINK_CUSTOMER = 'Link this SCORO quote to a customer first';

// ── Quotation totals ─────────────────────────────────────────────────────────

/**
 * A revision's money, by THE quotation arithmetic in shared/quotation.ts
 * (quotationTotals): subtotal before discount, discount off, VAT on the net,
 * total = net + VAT. This is only a Decimal-returning view of it for the
 * continue path, never a second copy of the rule.
 *
 * `discountPct` is a PERCENTAGE (5 means 5%), as SCORO carries it.
 */
export function quoteTotals(input: {
  amounts: (Prisma.Decimal | string | number)[];
  discountPct: Prisma.Decimal | string | number;
  vatRate: Prisma.Decimal | string | number;
}) {
  const t = quotationTotals({
    lines: input.amounts.map((amount) => ({ amount })),
    discountPct: input.discountPct,
    vatRate: input.vatRate,
    vatInclusive: false,
  });
  const D = (v: number) => new Prisma.Decimal(v.toFixed(2));
  return {
    subtotal: D(t.subtotal),
    discountAmount: D(t.discountAmount),
    net: D(t.net),
    vatAmount: D(t.vatAmount),
    total: D(t.total),
  };
}

// ── The bundle ───────────────────────────────────────────────────────────────

const str = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? '' : String(v).trim()));

const lineSchema = z.object({
  title: str,
  description: str,
  quantity: str,
  unit: str,
  unitPrice: str,
  amount: str,
});

const quoteSchema = z.object({
  scoroId: str,
  number: str,
  date: str,
  dueDate: str,
  estimatedClosing: str,
  confirmedAt: str,
  owner: str,
  customer: str,
  customerScoroId: str,
  contact: str,
  name: str,
  project: str,
  status: str,
  previousStatus: str,
  statusChangedAt: str,
  statusChangedBy: str,
  currency: str,
  discountPct: str,
  subtotal: str,
  vat: str,
  total: str,
  cost: str,
  prNumber: str,
  delivery: str,
  paymentTerms: str,
  comment: str,
  invoiceNos: str,
  isSent: z.union([z.boolean(), z.string(), z.number(), z.null(), z.undefined()]).transform(
    (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true',
  ),
  lines: z.array(lineSchema).default([]),
  linesReconcile: z.boolean().default(true),
  pdf: str,
});

const bundleSchema = z.object({
  source: z.string().trim().min(1).default('SCORO'),
  quotes: z.array(quoteSchema),
});

export type BundleQuote = z.infer<typeof quoteSchema>;
export type BundleLine = z.infer<typeof lineSchema>;

export function readBundle(dir: string): { source: string; quotes: BundleQuote[] } {
  const file = path.join(dir, 'quotes.json');
  if (!fs.existsSync(file)) throw badRequest(`No quotes.json in ${dir}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw badRequest('quotes.json is not valid JSON');
  }
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(`quotes.json is not a SCORO bundle: ${first.path.join('.')} ${first.message}`);
  }
  return parsed.data;
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

const HOUSE_NUMBER = /^(\d{3})(\d{2})(\d{2})(\d{3})$/;

/**
 * `0012609059` dated 2026-09-… → { emp '001', month '2026-09', seq 59 }.
 * Anything else → null: a number of another shape, and a ten-digit number whose
 * YYMM is not the quote's own year and month (`date`, 'YYYY-MM-DD…'). The date
 * is what tells a house number from a number that merely has ten digits.
 *
 * SCORO stored some numbers as integers and dropped their leading zeros:
 * `12609060` is `0012609060`, code 001. An eight- or nine-digit number is
 * padded back to ten before the test, because a number issued under a code —
 * by anyone, under anyone's code — is a number G-CORE must never issue again.
 * The date test still decides, so padding cannot invent a house number.
 */
export function parseHouseNumber(number: string, date: string | null | undefined): { emp: string; month: string; seq: number } | null {
  const digits = number.trim();
  const m = HOUSE_NUMBER.exec(/^\d{8,9}$/.test(digits) ? digits.padStart(10, '0') : digits);
  if (!m) return null;
  const d = /^(\d{2})(\d{2})-(\d{2})/.exec((date ?? '').trim());
  if (!d) return null;
  if (m[2] !== d[2] || m[3] !== d[3]) return null;
  const mm = Number(m[3]);
  if (mm < 1 || mm > 12) return null;
  return { emp: m[1], month: `${d[1]}${m[2]}-${m[3]}`, seq: Number(m[4]) };
}

/** Whitespace collapsed, case folded — how a name is compared. */
export function normName(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * The SCORO ids a customer's notes name. The company import wrote
 * "(SCORO id 39)" — or "(SCORO id 39, 40)" where two SCORO companies were
 * merged — so each id is a whole token: 39 never matches 390.
 */
export function scoroIdsIn(notes: string | null | undefined): string[] {
  if (!notes) return [];
  const ids: string[] = [];
  for (const m of notes.matchAll(/SCORO id\s+(\d+(?:\s*,\s*\d+)*)/gi)) {
    for (const id of m[1].split(',')) ids.push(id.trim());
  }
  return ids;
}

function dateOnly(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** SCORO's timestamps are Manila wall-clock time with no zone. */
function manilaTimestamp(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(s);
  if (!m) return dateOnly(s);
  const d = new Date(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dec(s: string): Prisma.Decimal {
  const clean = (s || '0').replace(/,/g, '');
  try {
    return new Prisma.Decimal(clean);
  } catch {
    return new Prisma.Decimal(0);
  }
}

const orNull = (s: string) => (s === '' ? null : s);

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The PDF a quote names, if it is inside the bundle and really a PDF. */
function pdfPathFor(dir: string, q: BundleQuote): string | null {
  const rel = q.pdf;
  if (!rel) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null; // escapes the bundle
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ── Counters ─────────────────────────────────────────────────────────────────

export interface CounterPlan {
  periodKey: string;
  month: string;
  emp: string;
  /** Highest sequence SCORO issued for this employee code in this month. */
  scoroSeq: number;
  /** The counter's lastNumber today, or null when the row does not exist yet. */
  existing: number | null;
  /** What it will be after the import — never below `existing`. */
  target: number;
  change: 'create' | 'raise' | 'keep';
}

/**
 * `<YYYY-MM>@<code>` → highest SCORO sequence, for every house number (see
 * parseHouseNumber — its YYMM must be its own date's) dated in the current
 * Manila month or later. Earlier months are closed: no new number is ever
 * issued into them, so there is nothing to continue. Keyed by the number's
 * code, whoever the owner was.
 */
/**
 * The counter rows the import raises, one per employee code.
 *
 * `period` is the quotation template's: MONTH keys `<YYYY-MM>@<code>` from
 * house numbers of the current month onward; YEAR keys `<YYYY>@<code>` from
 * every house number of the current year onward, because SCORO's count ran
 * through the year and restarted each January (Carter's 0012609059 is his
 * 59th of 2026). In a yearly run a number whose month part lags its date
 * (0012004011 dated in March) still used that count, so only the code and the
 * year must agree with the date. `month` is always the current month, which is
 * what the "next number" in the report is printed for.
 */
export function counterTargets(
  quotes: { number: string; date: string | null | undefined }[],
  currentMonth: string,
  period: 'MONTH' | 'YEAR' | 'NONE' = 'MONTH',
): Map<string, { month: string; emp: string; seq: number }> {
  const out = new Map<string, { month: string; emp: string; seq: number }>();
  const currentYear = currentMonth.slice(0, 4);
  for (const q of quotes) {
    if (period === 'YEAR') {
      const p = parseYearNumber(q.number, q.date);
      if (!p || p.year < currentYear) continue;
      const key = `${p.year}@${p.emp}`;
      const prev = out.get(key);
      if (!prev || p.seq > prev.seq) out.set(key, { month: currentMonth, emp: p.emp, seq: p.seq });
      continue;
    }
    const p = parseHouseNumber(q.number, q.date);
    if (!p || p.month < currentMonth) continue;
    const key = `${p.month}@${p.emp}`;
    const prev = out.get(key);
    if (!prev || p.seq > prev.seq) out.set(key, { month: p.month, emp: p.emp, seq: p.seq });
  }
  return out;
}

/**
 * A house-shaped number read for a YEARLY run: code, year and count, with the
 * month part only required to be a month. The year must be the quote's own —
 * that is still what stops Camille's 8326090163 (code 832, "year 60") from
 * reading as anything — and dropped zeros are restored as in parseHouseNumber.
 */
export function parseYearNumber(number: string, date: string | null | undefined): { emp: string; year: string; seq: number } | null {
  const digits = number.trim();
  const m = HOUSE_NUMBER.exec(/^\d{8,9}$/.test(digits) ? digits.padStart(10, '0') : digits);
  if (!m) return null;
  const d = /^(\d{2})(\d{2})-/.exec((date ?? '').trim());
  if (!d || m[2] !== d[2]) return null;
  const mm = Number(m[3]);
  if (mm < 1 || mm > 12) return null;
  return { emp: m[1], year: `${d[1]}${m[2]}`, seq: Number(m[4]) };
}

export async function planCounters(
  targets: Map<string, { month: string; emp: string; seq: number }>,
  documentType: string,
  db: Prisma.TransactionClient = prisma,
): Promise<CounterPlan[]> {
  const keys = [...targets.keys()];
  const rows = keys.length
    ? await db.numberSequence.findMany({ where: { documentType, periodKey: { in: keys } } })
    : [];
  const byKey = new Map(rows.map((r) => [r.periodKey, r.lastNumber]));
  return keys.sort().map((periodKey) => {
    const t = targets.get(periodKey)!;
    const existing = byKey.get(periodKey) ?? null;
    const target = Math.max(existing ?? 0, t.seq);
    return {
      periodKey,
      month: t.month,
      emp: t.emp,
      scoroSeq: t.seq,
      existing,
      target,
      change: existing === null ? 'create' : existing < t.seq ? 'raise' : 'keep',
    };
  });
}

/**
 * Writes the plan. A new counter row copies label, pattern, type code, period,
 * scope and padding from the template (periodKey '') exactly as nextNumber's
 * own create does; an existing row is only ever RAISED, and the raise is
 * conditional in the database so a number issued in between is not undone.
 */
export async function seedCounters(
  targets: Map<string, { month: string; emp: string; seq: number }>,
  documentType: string,
  tx: Prisma.TransactionClient,
): Promise<CounterPlan[]> {
  const plan = await planCounters(targets, documentType, tx);
  if (!plan.length) return plan;
  const template =
    (await tx.numberSequence.findFirst({ where: { documentType, periodKey: '' } })) ??
    (await tx.numberSequence.findFirst({ where: { documentType } }));
  if (!template) throw notFound(`No numbering configured for "${documentType}"`);

  for (const p of plan) {
    if (p.change === 'create') {
      await tx.numberSequence.upsert({
        where: { documentType_periodKey: { documentType, periodKey: p.periodKey } },
        create: {
          documentType,
          label: template.label,
          pattern: template.pattern,
          typeCode: template.typeCode,
          period: template.period,
          scope: template.scope,
          periodKey: p.periodKey,
          padding: template.padding,
          lastNumber: p.scoroSeq,
        },
        update: {},
      });
      // Someone may have created it between the plan and the upsert.
      await tx.numberSequence.updateMany({
        where: { documentType, periodKey: p.periodKey, lastNumber: { lt: p.scoroSeq } },
        data: { lastNumber: p.scoroSeq },
      });
    } else if (p.change === 'raise') {
      await tx.numberSequence.updateMany({
        where: { documentType, periodKey: p.periodKey, lastNumber: { lt: p.scoroSeq } },
        data: { lastNumber: p.scoroSeq },
      });
    }
  }
  return plan;
}

// ── The import ───────────────────────────────────────────────────────────────

export interface OwnerReport {
  name: string;
  quotes: number;
  codes: { code: string; count: number }[];
  /** The code most of this owner's SCORO numbers carry. */
  primaryCode: string | null;
  user: { id: string; name: string; employeeNo: string | null; token: string } | null;
  mismatch: boolean;
  message: string | null;
}

export interface ImportReport {
  source: string;
  committed: boolean;
  totals: {
    quotes: number;
    created: number;
    updated: number;
    skipped: number;
    open: number;
    closed: number;
    withPdf: number;
    /** The bundle names a PDF that is not in it. */
    missingPdf: number;
    /** SCORO exported no document for the quote (`"pdf": null`); archived without one. */
    noPdf: number;
    byStatus: Record<string, number>;
  };
  customers: {
    matchedByName: number;
    matchedByScoroId: number;
    unmatchedQuotes: number;
    matched: { name: string; customerId: string; customerName: string; by: 'name' | 'scoro_id'; quotes: number }[];
    unmatched: { name: string; scoroId: string; quotes: number }[];
  };
  owners: OwnerReport[];
  notReconciling: { number: string; customer: string; subtotal: number; linesSum: number }[];
  /** Numbers that are not {EMP}{YY}{MM}{SEQ} for their own date — archived as-is, no counter seeded. */
  notHouseFormat: { number: string; date: string; owner: string }[];
  counters: CounterPlan[];
  counterTemplate: { pattern: string; period: string; scope: string; houseScheme: boolean } | null;
  pdfs: { stored: number; replaced: number; kept: number; missing: string[]; noPdf: string[] };
  warnings: string[];
}

export interface ImportOptions {
  commit: boolean;
  /** The user recorded as importer and as uploader of the PDFs. Required to commit. */
  actorId?: string | null;
  actorName?: string | null;
  req?: Request;
  /** Defaults to now; decides which months' counters are continued. */
  now?: Date;
  /** Counters are seeded for this document type — 'quotation' unless a test says otherwise. */
  counterDocumentType?: string;
}

function linesSum(lines: BundleLine[]): Prisma.Decimal {
  return lines.reduce<Prisma.Decimal>((s, l) => s.plus(dec(l.amount)), new Prisma.Decimal(0));
}

export async function importBundle(dir: string, opts: ImportOptions): Promise<ImportReport> {
  const bundle = readBundle(dir);
  const source = bundle.source || 'SCORO';
  const counterType = opts.counterDocumentType ?? 'quotation';
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  if (opts.commit && !opts.actorId) throw badRequest('An import has to be recorded against a user');

  // ── De-duplicate inside the bundle ──
  const bySource = new Map<string, BundleQuote>();
  let skipped = 0;
  for (const q of bundle.quotes) {
    if (!q.scoroId || !q.number) {
      skipped++;
      warnings.push(`A quote with no SCORO id or number was skipped (${q.number || q.scoroId || 'blank'})`);
      continue;
    }
    if (bySource.has(q.scoroId)) warnings.push(`SCORO id ${q.scoroId} appears twice; the later row wins`);
    bySource.set(q.scoroId, q);
  }
  const seenNumbers = new Map<string, string>();
  const quotes: BundleQuote[] = [];
  for (const q of bySource.values()) {
    const other = seenNumbers.get(q.number);
    if (other) {
      skipped++;
      warnings.push(`Quote number ${q.number} is used by SCORO ids ${other} and ${q.scoroId}; the second was skipped`);
      continue;
    }
    seenNumbers.set(q.number, q.scoroId);
    quotes.push(q);
  }

  // ── What is already here ──
  const existingRows = await prisma.legacyQuote.findMany({
    where: { OR: [{ source, sourceId: { in: quotes.map((q) => q.scoroId) } }, { number: { in: quotes.map((q) => q.number) } }] },
    select: { id: true, source: true, sourceId: true, number: true, customerId: true, ownerUserId: true },
  });
  const existingBySource = new Map(existingRows.filter((r) => r.source === source).map((r) => [r.sourceId, r]));
  const existingByNumber = new Map(existingRows.map((r) => [r.number, r]));

  const importable: BundleQuote[] = [];
  for (const q of quotes) {
    const holder = existingByNumber.get(q.number);
    if (holder && !(holder.source === source && holder.sourceId === q.scoroId)) {
      skipped++;
      warnings.push(`Quote number ${q.number} is already archived under ${holder.source} id ${holder.sourceId}; skipped`);
      continue;
    }
    importable.push(q);
  }

  // ── Customers ──
  const customers = await prisma.customer.findMany({ select: { id: true, name: true, notes: true, isActive: true } });
  const byName = new Map<string, { id: string; name: string }>();
  const byScoroId = new Map<string, { id: string; name: string }>();
  // Active first, so an inactive duplicate never wins the match.
  for (const c of [...customers].sort((a, b) => Number(b.isActive) - Number(a.isActive))) {
    const key = normName(c.name);
    if (!byName.has(key)) byName.set(key, c);
    for (const id of scoroIdsIn(c.notes)) if (!byScoroId.has(id)) byScoroId.set(id, c);
  }

  const customerOf = new Map<string, { id: string; by: 'name' | 'scoro_id' } | null>();
  const matchedAgg = new Map<string, ImportReport['customers']['matched'][number]>();
  const unmatchedAgg = new Map<string, ImportReport['customers']['unmatched'][number]>();
  let matchedByName = 0;
  let matchedByScoroId = 0;
  let unmatchedQuotes = 0;
  for (const q of importable) {
    const hit = byName.get(normName(q.customer));
    const viaId = !hit && q.customerScoroId ? byScoroId.get(q.customerScoroId) : undefined;
    const c = hit ?? viaId;
    if (c) {
      const by = hit ? 'name' : 'scoro_id';
      if (hit) matchedByName++;
      else matchedByScoroId++;
      customerOf.set(q.scoroId, { id: c.id, by });
      const agg = matchedAgg.get(q.customer) ?? { name: q.customer, customerId: c.id, customerName: c.name, by, quotes: 0 };
      agg.quotes++;
      matchedAgg.set(q.customer, agg);
    } else {
      customerOf.set(q.scoroId, null);
      // A quote already linked by hand counts as matched, not as a gap.
      if (existingBySource.get(q.scoroId)?.customerId) continue;
      unmatchedQuotes++;
      const agg = unmatchedAgg.get(q.customer) ?? { name: q.customer, scoroId: q.customerScoroId, quotes: 0 };
      agg.quotes++;
      unmatchedAgg.set(q.customer, agg);
    }
  }

  // ── Owners ──
  const users = await prisma.user.findMany({ select: { id: true, name: true, isActive: true } });
  const userByName = new Map<string, { id: string; name: string }>();
  for (const u of [...users].sort((a, b) => Number(b.isActive) - Number(a.isActive))) {
    const key = normName(u.name);
    if (!userByName.has(key)) userByName.set(key, u);
  }
  const ownerAgg = new Map<string, { name: string; quotes: number; codes: Map<string, number> }>();
  for (const q of importable) {
    const key = normName(q.owner) || '(NO OWNER)';
    const agg = ownerAgg.get(key) ?? { name: q.owner || '(no owner)', quotes: 0, codes: new Map<string, number>() };
    agg.quotes++;
    const p = parseHouseNumber(q.number, q.date);
    if (p) agg.codes.set(p.emp, (agg.codes.get(p.emp) ?? 0) + 1);
    ownerAgg.set(key, agg);
  }
  const owners: OwnerReport[] = [];
  for (const [key, agg] of ownerAgg) {
    const codes = [...agg.codes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    const primaryCode = codes[0]?.code ?? null;
    const u = userByName.get(key);
    let user: OwnerReport['user'] = null;
    if (u) {
      const employeeNo = await employeeNoFor(u.id);
      user = { id: u.id, name: u.name, employeeNo, token: employeeToken(employeeNo) };
    }
    const mismatch = !!user && !!primaryCode && user.token !== primaryCode;
    let message: string | null = null;
    if (!u) {
      message = `No G-CORE user is named "${agg.name}". Their quotes are archived unassigned; a quote continued in G-CORE goes to whoever continues it.`;
    } else if (mismatch) {
      message = `Give ${u.name} employee number ending in ${primaryCode}. G-CORE would number their quotations ${user!.token}…, SCORO numbered them ${primaryCode}…`;
    }
    owners.push({ name: agg.name, quotes: agg.quotes, codes, primaryCode, user, mismatch, message });
  }
  owners.sort((a, b) => b.quotes - a.quotes);

  // ── Lines that do not add up ──
  const notReconciling = importable
    .filter((q) => !q.linesReconcile)
    .map((q) => ({
      number: q.number,
      customer: q.customer,
      subtotal: Number(dec(q.subtotal)),
      linesSum: Number(linesSum(q.lines)),
    }));

  // ── Counters ──
  const notHouseFormat = importable
    .filter((q) => !parseHouseNumber(q.number, q.date))
    .map((q) => ({ number: q.number, date: q.date, owner: q.owner }))
    .sort((a, b) => a.number.localeCompare(b.number));
  const template = await prisma.numberSequence.findFirst({ where: { documentType: counterType, periodKey: '' } });
  const targets = counterTargets(importable, manilaMonthKey(now), template?.period ?? 'MONTH');
  const counterTemplate = template
    ? {
        pattern: template.pattern,
        period: template.period,
        scope: template.scope,
        houseScheme: template.period !== 'NONE' && template.scope === 'OWNER' && template.pattern.includes('{EMP}'),
      }
    : null;
  if (!template && targets.size) {
    warnings.push(`There is no "${counterType}" numbering configured; no counters can be continued`);
  } else if (counterTemplate && !counterTemplate.houseScheme && targets.size) {
    warnings.push(
      `Quotation numbering is set to ${counterTemplate.pattern} (${counterTemplate.period.toLowerCase()}, ${counterTemplate.scope.toLowerCase()}), not SCORO's {EMP}{YY}{MM}{SEQ} monthly per employee. ` +
        'The counters below are seeded anyway, but G-CORE only uses them once Admin > Numbering sets Quotation to that scheme.',
    );
  }

  // ── PDFs ──
  // `"pdf": null` means SCORO exported no document for the quote: it is
  // archived without one, counted apart from a PDF the bundle names but lacks.
  const pdfFor = new Map<string, string | null>();
  const missing: string[] = [];
  const noPdf: string[] = [];
  for (const q of importable) {
    if (!q.pdf) {
      pdfFor.set(q.scoroId, null);
      noPdf.push(q.number);
      continue;
    }
    const p = pdfPathFor(dir, q);
    pdfFor.set(q.scoroId, p);
    if (!p) missing.push(q.number);
  }

  const byStatus: Record<string, number> = {};
  for (const q of importable) byStatus[q.status || '(none)'] = (byStatus[q.status || '(none)'] ?? 0) + 1;
  const created = importable.filter((q) => !existingBySource.has(q.scoroId)).length;

  const report: ImportReport = {
    source,
    committed: false,
    totals: {
      quotes: importable.length,
      created,
      updated: importable.length - created,
      skipped,
      open: importable.filter((q) => isOpenStatus(q.status)).length,
      closed: importable.filter((q) => !isOpenStatus(q.status)).length,
      withPdf: importable.length - missing.length - noPdf.length,
      missingPdf: missing.length,
      noPdf: noPdf.length,
      byStatus,
    },
    customers: {
      matchedByName,
      matchedByScoroId,
      unmatchedQuotes,
      matched: [...matchedAgg.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unmatched: [...unmatchedAgg.values()].sort((a, b) => b.quotes - a.quotes || a.name.localeCompare(b.name)),
    },
    owners,
    notReconciling,
    notHouseFormat,
    counters: template ? await planCounters(targets, counterType) : [],
    counterTemplate,
    pdfs: { stored: 0, replaced: 0, kept: 0, missing, noPdf },
    warnings,
  };

  if (!opts.commit) return report;

  // ── Commit: the rows and the counters in one transaction ──
  const ownerIdOf = (q: BundleQuote) => userByName.get(normName(q.owner))?.id ?? null;
  const idBySource = new Map<string, string>();
  await prisma.$transaction(
    async (tx) => {
      for (const q of importable) {
        const customer = customerOf.get(q.scoroId) ?? null;
        const ownerUserId = ownerIdOf(q);
        const fields = {
          number: q.number,
          date: dateOnly(q.date),
          dueDate: dateOnly(q.dueDate),
          estimatedClosing: dateOnly(q.estimatedClosing),
          confirmedAt: manilaTimestamp(q.confirmedAt),
          ownerName: q.owner || '(no owner)',
          customerName: q.customer || '(no customer)',
          contactName: orNull(q.contact),
          name: orNull(q.name),
          projectName: orNull(q.project),
          status: q.status || 'Unknown',
          previousStatus: orNull(q.previousStatus),
          statusChangedAt: manilaTimestamp(q.statusChangedAt),
          statusChangedBy: orNull(q.statusChangedBy),
          currency: q.currency || 'PHP',
          discountPct: dec(q.discountPct),
          subtotal: dec(q.subtotal),
          vat: dec(q.vat),
          total: dec(q.total),
          cost: dec(q.cost),
          prNumber: orNull(q.prNumber),
          delivery: orNull(q.delivery),
          paymentTerms: orNull(q.paymentTerms),
          comment: orNull(q.comment),
          invoiceNos: orNull(q.invoiceNos),
          isSent: q.isSent,
          lines: q.lines as unknown as Prisma.InputJsonValue,
          linesReconcile: q.linesReconcile,
          importedAt: now,
          importedById: opts.actorId ?? null,
        };
        const row = await tx.legacyQuote.upsert({
          where: { source_sourceId: { source, sourceId: q.scoroId } },
          create: {
            source,
            sourceId: q.scoroId,
            ...fields,
            customerId: customer?.id ?? null,
            ownerUserId,
          },
          // Never clears continuedQuotationId, nor a customer or owner a person
          // linked in G-CORE: an unmatched re-import leaves them as they are.
          update: {
            ...fields,
            ...(customer ? { customerId: customer.id } : {}),
            ...(ownerUserId ? { ownerUserId } : {}),
          },
          select: { id: true },
        });
        idBySource.set(q.scoroId, row.id);
      }
      if (template) report.counters = await seedCounters(targets, counterType, tx);
      await audit(
        {
          entityType: LEGACY_QUOTE_ENTITY,
          entityId: 'import',
          action: 'EXECUTED',
          summary:
            `Imported ${importable.length} ${source} quotes (${created} new, ${importable.length - created} updated); ` +
            `${report.counters.filter((c) => c.change !== 'keep').length} quotation counters continued`,
          actorId: opts.actorId ?? null,
          actorName: opts.actorName ?? null,
          after: {
            totals: report.totals,
            counters: report.counters.map((c) => ({ periodKey: c.periodKey, from: c.existing, to: c.target })),
          },
        },
        opts.req,
        tx,
      );
    },
    { timeout: 180_000, maxWait: 20_000 },
  );

  // ── PDFs, after the rows exist. A failed file never undoes the archive. ──
  for (const q of importable) {
    const file = pdfFor.get(q.scoroId);
    const id = idBySource.get(q.scoroId);
    if (!file || !id) continue;
    try {
      const outcome = await storeLegacyPdf(id, file, q.number, opts.actorId!);
      report.pdfs[outcome]++;
    } catch (err) {
      warnings.push(`PDF for ${q.number} was not stored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  report.committed = true;
  return report;
}

/**
 * Stores a quote's PDF through the one attachment service, as entity
 * `legacy_quote`. The same bytes already on file are kept; different bytes
 * replace the old file rather than sitting beside it.
 */
export async function storeLegacyPdf(
  legacyQuoteId: string,
  file: string,
  number: string,
  uploadedById: string,
): Promise<'stored' | 'replaced' | 'kept'> {
  const bytes = fs.readFileSync(file);
  if (!looksLikePdf(bytes)) throw new Error('not a PDF');
  const hash = sha256(bytes);
  const existing = await prisma.attachment.findMany({
    where: { entityType: LEGACY_QUOTE_ENTITY, entityId: legacyQuoteId },
    orderBy: { uploadedAt: 'desc' },
  });

  for (const e of existing) {
    try {
      const full = attachmentPath(e.storedName);
      if (e.size === bytes.length && fs.existsSync(full) && sha256(fs.readFileSync(full)) === hash) {
        for (const other of existing) if (other.id !== e.id) await deleteAttachment(other.id);
        return 'kept';
      }
    } catch {
      /* unreadable old file — replaced below */
    }
  }

  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`;
  fs.writeFileSync(attachmentPath(storedName), bytes);
  await saveAttachment({
    entityType: LEGACY_QUOTE_ENTITY,
    entityId: legacyQuoteId,
    file: {
      originalname: `${number}.pdf`,
      filename: storedName,
      mimetype: 'application/pdf',
      size: bytes.length,
    } as Express.Multer.File,
    uploadedById,
    caption: 'SCORO PDF',
  });
  for (const e of existing) await deleteAttachment(e.id);
  return existing.length ? 'replaced' : 'stored';
}

// ── Continue in G-CORE ───────────────────────────────────────────────────────

export const RECONCILE_NOTE =
  'lines were read from the SCORO PDF and do not add up to its total; check them';

/**
 * Raises a live quotation from an open SCORO quote, under the SAME number, with
 * the lines read from SCORO's PDF as revision 0 (DRAFT). One transaction: the
 * quotation, its revision and lines, the contact if it has to be created, and
 * the archive's one-way link.
 */
export async function continueLegacyQuote(
  legacyQuoteId: string,
  actor: { id: string; name?: string | null },
  req?: Request,
): Promise<{ quotationId: string; number: string }> {
  const lq = await prisma.legacyQuote.findUnique({
    where: { id: legacyQuoteId },
    include: { continuedQuotation: { select: { id: true, number: true } } },
  });
  if (!lq) throw notFound('SCORO quote not found');
  if (lq.continuedQuotation) {
    throw conflict(`Already continued as quotation ${lq.continuedQuotation.number}`);
  }
  if (!isOpenStatus(lq.status)) {
    throw badRequest(`This quote is ${lq.status} in SCORO. Only an open quote can be continued; this one stays as history.`);
  }
  if (!lq.customerId) throw badRequest(MSG_LINK_CUSTOMER);
  const clash = await prisma.quotation.findUnique({ where: { number: lq.number }, select: { id: true } });
  if (clash) throw conflict(`A quotation numbered ${lq.number} already exists in G-CORE`);

  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
  const vatRate = company?.vatRate ?? new Prisma.Decimal(0.12);
  const lines = (Array.isArray(lq.lines) ? lq.lines : []) as unknown as BundleLine[];
  const totals = quoteTotals({ amounts: lines.map((l) => dec(String(l.amount ?? '0'))), discountPct: lq.discountPct, vatRate });

  const notes = [lq.comment?.trim() || null, lq.linesReconcile ? null : RECONCILE_NOTE].filter(Boolean).join(' — ');
  const ownerId = lq.ownerUserId ?? actor.id;
  const customerId = lq.customerId;

  let result: { quotationId: string; number: string };
  try {
    result = await prisma.$transaction(async (tx) => {
      // The person the quote was addressed to, as a contact on the customer.
      let contactId: string | null = null;
      if (lq.contactName?.trim()) {
        const contact = await tx.customerContact.findFirst({
          where: { customerId, name: { equals: lq.contactName.trim(), mode: 'insensitive' } },
          select: { id: true },
        });
        contactId =
          contact?.id ??
          (
            await tx.customerContact.create({
              data: { customerId, name: lq.contactName.trim(), notes: `Added from SCORO quote ${lq.number}` },
              select: { id: true },
            })
          ).id;
      }

      const quotation = await tx.quotation.create({
        data: {
          number: lq.number,
          customerId,
          contactId,
          ownerId,
          subject: lq.name?.trim() || lq.customerName,
          outcome: outcomeFor(lq.status),
          expectedClosing: lq.estimatedClosing,
          revisions: {
            create: [
              {
                revision: 0,
                status: 'DRAFT',
                validityDays: 30,
                notes: notes ? notes.charAt(0).toUpperCase() + notes.slice(1) : null,
                prNumber: lq.prNumber,
                delivery: lq.delivery,
                paymentTerms: lq.paymentTerms,
                vatRate,
                vatInclusive: false,
                discountPct: lq.discountPct,
                discountAmount: totals.discountAmount,
                subtotal: totals.subtotal,
                vatAmount: totals.vatAmount,
                total: totals.total,
                items: {
                  create: lines.map((l, i) => ({
                    title: l.title?.trim() || null,
                    description: l.description?.trim() || l.title?.trim() || '—',
                    quantity: dec(String(l.quantity ?? '1') || '1'),
                    unit: l.unit?.trim() || 'lot',
                    unitPrice: dec(String(l.unitPrice ?? '0')),
                    amount: dec(String(l.amount ?? '0')),
                    sortOrder: i,
                  })),
                },
              },
            ],
          },
        },
        select: { id: true, number: true, revisions: { select: { id: true } } },
      });
      // The one arithmetic every writer of a revision's totals goes through.
      await recalcQuotationRevision(quotation.revisions[0].id, tx);

      // Conditional, so two people pressing the button at once cannot both win.
      const linked = await tx.legacyQuote.updateMany({
        where: { id: lq.id, continuedQuotationId: null },
        data: { continuedQuotationId: quotation.id },
      });
      if (linked.count !== 1) throw conflict('Somebody continued this quote a moment ago');

      await audit(
        {
          entityType: 'quotation',
          entityId: quotation.id,
          action: 'CREATED',
          summary: `Continued from SCORO quote ${lq.number} — ${lines.length} line(s) carried over`,
          actorId: actor.id,
          actorName: actor.name ?? null,
        },
        req,
        tx,
      );
      await audit(
        {
          entityType: LEGACY_QUOTE_ENTITY,
          entityId: lq.id,
          action: 'CONVERTED',
          summary: `Continued in G-CORE as quotation ${quotation.number}`,
          actorId: actor.id,
          actorName: actor.name ?? null,
        },
        req,
        tx,
      );
      return { quotationId: quotation.id, number: quotation.number };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict(`A quotation numbered ${lq.number} already exists, or this quote was just continued`);
    }
    throw err;
  }
  return result;
}
