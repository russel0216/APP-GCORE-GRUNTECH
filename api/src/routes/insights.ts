import { Router } from 'express';
import type { Request, Response } from 'express';

import { prisma } from '../prisma';
import { handler, badRequest } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { financePosition, claimPayable } from '../shared/finance';
import { stockOnHand } from '../shared/chain';
import { groupShares, quotationValue, valueRevision } from '../shared/pipeline';
import { groupKey } from '../shared/quotationGroups';
import { manilaDayStart } from '../shared/day';
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
  approvalBottleneck,
  companySummary,
  summaryCsvRows,
  SUMMARY_CSV_HEADER,
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
 *
 * `summary` is the brief at the top of the screen — one line per division,
 * each read through that division's own dashboard function. It rides on this
 * response (one read, one snapshot) rather than a second request, and `asOf`
 * is captured once so every live figure on the page is the same instant.
 */
insightRoutes.get(
  '/dashboard',
  require_('insights.dashboard.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const asOf = new Date();
    const range = parseRange(req.query.from as string, req.query.to as string);
    const today = dayKey(asOf);
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    const [
      pipelineOpen,
      quotationsWon,
      quotationsLost,
      activeJobs,
      jobsDelivered,
      ledger,
      billedAgg,
      position,
      collectedThisMonth,
      collectedInRange,
      stock,
      contractsActive,
      visitsOverdue,
      pendingApprovals,
      headcount,
      summary,
    ] = await Promise.all([
      prisma.quotation.findMany({
        where: { outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION'] } },
        select: {
          probability: true,
          // Every revision, because the value of a quotation is its APPROVED
          // revision and — where none has been approved yet — its latest.
          // quotationValue() decides it, for this screen, Sales Analytics and
          // the sales board alike.
          revisions: { select: { total: true, status: true, revision: true } },
        },
      }),
      // decidedAt is a timestamp: Manila's days, fromAt..toAt (parseRange).
      prisma.quotation.count({ where: { outcome: 'WON', decidedAt: { gte: range.fromAt, lte: range.toAt } } }),
      prisma.quotation.count({ where: { outcome: 'LOST', decidedAt: { gte: range.fromAt, lte: range.toAt } } }),
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
      // The position is G-FIN's own, decided in shared/finance.ts. This screen
      // used to sum its own invoices and bills and printed a working position
      // the finance dashboard disagreed with.
      financePosition(today),
      // Customer receipts only. A person handing back unspent advance money is
      // cash in, but it was never a collection.
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: range.from, lte: range.to } },
        _sum: { amount: true },
      }),
      stockOnHand(),
      prisma.serviceContract.count({ where: { status: 'ACTIVE' } }),
      prisma.serviceVisit.count({ where: { status: 'SCHEDULED', dueDate: { lte: today } } }),
      prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
      prisma.employee.count({ where: { isActive: true } }),
      companySummary(me, req.query, asOf),
    ]);

    const state = (s: string) => num(ledger.find((l) => l.state === s)?._sum.amount);

    // Weighted by the salesperson's own read on the chance of award — the
    // honest way to total a pipeline, and the only figure anybody should plan
    // against.
    const weightedPipeline = cents(
      pipelineOpen.reduce((sum, q) => sum + quotationValue(q.revisions) * (q.probability / 100), 0),
    );
    const openPipeline = cents(pipelineOpen.reduce((sum, q) => sum + quotationValue(q.revisions), 0));

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
        receivable: position.receivable,
        receivableOverdue: position.receivableOverdue,
        payable: position.payable,
        payableOverdue: position.payableOverdue,
        reimbursable: position.reimbursable,
        advancesToRelease: position.advancesToRelease,
        collectedThisMonth: cents(num(collectedThisMonth._sum.amount)),
        collectedInRange: cents(num(collectedInRange._sum.amount)),
        // Receivable less everything owed — G-FIN's definition, to the centavo.
        workingPosition: position.workingPosition,
      },
      chain: {
        stockValue: stock.value,
        stockLines: stock.lines,
      },
      aftermarket: { contractsActive, visitsOverdue },
      people: { headcount, pendingApprovals },
      summary,
    });
  }),
);

/**
 * The brief's CSV twin — one row per figure, with its basis, scope and the
 * screen it opens.
 *
 * `insights.dashboard.export` to call it at all, and each module's rows also
 * need that module's `*.dashboard.export`: holding a figure on screen is not
 * the right to take a file of it away. Audited before the bytes go out, like
 * every other export here.
 */
insightRoutes.get(
  '/summary.csv',
  require_('insights.dashboard.export'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const summary = await companySummary(me, req.query, new Date());
    await sendCsv(req, res, 'company-summary', SUMMARY_CSV_HEADER, summaryCsvRows(summary, me));
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
    // DATE columns start at the 1st as a date; timestamps at Manila midnight of it.
    const start = new Date(`${keys[0]}-01T00:00:00.000Z`);
    const startAt = manilaDayStart(`${keys[0]}-01`);

    const [billings, receipts, incurred, quotations] = await Promise.all([
      prisma.progressBilling.findMany({
        where: { status: { in: ['APPROVED', 'INVOICED'] }, billingDate: { gte: start } },
        select: { billingDate: true, grossAmount: true },
      }),
      // Customer receipts only — an advance refund is not a collection.
      prisma.payment.findMany({
        where: { kind: 'RECEIPT', customerId: { not: null }, clearedAt: { gte: start } },
        select: { clearedAt: true, amount: true },
      }),
      prisma.jobCostEntry.findMany({
        // occurredAt, not createdAt: a cost entered late still belongs to the
        // month the work happened in, and a trend built on entry dates shows
        // the bookkeeping rather than the business.
        where: { state: 'INCURRED', occurredAt: { gte: startAt } },
        select: { occurredAt: true, amount: true },
      }),
      prisma.quotation.findMany({
        where: { outcome: 'WON', decidedAt: { gte: startAt } },
        select: {
          decidedAt: true,
          revisions: { select: { total: true, status: true, revision: true } },
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
      if (k in won) won[k] = cents(won[k] + quotationValue(q.revisions));
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

/** The bucket a customer with no sub-industry, or a lead with no customer, reports under. */
const UNCLASSIFIED = { id: 'UNCLASSIFIED', name: 'Unclassified' };

/** One row of "By sub-industry" (2026-10-08; "By industry" until the customer's industry went). */
interface SubIndustryRow {
  id: string;
  name: string;
  leads: number;
  quotations: number;
  quotedValue: number;
  won: number;
  wonValue: number;
  lost: number;
  winRatePct: number;
  openValue: number;
  weightedValue: number;
}

/** One row of "By group": quotations raised and won that carry the group, and their share of value. */
interface GroupRow {
  group: string;
  quotations: number;
  quotedValue: number;
  won: number;
  wonValue: number;
}

insightRoutes.get(
  '/pipeline',
  require_('insights.pipeline.view_all'),
  handler(async (req, res) => {
    const range = parseRange(req.query.from as string, req.query.to as string);

    const subIndustrySelect = { select: { id: true, name: true } } as const;
    const [leads, quotations, activeSubIndustries, groupMaster] = await Promise.all([
      prisma.lead.findMany({
        where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
        select: {
          id: true,
          status: true,
          source: true,
          estimatedValue: true,
          probability: true,
          createdAt: true,
          assignedTo: { select: { id: true, name: true } },
          // A lead's sub-industry is its customer's. A lead with no customer
          // yet reports as Unclassified — which is the truth about it.
          customer: { select: { subIndustry: subIndustrySelect } },
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
          customer: { select: { id: true, name: true, subIndustry: subIndustrySelect } },
          owner: { select: { id: true, name: true } },
          revisions: {
            select: {
              total: true,
              status: true,
              revision: true,
              // For "By group": the value revision's lines, to split its value by group.
              items: { select: { group: true, amount: true, isHeading: true } },
            },
          },
        },
      }),
      prisma.subIndustry.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.quotationGroup.findMany({
        select: { key: true, name: true, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    /** A quotation's value: its approved revision, else its latest (shared/pipeline.ts). */
    const valueOf = (q: (typeof quotations)[number]) => quotationValue(q.revisions);

    const decidedInRange = quotations.filter(
      (q) => q.decidedAt && q.decidedAt >= range.fromAt && q.decidedAt <= range.toAt,
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

    // Per sub-industry. Every active one is listed, even at zero — a blank
    // row is information ("nothing from the hospitals this year"). An
    // inactive one appears only when a record still carries it, and
    // Unclassified is always last. The sums of this table ARE the totals
    // below; the verify script holds it to that.
    const industries = new Map<string, SubIndustryRow>();
    const industryRow = (industry: { id: string; name: string } | null | undefined) => {
      const key = industry ?? UNCLASSIFIED;
      let row = industries.get(key.id);
      if (!row) {
        row = {
          id: key.id,
          name: key.name,
          leads: 0,
          quotations: 0,
          quotedValue: 0,
          won: 0,
          wonValue: 0,
          lost: 0,
          winRatePct: 0,
          openValue: 0,
          weightedValue: 0,
        };
        industries.set(key.id, row);
      }
      return row;
    };
    for (const industry of activeSubIndustries) industryRow(industry);

    for (const lead of leads) {
      touch(lead.assignedTo.id, lead.assignedTo.name).leads++;
      industryRow(lead.customer?.subIndustry).leads++;
    }

    for (const q of quotations) {
      const person = touch(q.owner.id, q.owner.name);
      const industry = industryRow(q.customer.subIndustry);
      const value = valueOf(q);
      const inRange = q.createdAt >= range.fromAt && q.createdAt <= range.toAt;
      if (inRange) {
        person.quotations++;
        person.quotedValue = cents(person.quotedValue + value);
        industry.quotations++;
        industry.quotedValue = cents(industry.quotedValue + value);
      }
      if (q.decidedAt && q.decidedAt >= range.fromAt && q.decidedAt <= range.toAt) {
        if (q.outcome === 'WON') {
          person.won++;
          person.wonValue = cents(person.wonValue + value);
          industry.won++;
          industry.wonValue = cents(industry.wonValue + value);
        }
        if (q.outcome === 'LOST') {
          person.lost++;
          industry.lost++;
        }
        const from = q.submittedAt ?? q.createdAt;
        decideDays
          .get(q.owner.id)!
          .push(Math.max(0, Math.round((q.decidedAt.getTime() - from.getTime()) / 86_400_000)));
      }
      if (['OPEN', 'SUBMITTED', 'NEGOTIATION'].includes(q.outcome)) {
        industry.openValue = cents(industry.openValue + value);
        industry.weightedValue = cents(industry.weightedValue + value * (q.probability / 100));
      }
    }
    for (const person of people.values()) {
      const decided = person.won + person.lost;
      person.winRatePct = pct(person.won, decided);
      person.medianDaysToDecide = median(decideDays.get(person.id) ?? []);
    }
    for (const row of industries.values()) row.winRatePct = pct(row.won, row.won + row.lost);
    const unclassified = industries.get(UNCLASSIFIED.id) ?? industryRow(UNCLASSIFIED);
    industries.delete(UNCLASSIFIED.id);

    // By group (2026-10-06): what was quoted and won per quotation group.
    // Each quotation's value is split across its value revision's groups in
    // proportion to the line amounts (`groupShares`), so the table's sums are
    // the report's own quoted and won figures. Every active group in the
    // master is listed, even at zero; "No group" is always last.
    const groupRows = new Map<string, GroupRow>();
    const groupRow = (key: string, name: string) => {
      let row = groupRows.get(key);
      if (!row) {
        row = { group: name, quotations: 0, quotedValue: 0, won: 0, wonValue: 0 };
        groupRows.set(key, row);
      }
      return row;
    };
    for (const g of groupMaster) if (g.isActive) groupRow(g.key, g.name);
    const masterName = new Map(groupMaster.map((g) => [g.key, g.name]));
    for (const q of quotations) {
      const inRange = q.createdAt >= range.fromAt && q.createdAt <= range.toAt;
      const wonInRange = q.outcome === 'WON' && !!q.decidedAt && q.decidedAt >= range.fromAt && q.decidedAt <= range.toAt;
      if (!inRange && !wonInRange) continue;
      const revision = valueRevision(q.revisions);
      for (const share of groupShares(valueOf(q), revision?.items ?? [], groupKey)) {
        const row = groupRow(share.key, masterName.get(share.key) ?? share.group);
        if (inRange) {
          row.quotations++;
          row.quotedValue = cents(row.quotedValue + share.value);
        }
        if (wonInRange) {
          row.won++;
          row.wonValue = cents(row.wonValue + share.value);
        }
      }
    }
    const noGroup = groupRows.get('');
    groupRows.delete('');
    const byGroup = [...groupRows.values()].sort((a, b) => b.quotedValue - a.quotedValue || a.group.localeCompare(b.group));
    if (noGroup) byGroup.push(noGroup);

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
      subIndustries: [...industries.values(), unclassified],
      byGroup,
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
          customer: { id: q.customer.id, name: q.customer.name },
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
      where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
      include: {
        customer: { select: { name: true, subIndustry: { select: { name: true } } } },
        owner: { select: { name: true } },
        revisions: { select: { total: true, status: true, revision: true, items: { select: { group: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await sendCsv(
      req,
      res,
      'sales-pipeline',
      // Sub-industry is APPENDED, not slotted in beside Customer: a sheet
      // somebody already built on this export keeps its columns where they
      // were (it held the customer's industry until 2026-10-08).
      ['Quotation', 'Subject', 'Customer', 'Salesperson', 'Outcome', 'Probability %', 'Value', 'Weighted', 'Raised', 'Submitted', 'Decided', 'Lost reason', 'Sub-industry', 'Groups'],
      quotations.map((q) => {
        const value = quotationValue(q.revisions);
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
          q.customer.subIndustry?.name ?? UNCLASSIFIED.name,
          // The value revision's groups, as "By group" splits it.
          [...new Set((valueRevision(q.revisions)?.items ?? []).map((i) => i.group?.trim()).filter(Boolean))].join('; '),
        ];
      }),
    );
  }),
);

// ════════════════════════════════════════════════════════════════════
//  CASH FORECAST
// ════════════════════════════════════════════════════════════════════

/**
 * Everything the forecast counts, one row per document, already placed on a
 * day. The screen buckets these rows and the CSV prints them, so the two can
 * never list different documents — the CSV used to carry invoices and bills
 * only, while the screen also counted billings, claims, orders and advances.
 */
interface ForecastItem {
  direction: 'In' | 'Out';
  key: 'invoiced' | 'unbilled' | 'refunds' | 'payable' | 'reimbursable' | 'committed' | 'advances';
  document: string;
  party: string;
  due: Date;
  amount: number;
}

async function forecastItems(today: Date): Promise<ForecastItem[]> {
  const [invoices, uninvoiced, bills, claims, openOrders, advances] = await Promise.all([
    prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: {
        number: true,
        dueDate: true,
        netCollectible: true,
        amountCollected: true,
        customer: { select: { name: true } },
      },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.progressBilling.findMany({
      where: { status: 'APPROVED', invoice: null },
      select: {
        number: true,
        netCollectible: true,
        job: { select: { customer: { select: { name: true } } } },
      },
    }),
    prisma.supplierBill.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
      select: {
        number: true,
        dueDate: true,
        netPayable: true,
        amountPaid: true,
        supplier: { select: { name: true } },
      },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.expenseClaim.findMany({
      where: { status: 'APPROVED' },
      select: {
        number: true,
        claimDate: true,
        total: true,
        amountPaid: true,
        // A liquidation is owed only its excess over the cash already handed
        // over — claimPayable() decides it, exactly as G-FIN does.
        advance: { select: { amountReleased: true } },
        claimedBy: { select: { name: true } },
      },
    }),
    prisma.purchaseOrder.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } },
      select: {
        number: true,
        orderDate: true,
        deliveryDate: true,
        total: true,
        supplier: { select: { name: true } },
        bills: { select: { id: true } },
      },
    }),
    prisma.cashAdvance.findMany({
      where: { status: { in: ['APPROVED', 'REFUND_DUE'] } },
      select: {
        number: true,
        status: true,
        amount: true,
        amountReleased: true,
        amountSpent: true,
        amountRefunded: true,
        requestDate: true,
        neededBy: true,
        liquidationDueDate: true,
        requestedBy: { select: { name: true } },
      },
    }),
  ]);

  const items: ForecastItem[] = [];
  const push = (item: ForecastItem) => {
    if (item.amount > 0.005) items.push(item);
  };

  for (const inv of invoices) {
    push({
      direction: 'In',
      key: 'invoiced',
      document: inv.number,
      party: inv.customer.name,
      due: inv.dueDate,
      amount: cents(num(inv.netCollectible) - num(inv.amountCollected)),
    });
  }
  // An approved billing not yet invoiced is treated as falling due on the
  // day it would if somebody raised the invoice today — which is the point:
  // it is only waiting on us.
  for (const b of uninvoiced) {
    push({
      direction: 'In',
      key: 'unbilled',
      document: b.number,
      party: b.job.customer.name,
      due: today,
      amount: num(b.netCollectible),
    });
  }
  for (const bill of bills) {
    push({
      direction: 'Out',
      key: 'payable',
      document: bill.number,
      party: bill.supplier.name,
      due: bill.dueDate,
      amount: cents(num(bill.netPayable) - num(bill.amountPaid)),
    });
  }
  for (const claim of claims) {
    push({
      direction: 'Out',
      key: 'reimbursable',
      document: claim.number,
      party: claim.claimedBy.name,
      due: claim.claimDate,
      amount: cents(claimPayable(claim) - num(claim.amountPaid)),
    });
  }
  // A purchase order with no bill against it yet: committed money that will
  // land as a payable once the supplier invoices.
  for (const order of openOrders) {
    if (order.bills.length) continue;
    push({
      direction: 'Out',
      key: 'committed',
      document: order.number,
      party: order.supplier.name,
      due: order.deliveryDate ?? order.orderDate,
      amount: num(order.total),
    });
  }
  // An approved advance goes out when the person needs it; unspent cash
  // comes back by the liquidation deadline, or today if none is set. The
  // same placement G-FIN's cash flow uses.
  for (const adv of advances) {
    if (adv.status === 'APPROVED') {
      push({
        direction: 'Out',
        key: 'advances',
        document: adv.number,
        party: adv.requestedBy.name,
        due: adv.neededBy ?? adv.requestDate,
        amount: cents(num(adv.amount) - num(adv.amountReleased)),
      });
    } else {
      push({
        direction: 'In',
        key: 'refunds',
        document: adv.number,
        party: adv.requestedBy.name,
        due: adv.liquidationDueDate ?? today,
        amount: cents(
          Math.max(0, num(adv.amountReleased) - num(adv.amountSpent)) - num(adv.amountRefunded),
        ),
      });
    }
  }
  return items;
}

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

    const [items, uninvoiced, uncleared] = await Promise.all([
      forecastItems(today),
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
      refunds: 0,
      payable: 0,
      reimbursable: 0,
      committed: 0,
      advances: 0,
      net: 0,
    }));

    for (const item of items) {
      const i = windowFor(daysTo(item.due));
      if (i < 0) continue;
      buckets[i][item.key] = cents(buckets[i][item.key] + item.amount);
    }
    for (const b of buckets) {
      b.net = cents(
        b.invoiced + b.unbilled + b.refunds - b.payable - b.reimbursable - b.committed - b.advances,
      );
    }

    // A running position: each window's net, accumulated.
    let running = 0;
    const cumulative = buckets.map((b) => {
      running = cents(running + b.net);
      return { label: b.label, net: b.net, cumulative: running };
    });
    const total = (key: ForecastItem['key']) => cents(buckets.reduce((s, b) => s + b[key], 0));

    res.json({
      asOf: today,
      buckets,
      cumulative,
      totals: {
        invoiced: total('invoiced'),
        unbilled: total('unbilled'),
        refunds: total('refunds'),
        payable: total('payable'),
        reimbursable: total('reimbursable'),
        committed: total('committed'),
        advances: total('advances'),
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
    const items = (await forecastItems(today)).sort((a, b) => a.due.getTime() - b.due.getTime());
    await sendCsv(
      req,
      res,
      'cash-forecast',
      ['Direction', 'Document', 'Party', 'Due', 'Amount', 'Days'],
      items.map((i) => [
        i.direction,
        i.document,
        i.party,
        day(i.due),
        money(i.amount),
        Math.floor((dayKey(i.due).getTime() - today.getTime()) / 86_400_000),
      ]),
    );
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
    // occurredAt is a timestamp: the first month starts at Manila midnight.
    const start = manilaDayStart(`${monthsBack(months)[0]}-01`);

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

    // Decided once, in shared/chain.ts — the G-CHAIN dashboard, the inventory
    // summary and the company overview all print this same figure.
    const totalValue = (await stockOnHand()).value;

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
        where: { createdAt: { gte: range.fromAt, lte: range.toAt } },
        select: {
          outcome: true,
          owner: { select: { id: true, name: true } },
          revisions: { select: { total: true, status: true, revision: true } },
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
      approvalBottleneck(),
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
        entry.wonValue = cents(entry.wonValue + quotationValue(q.revisions));
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

    // The bottleneck. Who a document is waiting on, and for how long — each
    // row carrying the document's own link, so a stuck row opens.
    const bottleneck = pending;

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
    const rows = await approvalBottleneck();
    await sendCsv(
      req,
      res,
      'approvals-waiting',
      // Link is APPENDED so an existing sheet keeps its columns.
      ['Document type', 'Number', 'Subject', 'Amount', 'Raised by', 'Waiting on', 'Step', 'Days waiting', 'Link'],
      rows.map((r) => [
        r.documentType,
        r.documentNumber ?? '',
        r.subject,
        r.amount ? money(r.amount) : '',
        r.requester,
        r.waitingOn,
        r.step,
        r.waitingDays,
        r.link ?? '',
      ]),
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
