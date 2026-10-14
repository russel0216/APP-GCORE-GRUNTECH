import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import { authenticate } from '../auth/middleware';
import { type Range } from '../shared/insights';
import { addDays, dayKey, daysBetween } from '../shared/day';
import { statusLabel, formatShortDate } from '../shared/pdf';
import { bucketFor, bucketLabels, claimPayable, financeSettings } from '../shared/finance';
import { termsLabel } from '../shared/receivables';
import { Series, byValue, cents, dayOf, mountReports, monthsOf, num, table, tally, type Col, type Report, type ReportContext } from '../shared/reportKit';

/**
 * G-FIN reports (2026-10-15, the owner's A/R sample: "Create Report" on the
 * list — the aging, the receivables, the collections — and "Forecast
 * Collection"). One report per money-in and money-out menu, over a chosen
 * range (the aging and payables aging as of its last day), each narrowed by
 * salesperson, team or customer where the menu has them, on the same engine
 * as G-CHAIN's (`shared/reportKit.ts`): cards, a series, the breakdowns,
 * `.csv` and `.pdf` twins audited as `finance_report`. Every figure is read
 * off the invoices and payments — nothing kept apart. The receivables rule
 * is A/R's own (`shared/receivables.ts`): outstanding against net
 * collectible, overdue only once countered.
 *
 * `gfin.reports` is READ — `view_all` opens the page; each kind also needs
 * the right of the menu it reports on (A/R's, A/P's), or it is a 403.
 */
export const finReportRoutes = Router();
finReportRoutes.use(authenticate);

const VIEW = 'gfin.reports.view_all';
const OWED = ['ISSUED', 'PARTIALLY_PAID'] as const;
const NOBODY = 'Nobody named';
const NO_TEAM = 'No team';

const money = (label: string): Col => ({ label, money: true });
const count = (label: string): Col => ({ label, align: 'right' });

/** The salesperson / team / customer filters of an A/R report, on invoices, and their words. */
async function invoiceFilter(q: Record<string, string | undefined>): Promise<{ where: Prisma.InvoiceWhereInput; line: string | undefined }> {
  const where: Prisma.InvoiceWhereInput = {};
  const words: string[] = [];
  if (q.salespersonId) {
    where.salespersonId = q.salespersonId === 'none' ? null : q.salespersonId;
    words.push(
      q.salespersonId === 'none'
        ? 'no salesperson'
        : `sold by ${(await prisma.user.findUnique({ where: { id: q.salespersonId }, select: { name: true } }))?.name ?? 'someone not on file'}`,
    );
  }
  if (q.teamId) {
    where.teamId = q.teamId === 'none' ? null : q.teamId;
    words.push(q.teamId === 'none' ? 'no team' : `team ${(await prisma.industry.findUnique({ where: { id: q.teamId }, select: { code: true } }))?.code ?? '?'}`);
  }
  if (q.customerId) {
    where.customerId = q.customerId;
    words.push((await prisma.customer.findUnique({ where: { id: q.customerId }, select: { name: true } }))?.name ?? 'a customer not on file');
  }
  return { where, line: words.length ? words.join(' · ') : undefined };
}

const INVOICE_REPORT_SELECT = {
  id: true,
  number: true,
  status: true,
  invoiceDate: true,
  counteredDate: true,
  dueDate: true,
  termsDays: true,
  terms: true,
  invoiceTotal: true,
  netCollectible: true,
  amountCollected: true,
  ewtAmount: true,
  ewtCertificateNo: true,
  customer: { select: { id: true, name: true } },
  salesperson: { select: { name: true } },
  team: { select: { code: true } },
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_REPORT_SELECT }>;

const outstandingOf = (r: InvoiceRow) => cents(num(r.netCollectible) - num(r.amountCollected));
const owed = (r: InvoiceRow) => (OWED as readonly string[]).includes(r.status);
const personOf = (r: InvoiceRow) => r.salesperson?.name ?? NOBODY;
const teamCodeOf = (r: InvoiceRow) => r.team?.code ?? NO_TEAM;
const termsOf = (r: InvoiceRow) => termsLabel(r.termsDays, r.terms);

/** "By …" rows: the key, then its figures, the largest first. */
const rowsOf = (m: Map<string, number[]>, col: number, top = 15) => byValue(m, col, top).map(([k, v]) => [k, ...v]);

// ── Accounts Receivable ──────────────────────────────────────────────────────

async function receivables(range: Range, ctx: ReportContext): Promise<Report> {
  const f = await invoiceFilter(ctx.query);
  const today = dayKey(new Date());
  const rows = await prisma.invoice.findMany({
    where: { AND: [f.where, { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] }, invoiceDate: { gte: range.from, lte: range.to } }] },
    select: INVOICE_REPORT_SELECT,
  });
  const series = new Series(
    'Invoiced by month',
    [count('Invoices'), money('Invoiced'), money('Net collectible'), money('Collected'), money('Outstanding')],
    monthsOf(range),
  );
  for (const r of rows) {
    series.add(r.invoiceDate, 0, 1);
    series.add(r.invoiceDate, 1, num(r.invoiceTotal));
    series.add(r.invoiceDate, 2, num(r.netCollectible));
    series.add(r.invoiceDate, 3, num(r.amountCollected));
    series.add(r.invoiceDate, 4, owed(r) ? outstandingOf(r) : 0);
  }
  const sum = (fn: (r: InvoiceRow) => number) => cents(rows.reduce((s, r) => s + fn(r), 0));
  const overdue = rows.filter((r) => owed(r) && r.counteredDate && r.dueDate < today);
  const figures = (r: InvoiceRow) => [1, num(r.invoiceTotal), num(r.amountCollected), owed(r) ? outstandingOf(r) : 0];
  const cols = [count('Invoices'), money('Invoiced'), money('Collected'), money('Outstanding')];
  return {
    kind: 'receivables',
    title: 'Receivables Report',
    from: dayOf(range.from),
    to: dayOf(range.to),
    filterLine: f.line,
    cards: [
      { label: 'Invoiced', value: sum((r) => num(r.invoiceTotal)), money: true, sub: `${rows.length} invoice${rows.length === 1 ? '' : 's'} dated in the range` },
      { label: 'Net collectible', value: sum((r) => num(r.netCollectible)), money: true, sub: 'after the EWT withheld' },
      { label: 'Collected', value: sum((r) => num(r.amountCollected)), money: true },
      { label: 'Outstanding', value: sum((r) => (owed(r) ? outstandingOf(r) : 0)), money: true },
      { label: 'Overdue now', value: cents(overdue.reduce((s, r) => s + outstandingOf(r), 0)), money: true, sub: `${overdue.length} countered and past due` },
    ],
    series: series.done(),
    tables: [
      table('By customer', [{ label: 'Customer' }, ...cols], rowsOf(tally(rows, (r) => r.customer.name, figures), 3)),
      table('By sales personnel', [{ label: 'Sales personnel' }, ...cols], rowsOf(tally(rows, personOf, figures), 1)),
      table('By team', [{ label: 'Team' }, ...cols], rowsOf(tally(rows, teamCodeOf, figures), 1)),
      table('By payment terms', [{ label: 'Terms' }, ...cols], rowsOf(tally(rows, termsOf, figures), 1)),
    ],
    notes: ['Outstanding is measured against net collectible — the EWT the customer withholds comes back as a BIR 2307, never as cash. Draft and cancelled invoices are left out.'],
  };
}

async function aging(range: Range, ctx: ReportContext): Promise<Report> {
  const f = await invoiceFilter(ctx.query);
  const asOf = range.to;
  const settings = await financeSettings();
  const labels = ['Awaiting countering', ...bucketLabels(settings.agingBuckets)];
  const rows = (
    await prisma.invoice.findMany({
      where: { AND: [f.where, { status: { in: [...OWED] }, invoiceDate: { lte: asOf } }] },
      select: INVOICE_REPORT_SELECT,
      orderBy: { dueDate: 'asc' },
    })
  ).filter((r) => outstandingOf(r) > 0.005);
  // Not countered: its terms have not started — never overdue (the owner's call).
  const bucketOf = (r: InvoiceRow) => (r.counteredDate ? bucketFor(daysBetween(r.dueDate, asOf), settings.agingBuckets) : labels[0]);
  const spread = (r: InvoiceRow) => labels.map((l) => (bucketOf(r) === l ? outstandingOf(r) : 0));
  const byAge = labels.map((l) => {
    const inIt = rows.filter((r) => bucketOf(r) === l);
    return { label: l, values: [inIt.length, cents(inIt.reduce((s, r) => s + outstandingOf(r), 0))] };
  });
  const total = cents(rows.reduce((s, r) => s + outstandingOf(r), 0));
  const overdue = rows.filter((r) => r.counteredDate && daysBetween(r.dueDate, asOf) > 0);
  const awaiting = rows.filter((r) => !r.counteredDate);
  const ageCols: Col[] = [...labels.map((l) => money(l)), money('Total')];
  const ageRows = (m: Map<string, number[]>, top = 20) => rowsOf(new Map([...m].map(([k, v]) => [k, [...v, v.reduce((s, x) => s + x, 0)]])), labels.length, top);
  return {
    kind: 'aging',
    title: 'Receivables Aging',
    from: dayOf(asOf),
    to: dayOf(asOf),
    filterLine: f.line,
    cards: [
      { label: 'Outstanding', value: total, money: true, sub: `${rows.length} open invoice${rows.length === 1 ? '' : 's'}` },
      { label: 'Overdue', value: cents(overdue.reduce((s, r) => s + outstandingOf(r), 0)), money: true, sub: `${overdue.length} countered and past due` },
      { label: 'Awaiting countering', value: cents(awaiting.reduce((s, r) => s + outstandingOf(r), 0)), money: true, sub: `${awaiting.length} not yet received` },
      {
        label: 'EWT awaiting BIR 2307',
        value: cents(rows.filter((r) => !r.ewtCertificateNo).reduce((s, r) => s + num(r.ewtAmount), 0)),
        money: true,
        sub: 'a tax credit, never overdue',
      },
    ],
    series: { title: 'By age', head: 'Age', columns: [count('Invoices'), money('Outstanding')], rows: byAge },
    tables: [
      table('By customer', [{ label: 'Customer' }, ...ageCols], ageRows(tally(rows, (r) => r.customer.name, spread))),
      table('By sales personnel', [{ label: 'Sales personnel' }, ...ageCols], ageRows(tally(rows, personOf, spread))),
      table('By team', [{ label: 'Team' }, ...ageCols], ageRows(tally(rows, teamCodeOf, spread))),
      table(
        'Most overdue',
        [{ label: 'SI No.' }, { label: 'Customer' }, { label: 'Expected' }, count('Days late'), { label: 'Sales personnel' }, money('Outstanding')],
        overdue
          .map((r) => ({ r, late: daysBetween(r.dueDate, asOf) }))
          .sort((a, b) => b.late - a.late)
          .slice(0, 20)
          .map(({ r, late }) => [r.number, r.customer.name, formatShortDate(r.dueDate), late, personOf(r), outstandingOf(r)]),
      ),
    ],
    notes: [
      `As of ${dayOf(asOf)}: the age is the days past the expected collection (countered day plus terms). An invoice not yet countered is aged apart and is never overdue. Outstanding is what is owed today against net collectible.`,
    ],
  };
}

/** Monday-start weeks over a window, as keys and labels ("Oct 12 – 18"). */
function weeksOf(from: Date, to: Date): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const short = (d: Date) => d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  for (let d = mondayOf(from); d <= to && out.length < 120; d = addDays(d, 7)) {
    out.push({ key: dayOf(d), label: `${short(d)} – ${short(addDays(d, 6))}` });
  }
  return out;
}
function mondayOf(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

async function collectionForecast(_range: Range, ctx: ReportContext): Promise<Report> {
  const f = await invoiceFilter(ctx.query);
  const today = dayKey(new Date());
  // A forecast looks forward: with no dates given, the next ninety days.
  const from = ctx.query.from ? _range.from : today;
  const to = ctx.query.to ? _range.to : addDays(today, 89);
  const by = ctx.query.by ?? 'month';
  if (by !== 'week' && by !== 'month') throw badRequest('By is week or month');
  const rows = (await prisma.invoice.findMany({ where: { AND: [f.where, { status: { in: [...OWED] } }] }, select: INVOICE_REPORT_SELECT })).filter(
    (r) => outstandingOf(r) > 0.005,
  );
  // Countered: its expected collection. Awaiting countering: as if countered
  // today — its terms from today (never sooner than the invoice date).
  const expectedOf = (r: InvoiceRow) =>
    r.counteredDate ? r.dueDate : addDays(r.invoiceDate > today ? r.invoiceDate : today, r.termsDays ?? Math.max(0, daysBetween(r.invoiceDate, r.dueDate)));
  const pastDue = rows.filter((r) => r.counteredDate && r.dueDate < today);
  const inWindow = rows.filter((r) => !pastDue.includes(r) && expectedOf(r) >= from && expectedOf(r) <= to);
  const later = rows.filter((r) => !pastDue.includes(r) && expectedOf(r) > to);
  const periods = by === 'week' ? weeksOf(from, to) : monthsOf({ ...ctx.range, from, to });
  const series = new Series(
    by === 'week' ? 'Expected collection by week' : 'Expected collection by month',
    [count('Invoices'), money('Countered'), money('Awaiting countering'), money('Total')],
    periods,
    by === 'week' ? (d) => dayOf(mondayOf(d)) : undefined,
    by === 'week' ? 'Week' : 'Month',
  );
  for (const r of inWindow) {
    const at = expectedOf(r);
    series.add(at, 0, 1);
    series.add(at, r.counteredDate ? 1 : 2, outstandingOf(r));
    series.add(at, 3, outstandingOf(r));
  }
  const figures = (r: InvoiceRow) => [1, r.counteredDate ? outstandingOf(r) : 0, r.counteredDate ? 0 : outstandingOf(r), outstandingOf(r)];
  const cols = [count('Invoices'), money('Countered'), money('Awaiting countering'), money('In the window')];
  const sum = (list: InvoiceRow[]) => cents(list.reduce((s, r) => s + outstandingOf(r), 0));
  return {
    kind: 'collection-forecast',
    title: 'Collection Forecast',
    from: dayOf(from),
    to: dayOf(to),
    filterLine: f.line,
    cards: [
      { label: 'Expected in the window', value: sum(inWindow), money: true, sub: `${inWindow.length} invoice${inWindow.length === 1 ? '' : 's'}` },
      { label: 'Of which awaiting countering', value: sum(inWindow.filter((r) => !r.counteredDate)), money: true, sub: 'counted as if countered today' },
      { label: 'Already past due', value: sum(pastDue), money: true, sub: `${pastDue.length} countered and overdue — chase now` },
      { label: 'After the window', value: sum(later), money: true, sub: `${later.length} invoice${later.length === 1 ? '' : 's'}` },
    ],
    series: series.done(),
    tables: [
      table('By sales personnel', [{ label: 'Sales personnel' }, ...cols], rowsOf(tally(inWindow, personOf, figures), 3)),
      table('By team', [{ label: 'Team' }, ...cols], rowsOf(tally(inWindow, teamCodeOf, figures), 3)),
      table('By customer', [{ label: 'Customer' }, ...cols], rowsOf(tally(inWindow, (r) => r.customer.name, figures), 3)),
      table('By payment terms', [{ label: 'Terms' }, ...cols], rowsOf(tally(inWindow, termsOf, figures), 3)),
    ],
    notes: [
      'Calculated inflow: the countered day plus the terms. An invoice not yet countered is placed as if countered today. Past-due invoices are not in the window — they are owed already.',
    ],
  };
}

async function collections(range: Range, ctx: ReportContext): Promise<Report> {
  const f = await invoiceFilter(ctx.query);
  const creditWhere: Prisma.InvoiceWhereInput = { ...(f.where.salespersonId !== undefined ? { salespersonId: f.where.salespersonId } : {}), ...(f.where.teamId !== undefined ? { teamId: f.where.teamId } : {}) };
  const allocations = await prisma.paymentAllocation.findMany({
    where: {
      invoiceId: { not: null },
      invoice: creditWhere,
      payment: { kind: 'RECEIPT', paymentDate: { gte: range.from, lte: range.to }, ...(f.where.customerId ? { customerId: f.where.customerId as string } : {}) },
    },
    select: {
      amount: true,
      payment: { select: { id: true, number: true, paymentDate: true, method: true, clearedAt: true, customer: { select: { name: true } } } },
      invoice: { select: { counteredDate: true, invoiceDate: true, salesperson: { select: { name: true } }, team: { select: { code: true } } } },
    },
  });
  const series = new Series('Collected by month', [count('Collections'), money('Collected'), money('Cleared'), money('Uncleared')], monthsOf(range));
  const seen = new Set<string>();
  for (const a of allocations) {
    const at = a.payment.paymentDate;
    if (!seen.has(a.payment.id)) {
      seen.add(a.payment.id);
      series.add(at, 0, 1);
    }
    series.add(at, 1, num(a.amount));
    series.add(at, a.payment.clearedAt ? 2 : 3, num(a.amount));
  }
  const total = cents(allocations.reduce((s, a) => s + num(a.amount), 0));
  const uncleared = cents(allocations.filter((a) => !a.payment.clearedAt).reduce((s, a) => s + num(a.amount), 0));
  // Days from the customer having the invoice to the money, weighted by the money.
  let weighted = 0;
  for (const a of allocations) weighted += num(a.amount) * Math.max(0, daysBetween(a.invoice?.counteredDate ?? a.invoice?.invoiceDate ?? a.payment.paymentDate, a.payment.paymentDate));
  const figures = (a: (typeof allocations)[number]) => [num(a.amount), a.payment.clearedAt ? 0 : num(a.amount)];
  const cols = [money('Collected'), money('Uncleared')];
  return {
    kind: 'collections',
    title: 'Collections Report',
    from: dayOf(range.from),
    to: dayOf(range.to),
    filterLine: f.line,
    cards: [
      { label: 'Total collections', value: total, money: true, sub: `${seen.size} collection${seen.size === 1 ? '' : 's'}` },
      { label: 'Cleared', value: cents(total - uncleared), money: true },
      { label: 'Uncleared cheques', value: uncleared, money: true, sub: 'not cash until they clear' },
      { label: 'Days to collect', value: total > 0 ? Math.round(weighted / total) : 0, sub: 'from countered to paid, weighted by amount' },
    ],
    series: series.done(),
    tables: [
      table('By customer', [{ label: 'Customer' }, ...cols], rowsOf(tally(allocations, (a) => a.payment.customer?.name ?? '—', figures), 0)),
      table('By sales personnel', [{ label: 'Sales personnel' }, ...cols], rowsOf(tally(allocations, (a) => a.invoice?.salesperson?.name ?? NOBODY, figures), 0)),
      table('By team', [{ label: 'Team' }, ...cols], rowsOf(tally(allocations, (a) => a.invoice?.team?.code ?? NO_TEAM, figures), 0)),
      table('By method', [{ label: 'Method' }, ...cols], rowsOf(tally(allocations, (a) => statusLabel(a.payment.method), figures), 0)),
    ],
    notes: ['Customer collections only — unspent cash returned on an advance or a budget request is money in, never a collection. A collection settling several invoices is credited to each by the amount applied.'],
  };
}

// ── Accounts Payable ─────────────────────────────────────────────────────────

async function payablesAging(range: Range): Promise<Report> {
  const asOf = range.to;
  const settings = await financeSettings();
  const labels = bucketLabels(settings.agingBuckets);
  const [bills, claims, advances] = await Promise.all([
    prisma.supplierBill.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, billDate: { lte: asOf } },
      select: { number: true, dueDate: true, netPayable: true, amountPaid: true, supplier: { select: { name: true } } },
    }),
    prisma.expenseClaim.findMany({
      where: { status: 'APPROVED' },
      select: { number: true, total: true, amountPaid: true, claimedBy: { select: { name: true } }, advance: { select: { amountReleased: true } }, budgetRequest: { select: { amountReleased: true } } },
    }),
    prisma.cashAdvance.findMany({
      where: { status: 'RELEASED' },
      select: { number: true, amountReleased: true, liquidationDueDate: true, requestedBy: { select: { name: true } } },
    }),
  ]);
  const open = bills.map((b) => ({ ...b, outstanding: cents(num(b.netPayable) - num(b.amountPaid)) })).filter((b) => b.outstanding > 0.005);
  const bucketOf = (b: (typeof open)[number]) => bucketFor(daysBetween(b.dueDate, asOf), settings.agingBuckets);
  const spread = (b: (typeof open)[number]) => labels.map((l) => (bucketOf(b) === l ? b.outstanding : 0));
  const total = cents(open.reduce((s, b) => s + b.outstanding, 0));
  const overdue = cents(open.filter((b) => daysBetween(b.dueDate, asOf) > 0).reduce((s, b) => s + b.outstanding, 0));
  const unreimbursed = claims
    .map((c) => ({ ...c, owed: cents(claimPayable(c as Parameters<typeof claimPayable>[0]) - num(c.amountPaid)) }))
    .filter((c) => c.owed > 0.005);
  const bySupplier = tally(open, (b) => b.supplier.name, spread);
  return {
    kind: 'payables-aging',
    title: 'Payables Aging',
    from: dayOf(asOf),
    to: dayOf(asOf),
    cards: [
      { label: 'Payable', value: total, money: true, sub: `${open.length} open bill${open.length === 1 ? '' : 's'}` },
      { label: 'Overdue', value: overdue, money: true },
      { label: 'Claims to reimburse', value: cents(unreimbursed.reduce((s, c) => s + c.owed, 0)), money: true, sub: `${unreimbursed.length} approved` },
      { label: 'Advances not liquidated', value: cents(advances.reduce((s, a) => s + num(a.amountReleased), 0)), money: true, sub: `${advances.length} released` },
    ],
    series: {
      title: 'By age',
      head: 'Age',
      columns: [count('Bills'), money('Payable')],
      rows: labels.map((l) => {
        const inIt = open.filter((b) => bucketOf(b) === l);
        return { label: l, values: [inIt.length, cents(inIt.reduce((s, b) => s + b.outstanding, 0))] };
      }),
    },
    tables: [
      table(
        'By supplier',
        [{ label: 'Supplier' }, ...labels.map((l) => money(l)), money('Total')],
        rowsOf(new Map([...bySupplier].map(([k, v]) => [k, [...v, v.reduce((s, x) => s + x, 0)]])), labels.length, 20),
      ),
      table(
        'Expense claims to reimburse',
        [{ label: 'Claim' }, { label: 'Person' }, money('Owed')],
        unreimbursed.sort((a, b) => b.owed - a.owed).slice(0, 20).map((c) => [c.number, c.claimedBy.name, c.owed]),
      ),
      table(
        'Cash advances to liquidate',
        [{ label: 'Advance' }, { label: 'Person' }, { label: 'Liquidate by' }, count('Days late'), money('Released')],
        advances
          .map((a) => ({ a, late: a.liquidationDueDate ? Math.max(0, daysBetween(a.liquidationDueDate, asOf)) : 0 }))
          .sort((x, y) => y.late - x.late)
          .slice(0, 20)
          .map(({ a, late }) => [a.number, a.requestedBy.name, a.liquidationDueDate ? formatShortDate(a.liquidationDueDate) : '—', late, num(a.amountReleased)]),
      ),
    ],
    notes: [`As of ${dayOf(asOf)}: payable is net of the EWT Gruntech withholds. An advance is not a payable — the company is the creditor — but it is money that has stopped moving.`],
  };
}

async function paymentsOut(range: Range): Promise<Report> {
  const allocations = await prisma.paymentAllocation.findMany({
    where: { payment: { kind: 'DISBURSEMENT', paymentDate: { gte: range.from, lte: range.to } } },
    select: {
      amount: true,
      billId: true,
      claimId: true,
      advanceId: true,
      budgetRequestId: true,
      payment: { select: { id: true, paymentDate: true, method: true, clearedAt: true, supplier: { select: { name: true } }, payeeUser: { select: { name: true } } } },
    },
  });
  const kindOf = (a: (typeof allocations)[number]) =>
    a.billId ? 'Supplier bills' : a.claimId ? 'Expense claims' : a.advanceId ? 'Cash advances' : a.budgetRequestId ? 'Budget requests' : 'Other';
  const series = new Series('Paid out by month', [count('Payments'), money('Paid out'), money('Uncleared')], monthsOf(range));
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!seen.has(a.payment.id)) {
      seen.add(a.payment.id);
      series.add(a.payment.paymentDate, 0, 1);
    }
    series.add(a.payment.paymentDate, 1, num(a.amount));
    if (!a.payment.clearedAt) series.add(a.payment.paymentDate, 2, num(a.amount));
  }
  const total = cents(allocations.reduce((s, a) => s + num(a.amount), 0));
  const figures = (a: (typeof allocations)[number]) => [num(a.amount)];
  return {
    kind: 'payments',
    title: 'Payments Out',
    from: dayOf(range.from),
    to: dayOf(range.to),
    cards: [
      { label: 'Paid out', value: total, money: true, sub: `${seen.size} payment${seen.size === 1 ? '' : 's'}` },
      { label: 'To suppliers', value: cents(allocations.filter((a) => a.billId).reduce((s, a) => s + num(a.amount), 0)), money: true },
      { label: 'To people', value: cents(allocations.filter((a) => !a.billId).reduce((s, a) => s + num(a.amount), 0)), money: true, sub: 'claims, advances, budget requests' },
    ],
    series: series.done(),
    tables: [
      table('By payee', [{ label: 'Payee' }, money('Paid out')], rowsOf(tally(allocations, (a) => a.payment.supplier?.name ?? a.payment.payeeUser?.name ?? '—', figures), 0)),
      table('By what it settled', [{ label: 'Settles' }, money('Paid out')], rowsOf(tally(allocations, kindOf, figures), 0)),
      table('By method', [{ label: 'Method' }, money('Paid out')], rowsOf(tally(allocations, (a) => statusLabel(a.payment.method), figures), 0)),
    ],
  };
}

const KINDS = {
  receivables,
  aging,
  'collection-forecast': collectionForecast,
  collections,
  'payables-aging': payablesAging,
  payments: paymentsOut,
};
export const FIN_REPORT_KINDS = Object.keys(KINDS);

mountReports(finReportRoutes, {
  view: VIEW,
  auditType: 'finance_report',
  kinds: KINDS,
  rights: {
    receivables: 'gfin.ar.view_all',
    aging: 'gfin.ar.view_all',
    'collection-forecast': 'gfin.ar.view_all',
    collections: 'gfin.ar.view_all',
    'payables-aging': 'gfin.ap.view_all',
    payments: 'gfin.ap.view_all',
  },
});
