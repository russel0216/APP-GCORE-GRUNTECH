import { Router } from 'express';
import type { Request, Response } from 'express';

import { prisma } from '../prisma';
import { handler, badRequest } from '../http/kit';
import { authenticate, require_ } from '../auth/middleware';
import { audit } from '../shared/audit';
import {
  cents,
  num,
  pct,
  dayKey,
  monthKey,
  monthsBack,
  parseRange,
  projectProfitability,
  median,
  slowMovers,
  toCsv,
  FORECAST_WINDOWS,
  windowFor,
  type ForecastBucket,
  type SalesPerson,
} from '../shared/insights';

/**
 * Insights — the reporting layer (Phase 9).
 *
 * Every route here is READ ONLY and every figure comes from documents the
 * other phases record. Nothing in this file writes a business record, and it
 * must stay that way: the moment a report keeps its own copy of a number, it
 * acquires the ability to disagree with the document it came from.
 *
 * Each report has a `.csv` twin, because "management answers questions without
 * exporting to Excel" is about not having to rebuild the answer by hand — not
 * about never sending a figure to anybody.
 */

export const insightRoutes = Router();
insightRoutes.use(authenticate);

/** Sends a CSV as a download, and records that it left the building. */
async function sendCsv(
  req: Request,
  res: Response,
  name: string,
  header: string[],
  rows: (string | number | null | undefined)[][],
) {
  // Recorded BEFORE the bytes go out, not after. An export that failed to be
  // logged should not have happened — management figures leaving the building
  // is exactly the kind of thing an audit trail is for.
  await audit(
    {
      entityType: 'insights',
      entityId: name,
      action: 'EXPORTED',
      summary: `${name} exported (${rows.length} rows)`,
    },
    req,
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(toCsv(header, rows));
}

const money = (n: number) => n.toFixed(2);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '');

// ════════════════════════════════════════════════════════════════════
//  COMPANY OVERVIEW
// ════════════════════════════════════════════════════════════════════

/**
 * The one screen a director opens.
 *
 * Deliberately five numbers per division rather than fifty: a dashboard that
 * shows everything is read as wallpaper. Each figure links to the list behind
 * it, so the next question is one click away rather than an export.
 */
insightRoutes.get(
  '/dashboard',
  require_('insights.dashboard.view_all'),
  handler(async (req, res) => {
    const range = parseRange(req.query.from as string, req.query.to as string);
    const today = dayKey(new Date());
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    const [
      pipelineOpen,
      quotationsWon,
      quotationsLost,
      activeJobs,
      jobsDelivered,
      ledger,
      billedAgg,
      invoicesOpen,
      billsOpen,
      collectedThisMonth,
      collectedInRange,
      stockValue,
      contractsActive,
      visitsOverdue,
      pendingApprovals,
      headcount,
    ] = await Promise.all([
      prisma.quotation.findMany({
        where: { outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION'] } },
        select: {
          probability: true,
          // Every revision, because the value of a quotation is its latest
          // APPROVED revision and — where none has been approved yet — its
          // latest. Counting only approved ones would show an open quotation
          // as worth nothing, and would disagree with Sales Analytics, which
          // is the one thing this module must never do.
          revisions: { select: { total: true, status: true }, orderBy: { revision: 'desc' } },
        },
      }),
      prisma.quotation.count({ where: { outcome: 'WON', decidedAt: { gte: range.from, lte: range.to } } }),
      prisma.quotation.count({ where: { outcome: 'LOST', decidedAt: { gte: range.from, lte: range.to } } }),
      prisma.job.count({ where: { status: { in: ['PLANNING', 'IN_PROGRESS'] } } }),
      prisma.job.count({
        where: { status: { in: ['COMPLETED', 'TURNED_OVER'] }, actualEndDate: { gte: range.from, lte: range.to } },
      }),
      prisma.jobCostEntry.groupBy({
        by: ['state'],
        where: { job: { status: { notIn: ['CANCELLED'] } } },
        _sum: { amount: true },
      }),
      prisma.progressBilling.aggregate({
        where: { status: { in: ['APPROVED', 'INVOICED'] }, billingDate: { gte: range.from, lte: range.to } },
        _sum: { grossAmount: true },
      }),
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { netCollectible: true, amountCollected: true, dueDate: true },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        select: { netPayable: true, amountPaid: true, dueDate: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', clearedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', clearedAt: { gte: range.from, lte: range.to } },
        _sum: { amount: true },
      }),
      prisma.inventoryBalance.findMany({
        where: { quantity: { gt: 0 } },
        select: { quantity: true, averageCost: true },
      }),
      prisma.serviceContract.count({ where: { status: 'ACTIVE' } }),
      prisma.serviceVisit.count({ where: { status: 'SCHEDULED', dueDate: { lte: today } } }),
      prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
      prisma.employee.count({ where: { isActive: true } }),
    ]);

    const state = (s: string) => num(ledger.find((l) => l.state === s)?._sum.amount);
    const receivable = cents(
      invoicesOpen.reduce((sum, i) => sum + (num(i.netCollectible) - num(i.amountCollected)), 0),
    );
    const receivableOverdue = cents(
      invoicesOpen
        .filter((i) => i.dueDate < today)
        .reduce((sum, i) => sum + (num(i.netCollectible) - num(i.amountCollected)), 0),
    );
    const payable = cents(
      billsOpen.reduce((sum, b) => sum + (num(b.netPayable) - num(b.amountPaid)), 0),
    );

    // Weighted by the salesperson's own read on the chance of award — the
    // honest way to total a pipeline, and the only figure anybody should plan
    // against.
    const quotedValue = (q: (typeof pipelineOpen)[number]) =>
      num((q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0])?.total);

    const weightedPipeline = cents(
      pipelineOpen.reduce((sum, q) => sum + quotedValue(q) * (q.probability / 100), 0),
    );
    const openPipeline = cents(pipelineOpen.reduce((sum, q) => sum + quotedValue(q), 0));

    const decided = quotationsWon + quotationsLost;

    res.json({
      range,
      sales: {
        openQuotations: pipelineOpen.length,
        openPipeline,
        weightedPipeline,
        won: quotationsWon,
        lost: quotationsLost,
        winRatePct: pct(quotationsWon, decided),
      },
      delivery: {
        activeJobs,
        jobsDelivered,
        budgeted: state('BUDGETED'),
        committed: state('COMMITTED'),
        incurred: state('INCURRED'),
        // Available across every live job. Negative means the company as a
        // whole has committed more than it budgeted.
        available: cents(state('BUDGETED') - state('COMMITTED') - state('INCURRED')),
        billedInRange: num(billedAgg._sum.grossAmount),
      },
      finance: {
        receivable,
        receivableOverdue,
        payable,
        collectedThisMonth: cents(num(collectedThisMonth._sum.amount)),
        collectedInRange: cents(num(collectedInRange._sum.amount)),
        workingPosition: cents(receivable - payable),
      },
      chain: {
        stockValue: cents(
          stockValue.reduce((sum, b) => sum + num(b.quantity) * num(b.averageCost), 0),
        ),
        stockLines: stockValue.length,
      },
      aftermarket: { contractsActive, visitsOverdue },
      people: { headcount, pendingApprovals },
    });
  }),
);

/**
 * Twelve months of the four numbers a trend is worth drawing for.
 *
 * Billed and collected side by side is the point: the gap between them is the
 * working capital the company is lending its customers.
 */
insightRoutes.get(
  '/trend',
  require_('insights.dashboard.view_all'),
  handler(async (req, res) => {
    const months = Math.min(36, Math.max(3, Number(req.query.months ?? 12)));
    const keys = monthsBack(months);
    const start = new Date(`${keys[0]}-01T00:00:00.000Z`);

    const [billings, receipts, incurred, quotations] = await Promise.all([
      prisma.progressBilling.findMany({
        where: { status: { in: ['APPROVED', 'INVOICED'] }, billingDate: { gte: start } },
        select: { billingDate: true, grossAmount: true },
      }),
      prisma.payment.findMany({
        where: { kind: 'RECEIPT', clearedAt: { gte: start } },
        select: { clearedAt: true, amount: true },
      }),
      prisma.jobCostEntry.findMany({
        // occurredAt, not createdAt: a cost entered late still belongs to the
        // month the work happened in, and a trend built on entry dates shows
        // the bookkeeping rather than the business.
        where: { state: 'INCURRED', occurredAt: { gte: start } },
        select: { occurredAt: true, amount: true },
      }),
      prisma.quotation.findMany({
        where: { outcome: 'WON', decidedAt: { gte: start } },
        select: {
          decidedAt: true,
          revisions: { select: { total: true, status: true }, orderBy: { revision: 'desc' } },
        },
      }),
    ]);

    const empty = () => Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number>;
    const billed = empty();
    const collected = empty();
    const cost = empty();
    const won = empty();

    for (const b of billings) {
      const k = monthKey(b.billingDate);
      if (k in billed) billed[k] = cents(billed[k] + num(b.grossAmount));
    }
    for (const p of receipts) {
      const k = monthKey(p.clearedAt!);
      if (k in collected) collected[k] = cents(collected[k] + num(p.amount));
    }
    for (const c of incurred) {
      const k = monthKey(c.occurredAt);
      if (k in cost) cost[k] = cents(cost[k] + num(c.amount));
    }
    for (const q of quotations) {
      const k = monthKey(q.decidedAt!);
      const value = num((q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0])?.total);
      if (k in won) won[k] = cents(won[k] + value);
    }

    res.json({
      months: keys.map((month) => ({
        month,
        billed: billed[month],
        collected: collected[month],
        incurred: cost[month],
        won: won[month],
      })),
    });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PROJECT PROFITABILITY
// ════════════════════════════════════════════════════════════════════

insightRoutes.get(
  '/profitability',
  require_('insights.profitability.view_all'),
  handler(async (req, res) => {
    const rows = await projectProfitability({
      type: (req.query.type as 'PROJECT' | 'SERVICE_CONTRACT') || undefined,
      status: (req.query.status as string) || undefined,
      customerId: (req.query.customerId as string) || undefined,
    });

    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      cents(rows.reduce((s, r) => s + pick(r), 0));

    const contractValue = sum((r) => r.contractValue);
    const budgetedCost = sum((r) => r.budgetedCost);
    const actualCost = sum((r) => r.actualCost);

    res.json({
      rows,
      totals: {
        jobs: rows.length,
        contractValue,
        budgetedCost,
        actualCost,
        billed: sum((r) => r.billed),
        collected: sum((r) => r.collected),
        expectedProfit: cents(contractValue - budgetedCost),
        expectedMarginPct: pct(contractValue - budgetedCost, contractValue),
      },
      // The two lists worth acting on, rather than making somebody sort.
      watchlist: {
        overspending: rows.filter((r) => r.overspending).map((r) => r.job.number),
        thinMargin: rows
          .filter((r) => r.expectedMarginPct < 10 && r.contractValue > 0)
          .map((r) => r.job.number),
        unbilled: rows
          .filter((r) => r.costUsedPct > 25 && r.billedPct === 0)
          .map((r) => r.job.number),
      },
    });
  }),
);

insightRoutes.get(
  '/profitability.csv',
  require_('insights.profitability.export'),
  handler(async (req, res) => {
    const rows = await projectProfitability({
      type: (req.query.type as 'PROJECT' | 'SERVICE_CONTRACT') || undefined,
      status: (req.query.status as string) || undefined,
    });
    await sendCsv(
      req,
      res,
      'project-profitability',
      [
        'Project',
        'Name',
        'Customer',
        'Project Manager',
        'Status',
        'Contract Value',
        'Budgeted Cost',
        'Committed',
        'Incurred',
        'Available',
        'Billed',
        'Collected',
        'Expected Profit',
        'Expected Margin %',
        'Cost Used %',
        'Billed %',
        'Flag',
      ],
      rows.map((r) => [
        r.job.number,
        r.job.name,
        r.customer.name,
        r.projectManager ?? '',
        r.job.status,
        money(r.contractValue),
        money(r.budgetedCost),
        money(r.committed),
        money(r.incurred),
        money(r.available),
        money(r.billed),
        money(r.collected),
        money(r.expectedProfit),
        r.expectedMarginPct.toFixed(2),
        r.costUsedPct.toFixed(2),
        r.billedPct.toFixed(2),
        r.overspending ? 'spending ahead of billing' : r.tooEarly ? 'too early to judge' : '',
      ]),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SALES ANALYTICS
// ════════════════════════════════════════════════════════════════════

insightRoutes.get(
  '/pipeline',
  require_('insights.pipeline.view_all'),
  handler(async (req, res) => {
    const range = parseRange(req.query.from as string, req.query.to as string);

    const [leads, quotations] = await Promise.all([
      prisma.lead.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: {
          id: true,
          status: true,
          source: true,
          estimatedValue: true,
          probability: true,
          createdAt: true,
          assignedTo: { select: { id: true, name: true } },
        },
      }),
      prisma.quotation.findMany({
        select: {
          id: true,
          number: true,
          subject: true,
          outcome: true,
          probability: true,
          submittedAt: true,
          decidedAt: true,
          lostReason: true,
          createdAt: true,
          customer: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          revisions: {
            select: { total: true, status: true, revision: true },
            orderBy: { revision: 'desc' },
          },
        },
      }),
    ]);

    /** A quotation's value is its latest approved revision, else its latest. */
    const valueOf = (q: (typeof quotations)[number]) =>
      num((q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0])?.total);

    const decidedInRange = quotations.filter(
      (q) => q.decidedAt && q.decidedAt >= range.from && q.decidedAt <= range.to,
    );
    const open = quotations.filter((q) => ['OPEN', 'SUBMITTED', 'NEGOTIATION'].includes(q.outcome));

    // Funnel. Lead statuses collapse into the four stages anybody actually
    // reports on; showing ten stages makes the drop-off impossible to see.
    const leadStage = (status: string) => {
      if (['NEW', 'CONTACTED'].includes(status)) return 'Enquiry';
      if (['QUALIFIED', 'SITE_VISIT', 'COSTING'].includes(status)) return 'Qualified';
      if (['QUOTATION_CREATED', 'QUOTATION_SUBMITTED', 'NEGOTIATION'].includes(status)) return 'Quoted';
      return status === 'WON' ? 'Won' : 'Lost';
    };
    const funnel = ['Enquiry', 'Qualified', 'Quoted', 'Won', 'Lost'].map((stage) => {
      const matching = leads.filter((l) => leadStage(l.status) === stage);
      return {
        stage,
        count: matching.length,
        value: cents(matching.reduce((s, l) => s + num(l.estimatedValue), 0)),
      };
    });

    // Per salesperson.
    const people = new Map<string, SalesPerson>();
    const decideDays = new Map<string, number[]>();
    const touch = (id: string, name: string) => {
      if (!people.has(id)) {
        people.set(id, {
          id,
          name,
          leads: 0,
          quotations: 0,
          quotedValue: 0,
          won: 0,
          wonValue: 0,
          lost: 0,
          winRatePct: 0,
          medianDaysToDecide: null,
        });
        decideDays.set(id, []);
      }
      return people.get(id)!;
    };

    for (const lead of leads) touch(lead.assignedTo.id, lead.assignedTo.name).leads++;

    for (const q of quotations) {
      const person = touch(q.owner.id, q.owner.name);
      const inRange = q.createdAt >= range.from && q.createdAt <= range.to;
      if (inRange) {
        person.quotations++;
        person.quotedValue = cents(person.quotedValue + valueOf(q));
      }
      if (q.decidedAt && q.decidedAt >= range.from && q.decidedAt <= range.to) {
        if (q.outcome === 'WON') {
          person.won++;
          person.wonValue = cents(person.wonValue + valueOf(q));
        }
        if (q.outcome === 'LOST') person.lost++;
        const from = q.submittedAt ?? q.createdAt;
        decideDays
          .get(q.owner.id)!
          .push(Math.max(0, Math.round((q.decidedAt.getTime() - from.getTime()) / 86_400_000)));
      }
    }
    for (const person of people.values()) {
      const decided = person.won + person.lost;
      person.winRatePct = pct(person.won, decided);
      person.medianDaysToDecide = median(decideDays.get(person.id) ?? []);
    }

    // Where the work comes from.
    const bySource = new Map<string, { source: string; leads: number; won: number; value: number }>();
    for (const lead of leads) {
      const key = lead.source?.trim() || 'Not recorded';
      const entry = bySource.get(key) ?? { source: key, leads: 0, won: 0, value: 0 };
      entry.leads++;
      if (lead.status === 'WON') entry.won++;
      entry.value = cents(entry.value + num(lead.estimatedValue));
      bySource.set(key, entry);
    }

    const lostReasons = new Map<string, number>();
    for (const q of decidedInRange.filter((q) => q.outcome === 'LOST')) {
      const key = q.lostReason?.trim() || 'Not recorded';
      lostReasons.set(key, (lostReasons.get(key) ?? 0) + 1);
    }

    const won = decidedInRange.filter((q) => q.outcome === 'WON');
    const lost = decidedInRange.filter((q) => q.outcome === 'LOST');

    res.json({
      range,
      funnel,
      totals: {
        leads: leads.length,
        openQuotations: open.length,
        openValue: cents(open.reduce((s, q) => s + valueOf(q), 0)),
        weightedValue: cents(open.reduce((s, q) => s + valueOf(q) * (q.probability / 100), 0)),
        won: won.length,
        wonValue: cents(won.reduce((s, q) => s + valueOf(q), 0)),
        lost: lost.length,
        lostValue: cents(lost.reduce((s, q) => s + valueOf(q), 0)),
        winRatePct: pct(won.length, won.length + lost.length),
        medianDaysToDecide: median(
          decidedInRange.map((q) =>
            Math.max(
              0,
              Math.round((q.decidedAt!.getTime() - (q.submittedAt ?? q.createdAt).getTime()) / 86_400_000),
            ),
          ),
        ),
      },
      people: [...people.values()].sort((a, b) => b.wonValue - a.wonValue),
      sources: [...bySource.values()].sort((a, b) => b.leads - a.leads),
      lostReasons: [...lostReasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      // The open quotations worth chasing, biggest weighted value first.
      openQuotations: open
        .map((q) => ({
          id: q.id,
          number: q.number,
          subject: q.subject,
          customer: q.customer,
          owner: q.owner.name,
          outcome: q.outcome,
          probability: q.probability,
          value: valueOf(q),
          weighted: cents(valueOf(q) * (q.probability / 100)),
          ageDays: Math.round((Date.now() - (q.submittedAt ?? q.createdAt).getTime()) / 86_400_000),
        }))
        .sort((a, b) => b.weighted - a.weighted),
    });
  }),
);

insightRoutes.get(
  '/pipeline.csv',
  require_('insights.pipeline.export'),
  handler(async (req, res) => {
    const range = parseRange(req.query.from as string, req.query.to as string);
    const quotations = await prisma.quotation.findMany({
      where: { createdAt: { gte: range.from, lte: range.to } },
      include: {
        customer: { select: { name: true } },
        owner: { select: { name: true } },
        revisions: { select: { total: true, status: true, revision: true }, orderBy: { revision: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await sendCsv(
      req,
      res,
      'sales-pipeline',
      ['Quotation', 'Subject', 'Customer', 'Salesperson', 'Outcome', 'Probability %', 'Value', 'Weighted', 'Raised', 'Submitted', 'Decided', 'Lost reason'],
      quotations.map((q) => {
        const value = num((q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0])?.total);
        return [
          q.number,
          q.subject,
          q.customer.name,
          q.owner.name,
          q.outcome,
          q.probability,
          money(value),
          money(cents(value * (q.probability / 100))),
          day(q.createdAt),
          day(q.submittedAt),
          day(q.decidedAt),
          q.lostReason ?? '',
        ];
      }),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  CASH FORECAST
// ════════════════════════════════════════════════════════════════════

/**
 * Money in and money out, by when it is due.
 *
 * Wider than G-FIN's cash flow in one respect that matters: it also counts
 * **approved billings not yet invoiced** and **committed purchase orders**.
 * Both are cash a decision away — the first is money the company has earned and
 * not asked for, and the second is money it has promised and not yet been
 * billed for. A forecast built only from invoices flatters the position on both
 * sides.
 */
insightRoutes.get(
  '/cash-forecast',
  require_('insights.cash.view_all'),
  handler(async (_req, res) => {
    const today = dayKey(new Date());
    const daysTo = (d: Date) => Math.floor((dayKey(d).getTime() - today.getTime()) / 86_400_000);

    const [invoices, uninvoiced, bills, claims, openOrders, uncleared] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: {
          id: true,
          number: true,
          dueDate: true,
          netCollectible: true,
          amountCollected: true,
          customer: { select: { name: true } },
        },
      }),
      prisma.progressBilling.findMany({
        where: { status: 'APPROVED', invoice: null },
        select: {
          id: true,
          number: true,
          billingDate: true,
          netCollectible: true,
          job: { select: { number: true, customer: { select: { name: true } } } },
        },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        select: {
          id: true,
          number: true,
          dueDate: true,
          netPayable: true,
          amountPaid: true,
          supplier: { select: { name: true } },
        },
      }),
      prisma.expenseClaim.findMany({
        where: { status: 'APPROVED' },
        select: { id: true, number: true, claimDate: true, total: true, amountPaid: true },
      }),
      prisma.purchaseOrder.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } },
        select: {
          id: true,
          number: true,
          orderDate: true,
          deliveryDate: true,
          total: true,
          supplier: { select: { name: true } },
          bills: { select: { id: true } },
        },
      }),
      prisma.payment.findMany({
        where: { clearedAt: null },
        select: { id: true, number: true, kind: true, amount: true, paymentDate: true, method: true },
      }),
    ]);

    const buckets: ForecastBucket[] = FORECAST_WINDOWS.map((w) => ({
      label: w.label,
      fromDay: w.from,
      toDay: Number.isFinite(w.to) ? w.to : null,
      invoiced: 0,
      unbilled: 0,
      payable: 0,
      reimbursable: 0,
      committed: 0,
      net: 0,
    }));

    const place = (dueDate: Date, amount: number, key: keyof ForecastBucket) => {
      if (amount <= 0.005) return;
      const i = windowFor(daysTo(dueDate));
      if (i < 0) return;
      (buckets[i][key] as number) = cents((buckets[i][key] as number) + amount);
    };

    for (const inv of invoices) {
      place(inv.dueDate, cents(num(inv.netCollectible) - num(inv.amountCollected)), 'invoiced');
    }
    // An approved billing not yet invoiced is treated as falling due on the
    // day it would if somebody raised the invoice today — which is the point:
    // it is only waiting on us.
    for (const b of uninvoiced) place(today, num(b.netCollectible), 'unbilled');
    for (const bill of bills) {
      place(bill.dueDate, cents(num(bill.netPayable) - num(bill.amountPaid)), 'payable');
    }
    for (const claim of claims) {
      place(claim.claimDate, cents(num(claim.total) - num(claim.amountPaid)), 'reimbursable');
    }
    // A purchase order with no bill against it yet: committed money that will
    // land as a payable once the supplier invoices.
    for (const order of openOrders) {
      if (order.bills.length) continue;
      place(order.deliveryDate ?? order.orderDate, num(order.total), 'committed');
    }
    for (const b of buckets) {
      b.net = cents(b.invoiced + b.unbilled - b.payable - b.reimbursable - b.committed);
    }

    // A running position: each window's net, accumulated.
    let running = 0;
    const cumulative = buckets.map((b) => {
      running = cents(running + b.net);
      return { label: b.label, net: b.net, cumulative: running };
    });

    res.json({
      asOf: today,
      buckets,
      cumulative,
      totals: {
        invoiced: cents(buckets.reduce((s, b) => s + b.invoiced, 0)),
        unbilled: cents(buckets.reduce((s, b) => s + b.unbilled, 0)),
        payable: cents(buckets.reduce((s, b) => s + b.payable, 0)),
        reimbursable: cents(buckets.reduce((s, b) => s + b.reimbursable, 0)),
        committed: cents(buckets.reduce((s, b) => s + b.committed, 0)),
        net: running,
      },
      uncleared: {
        in: cents(
          uncleared.filter((p) => p.kind === 'RECEIPT').reduce((s, p) => s + num(p.amount), 0),
        ),
        out: cents(
          uncleared.filter((p) => p.kind === 'DISBURSEMENT').reduce((s, p) => s + num(p.amount), 0),
        ),
        rows: uncleared.map((p) => ({ ...p, amount: num(p.amount) })),
      },
      // What is waiting on a decision of ours rather than on a customer's.
      ourMove: {
        billingsAwaitingInvoice: uninvoiced.length,
        billingsAwaitingInvoiceValue: cents(uninvoiced.reduce((s, b) => s + num(b.netCollectible), 0)),
        rows: uninvoiced.map((b) => ({
          id: b.id,
          number: b.number,
          job: b.job.number,
          customer: b.job.customer.name,
          value: num(b.netCollectible),
          waitingDays: Math.max(0, -daysTo(b.billingDate)),
        })),
      },
    });
  }),
);

insightRoutes.get(
  '/cash-forecast.csv',
  require_('insights.cash.export'),
  handler(async (req, res) => {
    const today = dayKey(new Date());
    const [invoices, bills] = await Promise.all([
      prisma.invoice.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        include: { customer: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.supplierBill.findMany({
        where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
        include: { supplier: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
    ]);

    const rows: (string | number)[][] = [];
    for (const i of invoices) {
      rows.push([
        'In',
        i.number,
        i.customer.name,
        day(i.dueDate),
        money(cents(num(i.netCollectible) - num(i.amountCollected))),
        Math.floor((dayKey(i.dueDate).getTime() - today.getTime()) / 86_400_000),
      ]);
    }
    for (const b of bills) {
      rows.push([
        'Out',
        b.number,
        b.supplier.name,
        day(b.dueDate),
        money(cents(num(b.netPayable) - num(b.amountPaid))),
        Math.floor((dayKey(b.dueDate).getTime() - today.getTime()) / 86_400_000),
      ]);
    }

    await sendCsv(req, res, 'cash-forecast', ['Direction', 'Document', 'Party', 'Due', 'Amount', 'Days'], rows);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  INVENTORY ANALYTICS
// ════════════════════════════════════════════════════════════════════

insightRoutes.get(
  '/inventory',
  require_('insights.inventory.view_all'),
  handler(async (req, res) => {
    const sinceDays = Math.min(730, Math.max(30, Number(req.query.sinceDays ?? 90)));
    const months = 6;
    const start = new Date(`${monthsBack(months)[0]}-01T00:00:00.000Z`);

    const [balances, moves, slow, reorder] = await Promise.all([
      prisma.inventoryBalance.findMany({
        where: { quantity: { gt: 0 } },
        include: {
          item: {
            select: {
              id: true,
              code: true,
              name: true,
              unit: true,
              reorderLevel: true,
              category: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.inventoryTransaction.findMany({
        where: { occurredAt: { gte: start } },
        select: { quantity: true, unitCost: true, occurredAt: true },
      }),
      slowMovers(sinceDays),
      prisma.inventoryBalance.findMany({
        where: { quantity: { gt: 0 }, item: { reorderLevel: { gt: 0 } } },
        include: {
          item: { select: { id: true, code: true, name: true, unit: true, reorderLevel: true } },
          warehouse: { select: { id: true, name: true } },
        },
      }),
    ]);

    const totalValue = cents(
      balances.reduce((s, b) => s + num(b.quantity) * num(b.averageCost), 0),
    );

    // By category, because "where is the money sitting" is the first question.
    const byCategory = new Map<string, { category: string; value: number; lines: number }>();
    for (const b of balances) {
      const key = b.item.category?.name ?? 'Uncategorised';
      const entry = byCategory.get(key) ?? { category: key, value: 0, lines: 0 };
      entry.value = cents(entry.value + num(b.quantity) * num(b.averageCost));
      entry.lines++;
      byCategory.set(key, entry);
    }

    // Issues out over the window, as a crude turnover read. Crude on purpose:
    // a proper turnover needs average inventory over time, which this system
    // does not snapshot, and a precise-looking wrong number is worse.
    const issuedValue = cents(
      moves
        .filter((m) => num(m.quantity) < 0)
        .reduce((s, m) => s + Math.abs(num(m.quantity)) * num(m.unitCost), 0),
    );
    const monthlyIssue = cents(issuedValue / months);

    const belowReorder = reorder
      .map((b) => ({
        item: b.item,
        warehouse: b.warehouse,
        quantity: num(b.quantity),
        borrowed: num(b.borrowedQty),
        available: cents(num(b.quantity) - num(b.borrowedQty)),
        reorderLevel: num(b.item.reorderLevel),
      }))
      .filter((r) => r.available < r.reorderLevel)
      .sort((a, b) => a.available - b.available);

    res.json({
      totalValue,
      lines: balances.length,
      byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value),
      slowMovers: slow.slice(0, 50),
      slowMoverValue: cents(slow.reduce((s, r) => s + r.value, 0)),
      slowMoverShare: pct(
        slow.reduce((s, r) => s + r.value, 0),
        totalValue,
      ),
      sinceDays,
      belowReorder,
      throughput: {
        months,
        issuedValue,
        monthlyIssue,
        // How many months of issuing the stock on hand represents, at the
        // recent rate. Null rather than infinity when nothing has moved.
        monthsOfStock: monthlyIssue > 0 ? cents(totalValue / monthlyIssue) : null,
      },
    });
  }),
);

insightRoutes.get(
  '/inventory.csv',
  require_('insights.inventory.export'),
  handler(async (req, res) => {
    const sinceDays = Math.min(730, Math.max(30, Number(req.query.sinceDays ?? 90)));
    const slow = await slowMovers(sinceDays);
    await sendCsv(
      req,
      res,
      'slow-moving-stock',
      ['Item', 'Description', 'Unit', 'Quantity', 'Average Cost', 'Value', 'Last moved', 'Days idle'],
      slow.map((r) => [
        r.item.code,
        r.item.name,
        r.item.unit,
        r.quantity,
        money(r.averageCost),
        money(r.value),
        day(r.lastMovedAt),
        r.daysSinceMoved ?? '',
      ]),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PERFORMANCE
// ════════════════════════════════════════════════════════════════════

/**
 * What people produced, and where work is stuck.
 *
 * Deliberately about OUTPUT — quotations won, projects delivered and their
 * margin, reports filed — and not about attendance. Lateness and leave live in
 * G-HR behind HR's own permissions, and aggregating them into a management
 * league table would turn a payroll record into a surveillance tool without
 * anybody deciding to.
 *
 * The bottleneck half is the more useful one: an approval queue sorted by how
 * long people have been waiting says more about how the company runs than any
 * individual's count does.
 */
insightRoutes.get(
  '/performance',
  require_('insights.performance.view_all'),
  handler(async (req, res) => {
    const range = parseRange(req.query.from as string, req.query.to as string);

    const [quotations, jobs, reports, pending, billings] = await Promise.all([
      prisma.quotation.findMany({
        where: { createdAt: { gte: range.from, lte: range.to } },
        select: {
          outcome: true,
          owner: { select: { id: true, name: true } },
          revisions: { select: { total: true, status: true, revision: true }, orderBy: { revision: 'desc' } },
        },
      }),
      prisma.job.findMany({
        where: { status: { notIn: ['CANCELLED'] } },
        select: {
          id: true,
          status: true,
          contractValue: true,
          targetEndDate: true,
          actualEndDate: true,
          projectManager: { select: { id: true, name: true } },
        },
      }),
      prisma.serviceReport.groupBy({
        by: ['performedById', 'status'],
        where: { performedAt: { gte: range.from, lte: range.to } },
        _count: { _all: true },
      }),
      prisma.approvalRequest.findMany({
        where: { status: 'PENDING' },
        select: {
          id: true,
          documentType: true,
          documentNumber: true,
          subject: true,
          amount: true,
          createdAt: true,
          currentSequence: true,
          requester: { select: { name: true } },
          workflow: { select: { name: true, steps: { include: { role: true, user: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.progressBilling.groupBy({
        by: ['jobId'],
        where: { status: { in: ['APPROVED', 'INVOICED'] } },
        _sum: { grossAmount: true },
      }),
    ]);

    // Sales output.
    const sales = new Map<string, { id: string; name: string; raised: number; won: number; wonValue: number }>();
    for (const q of quotations) {
      const entry = sales.get(q.owner.id) ?? { id: q.owner.id, name: q.owner.name, raised: 0, won: 0, wonValue: 0 };
      entry.raised++;
      if (q.outcome === 'WON') {
        entry.won++;
        entry.wonValue = cents(
          entry.wonValue + num((q.revisions.find((r) => r.status === 'APPROVED') ?? q.revisions[0])?.total),
        );
      }
      sales.set(q.owner.id, entry);
    }

    // Delivery output. On time is only asked of jobs that actually finished.
    const jobIds = jobs.map((j) => j.id);
    const ledger = jobIds.length
      ? await prisma.jobCostEntry.groupBy({
          by: ['jobId', 'state'],
          where: { jobId: { in: jobIds } },
          _sum: { amount: true },
        })
      : [];
    const state = (jobId: string, s: string) =>
      num(ledger.find((l) => l.jobId === jobId && l.state === s)?._sum.amount);

    const managers = new Map<
      string,
      { id: string; name: string; active: number; delivered: number; onTime: number; finished: number; contractValue: number; billed: number; overBudget: number }
    >();
    for (const job of jobs) {
      if (!job.projectManager) continue;
      const entry =
        managers.get(job.projectManager.id) ??
        {
          id: job.projectManager.id,
          name: job.projectManager.name,
          active: 0,
          delivered: 0,
          onTime: 0,
          finished: 0,
          contractValue: 0,
          billed: 0,
          overBudget: 0,
        };
      const done = ['COMPLETED', 'TURNED_OVER'].includes(job.status);
      if (done) {
        entry.delivered++;
        if (job.actualEndDate && job.targetEndDate) {
          entry.finished++;
          if (job.actualEndDate <= job.targetEndDate) entry.onTime++;
        }
      } else {
        entry.active++;
      }
      entry.contractValue = cents(entry.contractValue + num(job.contractValue));
      entry.billed = cents(
        entry.billed + num(billings.find((b) => b.jobId === job.id)?._sum.grossAmount),
      );
      const budgeted = state(job.id, 'BUDGETED');
      const spent = cents(state(job.id, 'COMMITTED') + state(job.id, 'INCURRED'));
      if (budgeted > 0 && spent > budgeted) entry.overBudget++;
      managers.set(job.projectManager.id, entry);
    }

    // Service output.
    const engineerIds = [...new Set(reports.map((r) => r.performedById))];
    const engineers = engineerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: engineerIds } },
          select: { id: true, name: true },
        })
      : [];
    const service = engineers.map((u) => {
      const mine = reports.filter((r) => r.performedById === u.id);
      return {
        id: u.id,
        name: u.name,
        filed: mine.reduce((s, r) => s + r._count._all, 0),
        approved: mine.filter((r) => r.status === 'APPROVED').reduce((s, r) => s + r._count._all, 0),
        returned: mine.filter((r) => r.status === 'REJECTED').reduce((s, r) => s + r._count._all, 0),
      };
    });

    // The bottleneck. Who a document is waiting on, and for how long.
    const today = Date.now();
    const bottleneck = pending.map((p) => {
      const step = p.workflow?.steps.find((s) => s.sequence === p.currentSequence);
      return {
        id: p.id,
        documentType: p.documentType,
        documentNumber: p.documentNumber,
        subject: p.subject,
        amount: p.amount ? num(p.amount) : null,
        requester: p.requester.name,
        waitingOn: step?.user?.name ?? step?.role?.name ?? step?.approverType.toLowerCase() ?? 'nobody',
        step: step?.name ?? `Step ${p.currentSequence}`,
        waitingDays: Math.floor((today - p.createdAt.getTime()) / 86_400_000),
      };
    });

    const byApprover = new Map<string, { approver: string; count: number; oldestDays: number; value: number }>();
    for (const b of bottleneck) {
      const entry = byApprover.get(b.waitingOn) ?? { approver: b.waitingOn, count: 0, oldestDays: 0, value: 0 };
      entry.count++;
      entry.oldestDays = Math.max(entry.oldestDays, b.waitingDays);
      entry.value = cents(entry.value + (b.amount ?? 0));
      byApprover.set(b.waitingOn, entry);
    }

    res.json({
      range,
      sales: [...sales.values()].sort((a, b) => b.wonValue - a.wonValue),
      delivery: [...managers.values()]
        .map((m) => ({ ...m, onTimePct: pct(m.onTime, m.finished) }))
        .sort((a, b) => b.contractValue - a.contractValue),
      service: service.sort((a, b) => b.filed - a.filed),
      bottleneck: {
        total: bottleneck.length,
        oldestDays: bottleneck.length ? Math.max(...bottleneck.map((b) => b.waitingDays)) : 0,
        byApprover: [...byApprover.values()].sort((a, b) => b.oldestDays - a.oldestDays),
        rows: bottleneck.sort((a, b) => b.waitingDays - a.waitingDays).slice(0, 50),
      },
    });
  }),
);

insightRoutes.get(
  '/performance.csv',
  require_('insights.performance.export'),
  handler(async (req, res) => {
    const pending = await prisma.approvalRequest.findMany({
      where: { status: 'PENDING' },
      include: {
        requester: { select: { name: true } },
        workflow: { select: { name: true, steps: { include: { role: true, user: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const today = Date.now();
    await sendCsv(
      req,
      res,
      'approvals-waiting',
      ['Document type', 'Number', 'Subject', 'Amount', 'Raised by', 'Waiting on', 'Step', 'Days waiting'],
      pending.map((p) => {
        const step = p.workflow?.steps.find((s) => s.sequence === p.currentSequence);
        return [
          p.documentType,
          p.documentNumber ?? '',
          p.subject,
          p.amount ? money(num(p.amount)) : '',
          p.requester.name,
          step?.user?.name ?? step?.role?.name ?? step?.approverType.toLowerCase() ?? 'nobody',
          step?.name ?? '',
          Math.floor((today - p.createdAt.getTime()) / 86_400_000),
        ];
      }),
    );
  }),
);

// ── A guard against this module ever writing anything ────────────────────────

insightRoutes.use((req, _res, next) => {
  if (req.method !== 'GET') {
    // Not defensiveness for its own sake: the whole value of a reporting layer
    // is that it cannot be the thing that changed a number.
    return next(badRequest('Insights is read-only. Change records in the module that owns them.'));
  }
  next();
});
