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
import { billTermsLabel } from '../shared/payables';
import { TEAM_OR_DEPT_SELECT, teamOrDepartment, userTeamWhere } from '../shared/team';
import { RequestStatus } from '@prisma/client';
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

/**
 * The AP Report Generator of the owner's sample: supplier bills falling due
 * in the range (by due date), narrowed by purchaser and supplier — what is
 * owed, what is paid, by month of the due date, by supplier, by purchaser and
 * by terms, then the bills one by one. Drafts and cancelled bills are left
 * out; a bill pending approval is listed but owes nothing yet.
 */
async function payables(range: Range, ctx: ReportContext): Promise<Report> {
  const q = ctx.query;
  const where: Prisma.SupplierBillWhereInput = {
    status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID'] },
    dueDate: { gte: range.from, lte: range.to },
  };
  const words: string[] = [];
  if (q.purchaserId) {
    where.purchaserId = q.purchaserId === 'none' ? null : q.purchaserId;
    words.push(
      q.purchaserId === 'none'
        ? 'no purchaser'
        : `bought by ${(await prisma.user.findUnique({ where: { id: q.purchaserId }, select: { name: true } }))?.name ?? 'someone not on file'}`,
    );
  }
  if (q.supplierId) {
    where.supplierId = q.supplierId;
    words.push((await prisma.supplier.findUnique({ where: { id: q.supplierId }, select: { name: true } }))?.name ?? 'a supplier not on file');
  }
  const today = dayKey(new Date());
  const rows = await prisma.supplierBill.findMany({
    where,
    select: {
      number: true,
      status: true,
      deliveryDate: true,
      billDate: true,
      dueDate: true,
      termsDays: true,
      terms: true,
      netPayable: true,
      amountPaid: true,
      supplier: { select: { name: true } },
      purchaser: { select: { name: true } },
    },
    orderBy: { dueDate: 'asc' },
  });
  type Row = (typeof rows)[number];
  const isOwed = (r: Row) => r.status === 'APPROVED' || r.status === 'PARTIALLY_PAID';
  const left = (r: Row) => (isOwed(r) ? cents(num(r.netPayable) - num(r.amountPaid)) : 0);
  const series = new Series('Falling due by month', [count('Bills'), money('Payable'), money('Paid'), money('Outstanding')], monthsOf(range));
  for (const r of rows) {
    series.add(r.dueDate, 0, 1);
    series.add(r.dueDate, 1, num(r.netPayable));
    series.add(r.dueDate, 2, num(r.amountPaid));
    series.add(r.dueDate, 3, left(r));
  }
  const figures = (r: Row) => [1, num(r.netPayable), left(r)];
  const cols = [count('Bills'), money('Payable'), money('Outstanding')];
  const sum = (fn: (r: Row) => number) => cents(rows.reduce((s, r) => s + fn(r), 0));
  const overdue = rows.filter((r) => isOwed(r) && left(r) > 0 && r.dueDate < today);
  const pending = rows.filter((r) => r.status === 'PENDING_APPROVAL');
  return {
    kind: 'payables',
    title: 'Accounts Payable Summary',
    from: dayOf(range.from),
    to: dayOf(range.to),
    filterLine: words.length ? words.join(' · ') : undefined,
    cards: [
      { label: 'Falling due', value: sum((r) => num(r.netPayable)), money: true, sub: `${rows.length} bill${rows.length === 1 ? '' : 's'} due in the range` },
      { label: 'Outstanding', value: sum(left), money: true },
      { label: 'Paid', value: sum((r) => num(r.amountPaid)), money: true },
      { label: 'Overdue now', value: cents(overdue.reduce((s, r) => s + left(r), 0)), money: true, sub: `${overdue.length} past due` },
      { label: 'Pending approval', value: cents(pending.reduce((s, r) => s + num(r.netPayable), 0)), money: true, sub: `${pending.length} not payable yet` },
    ],
    series: series.done(),
    tables: [
      table('By supplier', [{ label: 'Supplier' }, ...cols], rowsOf(tally(rows, (r) => r.supplier.name, figures), 1)),
      table('By purchaser', [{ label: 'Purchaser / buyer' }, ...cols], rowsOf(tally(rows, (r) => r.purchaser?.name ?? NOBODY, figures), 1)),
      table('By terms', [{ label: 'Terms' }, ...cols], rowsOf(tally(rows, (r) => billTermsLabel(r.termsDays, r.terms), figures), 1)),
      table(
        'The bills',
        [{ label: 'Bill' }, { label: 'Supplier' }, { label: 'Delivered' }, { label: 'Terms' }, { label: 'Due' }, { label: 'Purchaser' }, money('Outstanding')],
        rows
          .slice(0, 100)
          .map((r) => [
            r.number,
            r.supplier.name,
            r.deliveryDate ? formatShortDate(r.deliveryDate) : '—',
            billTermsLabel(r.termsDays, r.terms),
            formatShortDate(r.dueDate),
            r.purchaser?.name ?? '—',
            isOwed(r) ? left(r) : null,
          ]),
      ),
    ],
    notes: [
      'Payable is net of the EWT Gruntech withholds. The terms run from the delivery — the due date is the date of delivery plus the terms. A bill pending approval is listed but owes nothing until approved.',
      ...(rows.length > 100 ? [`The first 100 of ${rows.length} bills are listed one by one; every figure above counts them all.`] : []),
    ],
  };
}

// ── Budget requests and their liquidation (the owner's modules 4 and 5) ─────

/** Requester / team / status filters on budget requests, and their words. */
async function requestFilter(q: Record<string, string | undefined>): Promise<{ where: Prisma.BudgetRequestWhereInput; line: string | undefined }> {
  const and: Prisma.BudgetRequestWhereInput[] = [];
  const words: string[] = [];
  if (q.requestedById) {
    and.push({ requestedById: q.requestedById });
    words.push(`requested by ${(await prisma.user.findUnique({ where: { id: q.requestedById }, select: { name: true } }))?.name ?? 'someone not on file'}`);
  }
  if (q.teamId) {
    and.push({ requestedBy: userTeamWhere(q.teamId) });
    words.push(q.teamId === 'none' ? 'no team' : `team ${(await prisma.industry.findUnique({ where: { id: q.teamId }, select: { code: true } }))?.code ?? '?'}`);
  }
  if (q.status) {
    if (!(q.status in RequestStatus)) throw badRequest(`Status — one of ${Object.keys(RequestStatus).join(', ')}`);
    and.push({ status: q.status as RequestStatus });
    words.push(statusLabel(q.status));
  }
  return { where: and.length ? { AND: and } : {}, line: words.length ? words.join(' · ') : undefined };
}

const REQUEST_REPORT_SELECT = {
  number: true,
  status: true,
  reason: true,
  amount: true,
  amountReleased: true,
  amountSpent: true,
  amountRefunded: true,
  neededBy: true,
  createdAt: true,
  releasedAt: true,
  liquidatedAt: true,
  liquidationDueDate: true,
  job: { select: { number: true, name: true } },
  requestedBy: { select: { name: true, ...TEAM_OR_DEPT_SELECT.select } },
} satisfies Prisma.BudgetRequestSelect;
type RequestRow = Prisma.BudgetRequestGetPayload<{ select: typeof REQUEST_REPORT_SELECT }>;
const APPROVED_ON = ['APPROVED', 'RELEASED', 'REFUND_DUE', 'LIQUIDATED'];
const unitOf = (r: RequestRow) => teamOrDepartment(r.requestedBy)?.label ?? NO_TEAM;

/**
 * The Budget Request Report Generator: the requests NEEDED in the range (a
 * request with no date needed counts on the day it was raised), narrowed by
 * requester, team and status — asked, approved, pending, released — by month,
 * by requester, by team (else department), by project and by status.
 */
async function budgetRequests(range: Range, ctx: ReportContext): Promise<Report> {
  const f = await requestFilter(ctx.query);
  const rows = await prisma.budgetRequest.findMany({
    where: {
      AND: [
        f.where,
        { status: { notIn: ['DRAFT'] } },
        { OR: [{ neededBy: { gte: range.from, lte: range.to } }, { neededBy: null, createdAt: { gte: range.fromAt, lte: range.toAt } }] },
      ],
    },
    select: REQUEST_REPORT_SELECT,
  });
  const when = (r: RequestRow) => r.neededBy ?? r.createdAt;
  const standing = (r: RequestRow) => r.status !== 'REJECTED' && r.status !== 'CANCELLED';
  const series = new Series('Needed by month', [count('Requests'), money('Requested'), money('Approved'), money('Released')], monthsOf(range));
  for (const r of rows.filter(standing)) {
    series.add(when(r), 0, 1);
    series.add(when(r), 1, num(r.amount));
    series.add(when(r), 2, APPROVED_ON.includes(r.status) ? num(r.amount) : 0);
    series.add(when(r), 3, num(r.amountReleased));
  }
  const live = rows.filter(standing);
  const figures = (r: RequestRow) => [1, num(r.amount), num(r.amountReleased)];
  const cols = [count('Requests'), money('Requested'), money('Released')];
  const sum = (xs: RequestRow[], fn: (r: RequestRow) => number) => cents(xs.reduce((s, r) => s + fn(r), 0));
  const pending = live.filter((r) => r.status === 'PENDING_APPROVAL');
  const approved = live.filter((r) => APPROVED_ON.includes(r.status));
  return {
    kind: 'budget-requests',
    title: 'Budget Request Report',
    from: dayOf(range.from),
    to: dayOf(range.to),
    filterLine: f.line,
    cards: [
      { label: 'Sum of all budget requests', value: sum(live, (r) => num(r.amount)), money: true, sub: `${live.length} needed in the range` },
      { label: 'Approved funds', value: sum(approved, (r) => num(r.amount)), money: true, sub: `${approved.length} approved` },
      { label: 'Pending approval', value: sum(pending, (r) => num(r.amount)), money: true, sub: `${pending.length} waiting` },
      { label: 'Released', value: sum(live, (r) => num(r.amountReleased)), money: true },
    ],
    series: series.done(),
    tables: [
      table('By requester', [{ label: 'Requester' }, ...cols], rowsOf(tally(live, (r) => r.requestedBy.name, figures), 1)),
      table('By team', [{ label: 'Team / department' }, ...cols], rowsOf(tally(live, unitOf, figures), 1)),
      table('By project', [{ label: 'Project' }, ...cols], rowsOf(tally(live, (r) => `${r.job.number} — ${r.job.name}`, figures), 1)),
      table('By status', [{ label: 'Status' }, ...cols], rowsOf(tally(rows, (r) => statusLabel(r.status), figures), 1)),
    ],
    notes: ['Drafts are left out; a rejected or cancelled request is counted only under By status. A request with no date needed counts on the day it was raised.'],
  };
}

/**
 * The Liquidation Report Generator: the requests whose cash was RELEASED in
 * the range — released, spent, returned and still owed back — by month of the
 * release, by requester, by team and by project, and the liquidations
 * overdue as of today.
 */
async function liquidations(range: Range, ctx: ReportContext): Promise<Report> {
  const f = await requestFilter(ctx.query);
  const today = dayKey(new Date());
  const rows = await prisma.budgetRequest.findMany({
    where: { AND: [f.where, { status: { in: ['RELEASED', 'REFUND_DUE', 'LIQUIDATED'] }, releasedAt: { gte: range.from, lte: range.to } }] },
    select: REQUEST_REPORT_SELECT,
  });
  const returned = (r: RequestRow) => num(r.amountRefunded);
  const owedBack = (r: RequestRow) => (r.liquidatedAt ? Math.max(0, cents(num(r.amountReleased) - num(r.amountSpent) - num(r.amountRefunded))) : 0);
  const spent = (r: RequestRow) => (r.liquidatedAt ? num(r.amountSpent) : 0);
  const series = new Series('Released by month', [count('Requests'), money('Released'), money('Spent'), money('Returned'), money('Owed back')], monthsOf(range));
  for (const r of rows) {
    const at = r.releasedAt!;
    series.add(at, 0, 1);
    series.add(at, 1, num(r.amountReleased));
    series.add(at, 2, spent(r));
    series.add(at, 3, returned(r));
    series.add(at, 4, owedBack(r));
  }
  const figures = (r: RequestRow) => [1, num(r.amountReleased), spent(r), returned(r)];
  const cols = [count('Requests'), money('Released'), money('Spent'), money('Returned')];
  const sum = (fn: (r: RequestRow) => number) => cents(rows.reduce((s, r) => s + fn(r), 0));
  const overdue = rows.filter((r) => r.status === 'RELEASED' && r.liquidationDueDate && r.liquidationDueDate < today);
  return {
    kind: 'liquidations',
    title: 'Budget Liquidation Report',
    from: dayOf(range.from),
    to: dayOf(range.to),
    filterLine: f.line,
    cards: [
      { label: 'Released', value: sum((r) => num(r.amountReleased)), money: true, sub: `${rows.length} request${rows.length === 1 ? '' : 's'} released in the range` },
      { label: 'Spent', value: sum(spent), money: true, sub: `${rows.filter((r) => r.liquidatedAt).length} liquidated` },
      { label: 'Total excess returned', value: sum(returned), money: true },
      { label: 'Still owed back', value: sum(owedBack), money: true },
      { label: 'Liquidation overdue', value: cents(overdue.reduce((s, r) => s + num(r.amountReleased), 0)), money: true, sub: `${overdue.length} past the deadline` },
    ],
    series: series.done(),
    tables: [
      table('By requester', [{ label: 'Requester' }, ...cols], rowsOf(tally(rows, (r) => r.requestedBy.name, figures), 1)),
      table('By team', [{ label: 'Team / department' }, ...cols], rowsOf(tally(rows, unitOf, figures), 1)),
      table('By project', [{ label: 'Project' }, ...cols], rowsOf(tally(rows, (r) => `${r.job.number} — ${r.job.name}`, figures), 1)),
      table(
        'Liquidations overdue',
        [{ label: 'Request' }, { label: 'Requester' }, { label: 'Liquidate by' }, count('Days late'), money('Released')],
        overdue
          .map((r) => ({ r, late: daysBetween(r.liquidationDueDate!, today) }))
          .sort((a, b) => b.late - a.late)
          .slice(0, 20)
          .map(({ r, late }) => [r.number, r.requestedBy.name, formatShortDate(r.liquidationDueDate!), late, num(r.amountReleased)]),
      ),
    ],
    notes: ['Spent is counted once a liquidation is approved; what was released and not spent comes back as a refund, never as a collection.'],
  };
}

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
  payables,
  'payables-aging': payablesAging,
  'budget-requests': budgetRequests,
  liquidations,
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
    payables: 'gfin.ap.view_all',
    'budget-requests': 'gfin.budget_requests.view_all',
    liquidations: 'gfin.budget_liquidations.view_all',
    'payables-aging': 'gfin.ap.view_all',
    payments: 'gfin.ap.view_all',
  },
});
