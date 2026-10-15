import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { addDays, dayKey, daysBetween } from './day';
import { quotationTeamOf, teamOf } from './team';

/**
 * Accounts Receivable per the owner's sample (2026-10-15): an invoice is
 * COUNTERED when the customer receives it, its terms run from that day, and
 * the expected collection is the day they end. Until it is countered an
 * issued invoice is AWAITING COUNTERING and never overdue — the clock has not
 * started (the owner's call). Each invoice is credited to a salesperson and a
 * team, filled from the document behind it.
 */

/** The terms the form offers as chips; any other number of days may be typed. */
export const TERMS_CHOICES = [15, 30, 45, 60] as const;

/** Statuses on which something is owed — `financePosition`'s receivable. */
export const INVOICE_OWED = ['ISSUED', 'PARTIALLY_PAID'] as const;

/** The expected collection: the countered day (else the invoice date) plus the terms. */
export function expectedCollection(invoiceDate: Date, counteredDate: Date | null, termsDays: number): Date {
  return addDays(counteredDate ?? invoiceDate, termsDays);
}

/** "30 days", "Net 45", "45" → 45; anything unreadable → null. */
export function parseTermsDays(terms: string | null | undefined): number | null {
  const m = terms?.match(/(\d{1,3})/);
  return m ? Number(m[1]) : null;
}

/** "Net 30" — how the terms print. */
export const termsLabel = (days: number | null | undefined, fallback?: string | null): string =>
  days === null || days === undefined ? fallback ?? '—' : days === 0 ? 'Due on receipt' : `Net ${days}`;

/**
 * Whether an invoice is overdue — the one rule for the list, its filter, the
 * aging and the working position: something still owed, countered, and past
 * its expected collection.
 */
export function isOverdue(
  row: { status: string; counteredDate: Date | null; dueDate: Date; outstanding: number },
  today: Date = dayKey(new Date()),
): boolean {
  return (
    (row.status === 'ISSUED' || row.status === 'PARTIALLY_PAID') &&
    row.outstanding > 0.005 &&
    row.counteredDate !== null &&
    row.dueDate < today
  );
}

/** Days late on that rule (0 when it is not overdue). */
export function daysLate(
  row: { status: string; counteredDate: Date | null; dueDate: Date; outstanding: number },
  today: Date = dayKey(new Date()),
): number {
  return isOverdue(row, today) ? daysBetween(row.dueDate, today) : 0;
}

/** The overdue rule as a where-clause (outstanding is checked by the caller's figures). */
export function overdueWhere(today: Date = dayKey(new Date())): Prisma.InvoiceWhereInput {
  return { status: { in: [...INVOICE_OWED] }, counteredDate: { not: null }, dueDate: { lt: today } };
}

/** Issued, nothing said yet about the customer receiving it. */
export const AWAITING_COUNTER_WHERE: Prisma.InvoiceWhereInput = { status: { in: [...INVOICE_OWED] }, counteredDate: null };

const OWNER_TEAM = {
  team: { select: { id: true, code: true, name: true } },
  owner: { select: { id: true, employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } },
} as const;

/**
 * Who sold it and which team is credited, from the document behind an
 * invoice: a sales order (its author, its quotation's team), a project (the
 * owner of the quotation it was won from), a job order (its quotation or
 * sales order, else whoever raised it). Nothing behind it: nobody, unless
 * the form names someone. The team falls back to the salesperson's own.
 */
export async function invoiceCredit(
  source: { salesOrderId?: string | null; jobId?: string | null; jobOrderId?: string | null },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ salespersonId: string | null; teamId: string | null }> {
  const credit: { salespersonId: string | null; teamId: string | null } = { salespersonId: null, teamId: null };
  type Q = { team: { id: string } | null; owner: { id: string; employee: { industry: { id: string } | null } | null } } | null;
  const fromQuotation = (q: Q) => {
    if (!q) return false;
    credit.salespersonId = q.owner.id;
    credit.teamId = quotationTeamOf(q as Parameters<typeof quotationTeamOf>[0])?.id ?? null;
    return true;
  };

  if (source.salesOrderId) {
    // Whoever last asked for this order's invoice is the one credited
    // (2026-10-16, the owner's call: sales personnel and team follow the
    // person who raised the invoice request).
    const asked = await db.invoiceRequest.findFirst({
      where: { salesOrderId: source.salesOrderId, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      select: { salespersonId: true, teamId: true, requestedById: true },
    });
    if (asked) {
      credit.salespersonId = asked.salespersonId ?? asked.requestedById;
      credit.teamId = asked.teamId ?? (await teamOf(credit.salespersonId))?.id ?? null;
      return credit;
    }
  }
  if (source.salesOrderId) {
    const so = await db.salesOrder.findUnique({
      where: { id: source.salesOrderId },
      select: { ownerId: true, quotation: { select: OWNER_TEAM } },
    });
    if (so) {
      fromQuotation(so.quotation);
      credit.salespersonId = so.ownerId;
    }
  }
  if (!credit.salespersonId && source.jobOrderId) {
    const jo = await db.jobOrder.findUnique({
      where: { id: source.jobOrderId },
      select: {
        requestedById: true,
        quotation: { select: OWNER_TEAM },
        salesOrder: { select: { ownerId: true, quotation: { select: OWNER_TEAM } } },
      },
    });
    if (jo && !fromQuotation(jo.quotation) && !fromQuotation(jo.salesOrder?.quotation ?? null)) credit.salespersonId = jo.requestedById;
  }
  if (!credit.salespersonId && source.jobId) {
    const job = await db.job.findUnique({
      where: { id: source.jobId },
      select: { quotationRevision: { select: { quotation: { select: OWNER_TEAM } } } },
    });
    fromQuotation(job?.quotationRevision?.quotation ?? null);
  }
  if (credit.salespersonId && !credit.teamId) credit.teamId = (await teamOf(credit.salespersonId))?.id ?? null;
  return credit;
}

/**
 * Invoices raised before countering existed (2026-10-15) were given their
 * due date from the invoice date, so they are taken as countered on it —
 * every overdue figure reads as it did — and their terms are read back off
 * their dates. Once, marked `seed.invoiceCounteringBackfilled`; a draft is
 * left alone (it is countered once issued and received).
 */
export async function backfillInvoiceCountering(): Promise<number> {
  const MARK = 'seed.invoiceCounteringBackfilled';
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return 0;
  const rows = await prisma.invoice.findMany({
    where: { counteredDate: null, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] } },
    select: { id: true, invoiceDate: true, dueDate: true, termsDays: true },
  });
  let done = 0;
  for (const r of rows) {
    const claimed = await prisma.invoice.updateMany({
      where: { id: r.id, counteredDate: null },
      data: { counteredDate: r.invoiceDate, termsDays: r.termsDays ?? Math.max(0, daysBetween(r.invoiceDate, r.dueDate)) },
    });
    done += claimed.count;
  }
  // Drafts keep no countered day, but their terms are read back too.
  const drafts = await prisma.invoice.findMany({ where: { termsDays: null, status: 'DRAFT' }, select: { id: true, invoiceDate: true, dueDate: true } });
  for (const d of drafts) {
    await prisma.invoice.updateMany({ where: { id: d.id, termsDays: null }, data: { termsDays: Math.max(0, daysBetween(d.invoiceDate, d.dueDate)) } });
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString(), invoices: done } as Prisma.InputJsonValue } });
  if (done) {
    await prisma.auditLog.create({
      data: {
        entityType: 'invoice',
        entityId: 'list',
        action: 'UPDATED',
        summary: `Took ${done} invoice(s) issued before countering existed as countered on their invoice date`,
      },
    });
  }
  return done;
}

/**
 * Invoices with no salesperson take the one their source names — every
 * deploy, only where none is set (a hand-picked salesperson is never moved),
 * claimed on null. One audit row per run that filled any.
 */
export async function fillInvoiceCredit(): Promise<number> {
  const rows = await prisma.invoice.findMany({
    where: { salespersonId: null, status: { not: 'CANCELLED' }, OR: [{ salesOrderId: { not: null } }, { jobId: { not: null } }, { jobOrderId: { not: null } }] },
    select: { id: true, salesOrderId: true, jobId: true, jobOrderId: true, teamId: true },
  });
  let filled = 0;
  for (const r of rows) {
    const credit = await invoiceCredit(r);
    if (!credit.salespersonId) continue;
    const done = await prisma.invoice.updateMany({
      where: { id: r.id, salespersonId: null },
      data: { salespersonId: credit.salespersonId, ...(r.teamId ? {} : { teamId: credit.teamId }) },
    });
    filled += done.count;
  }
  if (filled) {
    await prisma.auditLog.create({
      data: { entityType: 'invoice', entityId: 'list', action: 'UPDATED', summary: `Credited ${filled} invoice(s) to the salesperson and team behind them` },
    });
  }
  return filled;
}
