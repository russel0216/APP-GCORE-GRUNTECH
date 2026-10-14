import { Router } from 'express';
import { z } from 'zod';
import { JobType, Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
  forbidden,
  idsFilter,
  type ListQuery,
} from '../http/kit';
import { manilaDayStart, manilaMonthKey, workingDayDate } from '../shared/day';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, resolveUser } from '../permissions/resolve';
import { notify } from '../shared/notifications';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import {
  approvalSlots,
  approvalStands,
  contactOf,
  onApprovalSettled,
  pickWorkflow,
  mayDecide,
  preparedAt,
  slotSignatories,
  submitForApproval,
  type ApprovalSlot,
} from '../shared/approvals';
import { scheduleOfValues, costingFigures, lineAmount, lineCodes, marginOfMarkup, planTasks, vatOn } from '../shared/costingMath';
import {
  companyCurrency,
  formatAmount,
  formatDate,
  formatMoney,
  formatShortDate,
  renderDocument,
  statusLabel,
  type PdfGanttGroup,
  type PdfRow,
  type PdfSection,
  type Signatory,
} from '../shared/pdf';
import { LIST_CAP, listReference, recordNamed, sendListPdf, totalLabel, choice, ratePct } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { SCOPE_PRELOAD } from '../shared/scopePreload';
import { renderDesigned, type DesignData } from '../shared/pdfDesign';
import { costingDesign, costingLineRow, costingSubtotalRow } from '../shared/costingTemplate';
import { appendPdf } from '../shared/pdfAttachments';

/**
 * Costing (model §5.3).
 *
 * Not a calculator. This is where the contract amount comes from, and the same
 * record carries the scope of work whose sections become the Schedule of
 * Values — the backbone that progress reporting, progress billing and the
 * S-curve are all measured against in Phase 4.
 *
 * The sheet is written whole: `POST /costings` and `PUT /costings/:id/sheet`
 * take the header, every cost line and every scope phase with its tasks, and
 * write them in ONE transaction — so a refused line burns no number and a
 * half-saved sheet never exists. The per-line and per-section routes below
 * remain for scripts and for the renewal path.
 *
 * The arithmetic is `shared/costingMath.ts`, and nothing else: line amounts,
 * markup, contingency, discount, VAT and the working-day plan.
 */

export const costingRoutes = Router();
costingRoutes.use(authenticate);

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);

function num(v: Prisma.Decimal | null | undefined): number {
  return v == null ? 0 : Number(v);
}

type Tx = Prisma.TransactionClient;

/** The costing's stored rates, as costingMath takes them. */
function ratesOf(c: { marginPct: Prisma.Decimal; vatRate: Prisma.Decimal; targetContractValue?: Prisma.Decimal | null }) {
  return {
    marginPct: c.marginPct.toString(),
    vatRate: c.vatRate.toString(),
    targetContractValue: c.targetContractValue ? c.targetContractValue.toString() : null,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Recomputes totals from the lines and rewrites the stored figures. */
async function recalc(costingId: string, tx: Tx = prisma, opts: { strict?: boolean } = {}) {
  const costing = await tx.costing.findUnique({
    where: { id: costingId },
    include: { lines: true },
  });
  if (!costing) return null;

  const f = costingFigures(
    costing.lines.map((l) => ({ quantity: l.quantity.toString(), unitCost: l.unitCost.toString(), isHeading: l.isHeading })),
    ratesOf(costing),
  );
  // A fixed price stands on the margin it amounts to, within the margin's own
  // ±95%: refused at a save (the caller's transaction rolls back), never on a
  // background recalculation.
  if (opts.strict && f.fixedPrice && (f.marginPct >= 0.95 || f.marginPct <= -0.95)) {
    throw badRequest(
      f.totalCost <= 0
        ? 'Enter the cost lines first — a fixed price is set on top of a cost.'
        : `A price of ${formatMoney(f.contractValue)} on a cost of ${formatMoney(f.totalCost)} is a ${Math.round(f.marginPct * 1000) / 10}% margin — within ±95% only.`,
      [{ field: 'targetContractValue', message: 'Outside a ±95% margin of the cost' }],
    );
  }
  return tx.costing.update({
    where: { id: costingId },
    data: {
      totalCost: d(f.totalCost),
      contractValue: d(f.contractValue),
      // At a fixed price the margin is what the price amounts to, stored for
      // every reader of the costing's margin (the budget, the board).
      ...(f.fixedPrice ? { marginPct: d(f.marginPct) } : {}),
    },
  });
}

/**
 * Writes the schedule of values (`scheduleOfValues()` in costingMath, the
 * rule the sheet shows live): every cost-priced phase from its buckets' cost,
 * and — with `spread` — what the declared and cost-priced phases leave of
 * the contract value over the SPREAD phases, so the sum is exact. Without
 * `spread` the SPREAD and DECLARED phases keep what was typed. With `strict`
 * (a save, a distribute) a schedule that cannot add up is refused; the
 * caller's transaction rolls back.
 */
async function spreadSections(tx: Tx, costingId: string, opts: { spread?: boolean; strict?: boolean } = {}): Promise<number> {
  const spread = opts.spread ?? true;
  const costing = await tx.costing.findUnique({ where: { id: costingId }, select: { contractValue: true, totalCost: true } });
  const sections = await tx.scopeSection.findMany({ where: { costingId }, orderBy: { sortOrder: 'asc' } });
  if (!costing || !sections.length) return 0;

  const buckets = await tx.costingLine.groupBy({
    by: ['costCategoryId'],
    where: { costingId, isHeading: false },
    _sum: { amount: true },
  });
  const bucketCost = Object.fromEntries(buckets.map((b) => [b.costCategoryId, (b._sum.amount ?? new Prisma.Decimal(0)).toString()]));
  const sov = scheduleOfValues(
    sections.map((s) => ({ valueSource: s.valueSource, value: s.value.toString(), costCategoryIds: s.costCategoryIds })),
    bucketCost,
    costing.contractValue.toString(),
    costing.totalCost.toString(),
    spread,
  );
  if (opts.strict && sov.problem === 'over') {
    throw badRequest(
      `The declared and cost-priced phases come to more than the contract value of ${formatMoney(num(costing.contractValue))} — lower one, or let it spread.`,
      [{ field: 'sections', message: 'More than the contract value' }],
    );
  }
  // Only what changed is written: a declared phase, or an unspread one, comes back as it went in.
  for (const [i, s] of sections.entries()) {
    if (sov.values[i] !== num(s.value)) await tx.scopeSection.update({ where: { id: s.id }, data: { value: d(sov.values[i]) } });
  }
  return sections.length;
}

/** Category id → its place in the five buckets (1 = first), which the line codes print. */
async function categoryRanks(tx: Tx = prisma): Promise<Map<string, number>> {
  const cats = await tx.costCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true } });
  return new Map(cats.map((c, i) => [c.id, i + 1]));
}

const dayKey = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);

/** Shapes a costing for the API: Decimals to numbers, plus derived figures. */
function present(costing: Record<string, unknown>, ranks?: Map<string, number>) {
  const lines = (costing.lines ?? []) as Record<string, unknown>[];
  const sections = (costing.scopeSections ?? []) as (Record<string, unknown> & {
    durationDays: number;
    tasks?: (Record<string, unknown> & { startDay: number | null; durationDays: number })[];
  })[];

  const totalCost = num(costing.totalCost as Prisma.Decimal);
  const contractValue = num(costing.contractValue as Prisma.Decimal);
  const rates = {
    marginPct: num(costing.marginPct as Prisma.Decimal),
    vatRate: num(costing.vatRate as Prisma.Decimal),
    targetContractValue: costing.targetContractValue == null ? null : num(costing.targetContractValue as Prisma.Decimal),
  };
  // The summary's figures come from the STORED cost and contract value — the
  // commercial facts — never re-derived from the rate: a costing carried over
  // from the markup rule holds its margin to six decimals, which reproduces
  // its contract value only to within a few centavos.
  const vatAmount = vatOn(contractValue, rates.vatRate);

  // Codes run within each category, in the order the sheet shows the lines.
  const ordered = [...lines].sort(
    (a, b) =>
      (ranks?.get(a.costCategoryId as string) ?? 0) - (ranks?.get(b.costCategoryId as string) ?? 0) ||
      (a.sortOrder as number) - (b.sortOrder as number),
  );
  const codes = lineCodes(
    ordered.map((l) => ({ rank: ranks?.get(l.costCategoryId as string) ?? 0, isHeading: l.isHeading as boolean })),
  );
  const codeOf = new Map(ordered.map((l, i) => [l.id as string, codes[i]]));

  const plan = planTasks(sections.map((s) => ({ durationDays: s.durationDays, tasks: s.tasks ?? [] })));
  // With a start date the plan's working days become calendar dates (Mon–Sat):
  // derived on every read, never stored, so a changed plan moves them with it.
  const plannedStart = (costing.plannedStart as Date | null) ?? null;
  const on = (day: number | null) => (plannedStart && day ? dayKey(workingDayDate(plannedStart, day)) : null);

  return {
    ...costing,
    ...rates,
    totalCost,
    contractValue,
    marginAmount: round2(contractValue - totalCost),
    vatAmount,
    grandTotal: round2(contractValue + vatAmount),
    grossProfit: round2(contractValue - totalCost),
    // Margin is profit over the contract value, not over cost — the two differ
    // and only one of them is what the business calls margin (model §5.3).
    grossMarginPct: contractValue > 0 ? (contractValue - totalCost) / contractValue : 0,
    validUntil: dayKey(costing.validUntil as Date | null),
    plannedStart: dayKey(plannedStart),
    /** The day the plan's last working day falls on; null without a start date or a plan. */
    plannedFinish: on(plan.totalDays || null),
    lines: ordered.map((l) => ({
      ...l,
      code: ranks ? codeOf.get(l.id as string) ?? null : null,
      /** The bucket's number on the sheet (1 = Materials), which the codes start with. */
      rank: ranks?.get(l.costCategoryId as string) ?? null,
      quantity: num(l.quantity as Prisma.Decimal),
      unitCost: num(l.unitCost as Prisma.Decimal),
      amount: num(l.amount as Prisma.Decimal),
    })),
    scopeSections: sections.map((s, i) => ({
      ...s,
      value: num(s.value as Prisma.Decimal),
      startDay: plan.sections[i].start,
      endDay: plan.sections[i].end,
      planDays: plan.sections[i].days,
      startDate: on(plan.sections[i].start),
      endDate: on(plan.sections[i].end),
      tasks: (s.tasks ?? []).map((t, j) => ({
        ...t,
        start: plan.sections[i].tasks[j].start,
        end: plan.sections[i].tasks[j].end,
        startDate: on(plan.sections[i].tasks[j].start),
        endDate: on(plan.sections[i].tasks[j].end),
      })),
    })),
    planDays: plan.totalDays,
    scopeTotal: sections.reduce((sum, s) => sum + num(s.value as Prisma.Decimal), 0),
  };
}

/**
 * The paper's line under the Scope of Work chart, and the figure the owner
 * asked to see: "Planned duration in working days (Mon–Sat) — 85 working
 * days in all, October 14, 2026 to January 23, 2027."
 */
export function planLegend(planDays: number, start: string | null, finish: string | null): string {
  const days = `${planDays} working day${planDays === 1 ? '' : 's'} in all`;
  const on = (key: string) => formatDate(new Date(`${key}T00:00:00Z`));
  const span = start && finish ? `, ${on(start)} to ${on(finish)}` : '';
  return `Planned duration in working days (Mon–Sat) — ${days}${span}.`;
}

/** Someone with only view_own never sees another person's costing. */
function onlyOwn(me: ReturnType<typeof currentUser>) {
  return !me.isSuperAdmin && !me.permissions.has('gops.costing.view_all');
}

/**
 * A costing's visibility — `view_all`, or its author — and, for a caller with
 * no costing right at all (`requireAnyOrDecider`) or anyone else, a stand-in
 * or approver while it waits on them (`mayDecide`).
 */
async function assertCostingVisible(me: ReturnType<typeof currentUser>, costing: { id: string; ownerId: string }, deciderOnly: boolean) {
  const visible = !deciderOnly && (!onlyOwn(me) || costing.ownerId === me.id);
  if (visible || (await mayDecide(me.id, 'costing', [costing.id]))) return;
  throw forbidden(deciderOnly ? 'You need one of: gops.costing.view_all, gops.costing.view_own' : 'This costing belongs to someone else');
}

// ── List ─────────────────────────────────────────────────────────────────────

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'FINAL'] as const;
type Status = (typeof STATUSES)[number];

/**
 * Which costings a list query means — one rule for the list AND the tiles
 * above it, so a tile's count is the total of the list it links to.
 * `?finalised=this-month` is FINAL with `finalAt` in the current Manila month.
 */
function costingListWhere(me: ReturnType<typeof currentUser>, q: ListQuery): Prisma.CostingWhereInput {
  const where: Prisma.CostingWhereInput = {};

  // Someone with only view_own never sees another person's costing, whatever
  // the scope switch says.
  if (onlyOwn(me) || q.scope === 'mine') where.ownerId = me.id;

  if (q.search) {
    where.OR = [
      { title: { contains: q.search, mode: 'insensitive' } },
      { number: { contains: q.search, mode: 'insensitive' } },
      { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      { systemUnit: { contains: q.search, mode: 'insensitive' } },
    ];
  }
  const status = choice(q.filters.status, STATUSES, 'Status', (st) => (st === 'PENDING_APPROVAL' ? 'Awaiting approval' : statusLabel(st)));
  if (status) where.status = status;
  if (q.filters.finalised === 'this-month') {
    where.status = 'FINAL';
    where.finalAt = { gte: manilaDayStart(`${manilaMonthKey(new Date())}-01`) };
  }
  if (q.filters.customerId) where.customerId = q.filters.customerId;
  // Service Costing is this same screen, narrowed to the costings that back a
  // service contract. A service costing is not a different kind of record —
  // it is a costing whose job happens to be a contract (model §4.5) — so it
  // would be a mistake to give it a second table to drift out of step with.
  const jobType = choice(q.filters.jobType, JobType, 'Project type');
  if (jobType) where.jobs = { some: { type: jobType } };
  // The rows a person ticked (Print selected); the rules above still apply,
  // so an id never prints a costing the caller could not see in the list.
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return where;
}

const COSTING_SORTS = ['number', 'title', 'contractValue', 'createdAt'];

costingRoutes.get(
  '/',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = costingListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.costing.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          // The project the costing became (2026-10-15, the owner's call: the
          // list says when a costing has been converted).
          jobs: { select: { id: true, number: true, name: true, status: true }, orderBy: { createdAt: 'asc' } },
          _count: { select: { lines: true, scopeSections: true } },
        },
        orderBy: orderBy(q, COSTING_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.costing.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...present(r as unknown as Record<string, unknown>),
          lineCount: r._count.lines,
          sectionCount: r._count.scopeSections,
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The Costing page's tiles: being costed (DRAFT), awaiting approval and final
 * this month — each the total of the list its tile opens, through the same
 * `costingListWhere`, under the caller's scope and the page's `jobType`.
 */
costingRoutes.get(
  '/summary',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const base: ListQuery = { ...q, search: '', filters: q.filters.jobType ? { jobType: q.filters.jobType } : {} };
    const count = (filters: Record<string, string>) =>
      prisma.costing.count({ where: costingListWhere(me, { ...base, filters: { ...base.filters, ...filters } }) });
    const [draft, pending, finalThisMonth] = await Promise.all([
      count({ status: 'DRAFT' }),
      count({ status: 'PENDING_APPROVAL' }),
      count({ finalised: 'this-month' }),
    ]);
    res.json({ draft, pending, finalThisMonth });
  }),
);

/**
 * The costing list on paper (rule 6, A5) — the list as filtered, through
 * `costingListWhere`, the list's own query (or, with `?ids=`, the rows
 * ticked, still under it), so the paper never shows a different set from
 * the screen it was printed off; a `view_own` estimator prints their own.
 * The figures the screen shows — contract value, budgeted cost, margin —
 * and nothing it hides. At most LIST_CAP rows, the money block over every
 * costing the filter matched. Audited; declared above `/:id`, or that
 * route swallows it.
 */
costingRoutes.get(
  '/pdf',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = costingListWhere(me, q);
    const f = q.filters;
    const [rows, sums, currency, customer] = await Promise.all([
      prisma.costing.findMany({
        where,
        select: {
          number: true,
          title: true,
          systemUnit: true,
          status: true,
          totalCost: true,
          contractValue: true,
          createdAt: true,
          customer: { select: { name: true } },
          owner: { select: { name: true } },
        },
        orderBy: orderBy(q, COSTING_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.costing.aggregate({ where, _count: { _all: true }, _sum: { totalCost: true, contractValue: true } }),
      companyCurrency(),
      recordNamed('customer', f.customerId),
    ]);
    const count = sums._count._all;

    // "12 costings", or "first 1,000 of 1,234 costings printed" when the cap
    // bit — then every filter `costingListWhere` applied, by name.
    const reference = listReference(count, rows.length, ['costing', 'costings'], [
      q.search ? `search "${q.search}"` : null,
      f.finalised === 'this-month'
        ? 'final this month'
        : f.status
          ? `status ${f.status === 'PENDING_APPROVAL' ? 'Awaiting approval' : statusLabel(f.status)}`
          : null,
      customer,
      f.jobType ? (f.jobType === 'SERVICE_CONTRACT' ? 'service contracts only' : 'projects only') : null,
      onlyOwn(me) || q.scope === 'mine' ? 'mine only' : null,
      f.ids ? 'the rows selected' : null,
    ]);

    // The money block: what the costings cost, the margin they carry as a
    // share of the price, and their contract value — the bold row last.
    // Summed in Decimal; numbers only at the page.
    const cost = sums._sum.totalCost ?? new Prisma.Decimal(0);
    const value = sums._sum.contractValue ?? new Prisma.Decimal(0);
    const margin = value.minus(cost);
    const marginShare = value.gt(0) ? ` (${pct(margin.div(value).toNumber(), 1)} of the price)` : '';

    // Eight columns: landscape, each sized from what it holds (rule 6).
    const pdf = await renderDocument({
      title: 'Costings',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Costing and customer', `Contract value (${currency})`, `Budgeted cost (${currency})`, 'Margin', 'Prepared by', 'Date', 'Status'],
          align: ['left', 'left', 'right', 'right', 'right', 'left', 'left', 'left'],
          rows: rows.map((c) => {
            const cv = num(c.contractValue);
            return [
              c.number,
              { title: c.title, body: [c.customer?.name ?? 'No customer linked', c.systemUnit].filter(Boolean).join(' · ') },
              formatAmount(cv),
              formatAmount(num(c.totalCost)),
              cv > 0 ? pct((cv - num(c.totalCost)) / cv, 1) : '',
              c.owner.name,
              formatShortDate(c.createdAt),
              statusLabel(c.status),
            ];
          }),
        },
        {
          kind: 'totals',
          rows: [
            { label: totalLabel('Budgeted cost', count, rows.length), value: formatMoney(num(cost), currency) },
            { label: `Margin${marginShare}`, value: formatMoney(num(margin), currency) },
            { label: totalLabel('Total contract value', count, rows.length), value: formatMoney(num(value), currency), bold: true },
          ],
        },
      ],
    });

    await audit(
      { entityType: 'costing', entityId: 'list', action: 'EXPORTED', summary: `Exported the costing list as PDF (${rows.length} costing(s))` },
      req,
    );
    sendListPdf(res, pdf, 'costings.pdf');
  }),
);

costingRoutes.get(
  '/lookup',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const where: Prisma.CostingWhereInput = onlyOwn(me) ? { ownerId: me.id } : {};

    // `?status=FINAL` (or a comma list) lets a picker leave DRAFT costings out —
    // a project is built on a final costing, and a picker that offers drafts
    // offers budgets that are still moving. `?q=` narrows by number, title or
    // customer, the same three fields the list searches.
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const statuses = status
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is Status => (STATUSES as readonly string[]).includes(s));
    if (statuses.length === 1) where.status = statuses[0];
    else if (statuses.length > 1) where.status = { in: statuses };

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { number: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const rows = await prisma.costing.findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        contractValue: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rows.map((r) => ({ ...r, contractValue: num(r.contractValue) })));
  }),
);

// ── Predictions: what was typed before ───────────────────────────────────────

/**
 * Past cost lines matching what is being typed, newest price first, plus
 * matching items from the item master — so a line is picked rather than
 * retyped, and costs what it cost last time until somebody says otherwise.
 *
 * Only from costings the caller may read: a `view_own` estimator is offered
 * their own history and the item master, never a colleague's unit costs.
 */
costingRoutes.get(
  '/suggest',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : '';
    if (q.length < 2) return res.json([]);

    const past = await prisma.costingLine.findMany({
      where: {
        isHeading: false,
        ...(categoryId ? { costCategoryId: categoryId } : {}),
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
        costing: onlyOwn(me) ? { ownerId: me.id } : {},
      },
      select: {
        name: true,
        description: true,
        unit: true,
        unitCost: true,
        costCategoryId: true,
        itemId: true,
        costing: { select: { number: true, createdAt: true } },
      },
      orderBy: { costing: { createdAt: 'desc' } },
      take: 400,
    });

    // One row per name: the newest use sets the price, and the count says how
    // often it has been costed, which is what ranks a habit above a one-off.
    const byName = new Map<
      string,
      {
        name: string;
        description: string;
        unit: string;
        unitCost: number;
        costCategoryId: string;
        itemId: string | null;
        source: 'history';
        uses: number;
        lastNumber: string;
        lastUsed: Date;
      }
    >();
    for (const l of past) {
      const name = (l.name || l.description).trim();
      const key = name.toUpperCase();
      const seen = byName.get(key);
      if (seen) {
        seen.uses++;
        continue;
      }
      byName.set(key, {
        name,
        description: l.name && l.description !== l.name ? l.description : '',
        unit: l.unit,
        unitCost: num(l.unitCost),
        costCategoryId: l.costCategoryId,
        itemId: l.itemId,
        source: 'history',
        uses: 1,
        lastNumber: l.costing.number,
        lastUsed: l.costing.createdAt,
      });
    }
    const starts = (s: string) => s.toUpperCase().startsWith(q.toUpperCase());
    const history = [...byName.values()]
      .sort((a, b) => Number(starts(b.name)) - Number(starts(a.name)) || b.uses - a.uses || +b.lastUsed - +a.lastUsed)
      .slice(0, 10);

    const items = await prisma.item.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { code: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, code: true, name: true, description: true, unit: true, standardCost: true },
      orderBy: { name: 'asc' },
      take: 6,
    });
    const named = new Set(history.map((h) => h.name.toUpperCase()));

    res.json([
      ...history,
      ...items
        .filter((i) => !named.has(i.name.toUpperCase()))
        .map((i) => ({
          name: i.name,
          description: i.description ?? '',
          unit: i.unit,
          unitCost: i.standardCost == null ? null : num(i.standardCost),
          costCategoryId: null,
          itemId: i.id,
          itemCode: i.code,
          source: 'item' as const,
          uses: 0,
        })),
    ]);
  }),
);

/**
 * The short lists the sheet's inputs offer as you type: units, System / Unit
 * names, phase and task names — the most used first — the caller's own
 * latest Terms & Conditions, which a new costing starts from, and the scope
 * of work it opens on (`SCOPE_PRELOAD`).
 */
/**
 * Supplier names for a line's Supplier box (2026-10-14): active suppliers by
 * name or code, names only, behind the costing's own right — an engineer
 * costing a job need not read the supplier master to name who supplies a line.
 */
costingRoutes.get(
  '/suggest/suppliers',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const term = String(req.query.q ?? '').trim().slice(0, 100);
    const rows = await prisma.supplier.findMany({
      where: {
        isActive: true,
        ...(term
          ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { code: { contains: term, mode: 'insensitive' } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 15,
      select: { id: true, name: true },
    });
    res.json(rows);
  }),
);

costingRoutes.get(
  '/suggest/lists',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const visible: Prisma.CostingWhereInput = onlyOwn(me) ? { ownerId: me.id } : {};
    const [units, systems, phases, tasks, lastTerms, company] = await Promise.all([
      prisma.costingLine.groupBy({
        by: ['unit'],
        where: { isHeading: false, costing: visible },
        _count: { unit: true },
        orderBy: { _count: { unit: 'desc' } },
        take: 40,
      }),
      prisma.costing.groupBy({
        by: ['systemUnit'],
        where: { ...visible, systemUnit: { not: null } },
        _count: { systemUnit: true },
        orderBy: { _count: { systemUnit: 'desc' } },
        take: 60,
      }),
      prisma.scopeSection.groupBy({
        by: ['name'],
        where: { costing: visible },
        _count: { name: true },
        orderBy: { _count: { name: 'desc' } },
        take: 60,
      }),
      prisma.scopeTask.groupBy({
        by: ['name'],
        where: { scopeSection: { costing: visible } },
        _count: { name: true },
        orderBy: { _count: { name: 'desc' } },
        take: 150,
      }),
      prisma.costing.findFirst({
        where: { ownerId: me.id, terms: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { terms: true },
      }),
      prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } }),
    ]);
    res.json({
      units: units.map((u) => u.unit).filter(Boolean),
      systemUnits: systems.map((s) => s.systemUnit).filter(Boolean),
      phases: phases.map((p) => p.name),
      tasks: tasks.map((t) => t.name),
      terms: lastTerms?.terms ?? null,
      // What a new sheet's VAT toggle switches on.
      companyVatRate: company ? Number(company.vatRate) : 0.12,
      // The scope of work a new sheet opens on (2026-10-13, the owner's sheet).
      scopePreload: SCOPE_PRELOAD,
    });
  }),
);

// ── Templates ────────────────────────────────────────────────────────────────

/** A template line names its category by CODE, which never changes (isSystem rows). */
const templateLineSchema = z.object({
  category: z.string().min(1),
  isHeading: z.boolean().default(false),
  name: z.string().max(300).nullable().default(null),
  description: z.string().max(5000).default(''),
  quantity: z.number().min(0).default(0),
  unit: z.string().max(30).default('pcs'),
  unitCost: z.number().min(0).default(0),
  itemId: z.string().nullable().default(null),
});
const templateSectionSchema = z.object({
  kind: z.enum(['MAIN_WORK', 'TESTING_COMMISSIONING', 'TURNOVER', 'OTHER']).default('MAIN_WORK'),
  name: z.string(),
  description: z.string().nullable().default(null),
  durationDays: z.number().int().min(0).default(0),
  tasks: z
    .array(z.object({ name: z.string(), startDay: z.number().int().nullable().default(null), durationDays: z.number().int().min(0).default(0) }))
    .default([]),
});
const templateBodySchema = z
  .object({
    systemUnit: z.string().nullable().default(null),
    /** The margin on the price (2026-10-09); a template saved before carries a markup, read as the margin it amounts to. */
    marginPct: z.number().optional(),
    markupPct: z.number().optional(),
    terms: z.string().nullable().default(null),
    lines: z.array(templateLineSchema).default([]),
    sections: z.array(templateSectionSchema).default([]),
  })
  .transform(({ marginPct, markupPct, ...rest }) => ({ ...rest, marginPct: marginPct ?? marginOfMarkup(markupPct ?? 0) }));
type TemplateBody = z.infer<typeof templateBodySchema>;

function readTemplateBody(json: Prisma.JsonValue): TemplateBody {
  const parsed = templateBodySchema.safeParse(json);
  return parsed.success ? parsed.data : templateBodySchema.parse({});
}

costingRoutes.get(
  '/templates',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.costingTemplate.findMany({
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(
      rows.map((t) => {
        const body = readTemplateBody(t.body);
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          withPrices: t.withPrices,
          createdBy: t.createdBy,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          systemUnit: body.systemUnit,
          lineCount: body.lines.filter((l) => !l.isHeading).length,
          sectionCount: body.sections.length,
          taskCount: body.sections.reduce((n, s) => n + s.tasks.length, 0),
          canEdit: canEditRecord(me, 'gops', 'costing', t.createdById),
        };
      }),
    );
  }),
);

/** One template, its lines' categories resolved to ids for the sheet to load. */
costingRoutes.get(
  '/templates/:templateId',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const t = await prisma.costingTemplate.findUnique({
      where: { id: req.params.templateId },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    if (!t) throw notFound('Template not found');
    const body = readTemplateBody(t.body);
    const cats = await prisma.costCategory.findMany({ select: { id: true, code: true } });
    const idOf = new Map(cats.map((c) => [c.code, c.id]));
    res.json({
      id: t.id,
      name: t.name,
      description: t.description,
      withPrices: t.withPrices,
      createdBy: t.createdBy,
      ...body,
      // A line whose category no longer exists lands in the first bucket
      // rather than vanishing from the template.
      lines: body.lines.map((l) => ({ ...l, costCategoryId: idOf.get(l.category) ?? cats[0]?.id ?? null })),
    });
  }),
);

const templateSchema = z.object({
  name: z.string().trim().min(2, 'Name the template').max(120),
  description: z.string().trim().max(500).optional().nullable(),
  /** Copy a saved costing… */
  costingId: z.string().optional(),
  /** …or the sheet as it stands in the editor, saved or not. */
  sheet: z
    .object({
      systemUnit: z.string().max(200).optional().nullable(),
      marginPct: z.number().gt(-0.95).lt(0.95).optional(),
      terms: z.string().max(20000).optional().nullable(),
      lines: z.array(z.lazy(() => sheetLineSchema)).max(1000).default([]),
      sections: z.array(z.lazy(() => sheetSectionSchema)).max(100).default([]),
    })
    .optional(),
  /** Off: quantities and names only, every unit cost zero — for a scope whose prices go stale. */
  withPrices: z.boolean().default(true),
});

costingRoutes.post(
  '/templates',
  require_('gops.costing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(templateSchema, req.body);
    const cats = await prisma.costCategory.findMany({ select: { id: true, code: true } });
    const codeOf = new Map(cats.map((c) => [c.id, c.code]));

    let content: TemplateBody;
    if (body.costingId) {
      const source = await prisma.costing.findUnique({
        where: { id: body.costingId },
        include: {
          lines: { orderBy: { sortOrder: 'asc' } },
          scopeSections: { orderBy: { sortOrder: 'asc' }, include: { tasks: { orderBy: { sortOrder: 'asc' } } } },
        },
      });
      if (!source) throw notFound('Costing not found');
      if (onlyOwn(me) && source.ownerId !== me.id) throw forbidden('This costing belongs to someone else');
      content = {
        systemUnit: source.systemUnit,
        marginPct: num(source.marginPct),
        terms: source.terms,
        lines: source.lines.map((l) => ({
          category: codeOf.get(l.costCategoryId) ?? '',
          isHeading: l.isHeading,
          name: l.name,
          description: l.description,
          quantity: num(l.quantity),
          unit: l.unit,
          unitCost: num(l.unitCost),
          itemId: l.itemId,
        })),
        sections: source.scopeSections.map((s) => ({
          kind: s.kind,
          name: s.name,
          description: s.description,
          durationDays: s.durationDays,
          tasks: s.tasks.map((t) => ({ name: t.name, startDay: t.startDay, durationDays: t.durationDays })),
        })),
      };
    } else if (body.sheet) {
      const sheet = body.sheet;
      content = {
        systemUnit: sheet.systemUnit ?? null,
        marginPct: sheet.marginPct ?? 0,
        terms: sheet.terms ?? null,
        lines: sheet.lines.map((l) => ({
          category: codeOf.get(l.costCategoryId) ?? '',
          isHeading: !!l.isHeading,
          name: l.name?.trim() || null,
          description: l.description?.trim() || '',
          quantity: l.quantity ?? 0,
          unit: l.unit?.trim() || 'pcs',
          unitCost: l.unitCost ?? 0,
          itemId: l.itemId ?? null,
        })),
        sections: sheet.sections.map((s) => ({
          kind: s.kind,
          name: s.name,
          description: s.description ?? null,
          durationDays: s.durationDays,
          tasks: s.tasks.map((t) => ({ name: t.name, startDay: t.startDay ?? null, durationDays: t.durationDays })),
        })),
      };
    } else {
      throw badRequest('Save a template from a costing or from the sheet being edited');
    }
    if (content.lines.some((l) => !l.category)) throw badRequest('A line names a cost category that does not exist');
    if (!body.withPrices) content.lines = content.lines.map((l) => ({ ...l, unitCost: 0 }));

    const t = await prisma.costingTemplate.create({
      data: {
        name: body.name,
        description: body.description || null,
        withPrices: body.withPrices,
        body: content as unknown as Prisma.InputJsonValue,
        createdById: me.id,
      },
    });
    await audit(
      {
        entityType: 'costing_template',
        entityId: t.id,
        action: 'CREATED',
        summary: `Saved costing template "${t.name}" — ${content.lines.length} line(s), ${content.sections.length} phase(s)`,
      },
      req,
    );
    res.status(201).json({ id: t.id, name: t.name });
  }),
);

async function templateForEdit(req: Parameters<typeof currentUser>[0]) {
  const me = currentUser(req);
  const t = await prisma.costingTemplate.findUnique({ where: { id: req.params.templateId } });
  if (!t) throw notFound('Template not found');
  if (!canEditRecord(me, 'gops', 'costing', t.createdById)) {
    throw forbidden('Only whoever saved this template can change it');
  }
  return t;
}

costingRoutes.patch(
  '/templates/:templateId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const before = await templateForEdit(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().max(500).optional().nullable(),
      }),
      req.body,
    );
    const t = await prisma.costingTemplate.update({
      where: { id: before.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
      },
    });
    await audit(
      { entityType: 'costing_template', entityId: t.id, action: 'UPDATED', summary: `Renamed costing template "${before.name}" → "${t.name}"` },
      req,
    );
    res.json({ id: t.id, name: t.name, description: t.description });
  }),
);

costingRoutes.delete(
  '/templates/:templateId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const t = await templateForEdit(req);
    // Nothing points at a template: a costing started from one keeps no link.
    await prisma.costingTemplate.delete({ where: { id: t.id } });
    await audit(
      { entityType: 'costing_template', entityId: t.id, action: 'DELETED', summary: `Deleted costing template "${t.name}"` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Read one ─────────────────────────────────────────────────────────────────

async function loadFull(id: string, tx: Tx = prisma) {
  return tx.costing.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, code: true } },
      site: { select: { id: true, name: true, address: true, city: true } },
      owner: { select: { id: true, name: true, position: true } },
      assignedBy: { select: { id: true, name: true } },
      lead: { select: { id: true, number: true, companyName: true, status: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          costCategory: { select: { id: true, code: true, name: true, sortOrder: true } },
          item: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, code: true, name: true } },
        },
      },
      scopeSections: {
        orderBy: { sortOrder: 'asc' },
        include: { tasks: { orderBy: { sortOrder: 'asc' } } },
      },
      quotationRevisions: {
        select: {
          id: true,
          revision: true,
          status: true,
          quotation: { select: { id: true, number: true, subject: true } },
        },
      },
      // Where the costing went: the jobs built on it. Rendered as the "next
      // step" on the page, so a costing that already became a project says so
      // instead of offering to create a second one.
      jobs: {
        select: { id: true, number: true, name: true, status: true, type: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

/** Whether costings go through the approval engine here, i.e. a costing workflow is active. */
async function approvalConfigured(amount: number): Promise<boolean> {
  return !!(await pickWorkflow('costing', amount));
}

costingRoutes.get(
  '/:id',
  requireAnyOrDecider('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await loadFull(req.params.id);
    if (!costing) throw notFound('Costing not found');
    await assertCostingVisible(me, costing, res.locals.deciderOnly === true);

    const [ranks, company, configured] = await Promise.all([
      categoryRanks(),
      prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } }),
      approvalConfigured(num(costing.contractValue)),
    ]);
    const canEdit = canEditRecord(me, 'gops', 'costing', costing.ownerId);
    res.json({
      ...present(costing as unknown as Record<string, unknown>, ranks),
      canEdit,
      companyVatRate: company ? Number(company.vatRate) : 0.12,
      // With a costing workflow active, FINAL is reached by approval and the
      // page offers "Submit for approval"; without one, "Mark final" as before.
      approvalConfigured: configured,
    });
  }),
);

// ── The sheet: header, lines and scope in one save ───────────────────────────

/**
 * The lead stages a new costing advances from. Anything at or past COSTING is
 * left alone — re-costing a lead in NEGOTIATION is normal and must not reset
 * where the salesperson has got to.
 */
const LEAD_STAGES_BEFORE_COSTING = new Set(['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const sheetLineSchema = z
  .object({
    /** A line already on this costing keeps its id; anything else is created. */
    id: z.string().optional(),
    costCategoryId: z.string().min(1, 'Choose a cost category'),
    itemId: z.string().optional().nullable(),
    /** A subheading: printed as a heading row inside its category, costs nothing. */
    isHeading: z.boolean().optional(),
    name: z.string().trim().max(300).optional().nullable(),
    description: z.string().trim().max(5000).optional().nullable(),
    quantity: z.number().min(0).max(1e9).default(0),
    unit: z.string().trim().max(30).optional().nullable(),
    unitCost: z.number().min(0).max(1e12).default(0),
    /** Who supplies it: a supplier on file, else a name typed (kept as text). */
    supplierId: z.string().optional().nullable(),
    supplierName: z.string().trim().max(200).optional().nullable(),
    /** A short note, printed under the supplier. */
    lineNote: z.string().trim().max(500).optional().nullable(),
  })
  .refine((l) => !!(l.name?.trim() || l.description?.trim()), { message: 'Name the line', path: ['name'] });

const sheetTaskSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'Name the task').max(300),
  /** Working day the task starts (day 1 = the first). Empty: the day after the task before it ends. */
  startDay: z.number().int().min(1).max(3650).optional().nullable(),
  durationDays: z.number().int().min(0).max(3650).default(0),
});

const sheetSectionSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['MAIN_WORK', 'TESTING_COMMISSIONING', 'TURNOVER', 'OTHER']).default('MAIN_WORK'),
  name: z.string().trim().min(2, 'Name the phase').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  durationDays: z.number().int().min(0).max(3650).default(0),
  value: z.number().min(0).default(0),
  /** Where the value comes from (2026-10-13): SPREAD (default), DECLARED, or CATEGORY with its buckets. */
  valueSource: z.enum(['SPREAD', 'DECLARED', 'CATEGORY']).default('SPREAD'),
  costCategoryIds: z.array(z.string()).max(10).default([]),
  tasks: z.array(sheetTaskSchema).max(200).default([]),
});

const headerSchema = z.object({
  title: z.string().trim().min(2, 'Give the costing a title').max(300),
  customerId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  /** The lead this costing answers. Set on creation from "Start costing". */
  leadId: z.string().optional().nullable(),
  /** The gross margin on the price, a fraction: ±95% at most — at 100% there is no price. */
  marginPct: z.number().gt(-0.95, 'A margin of −95% or below prices nothing').lt(0.95, 'A margin of 95% or more is no price at all').optional(),
  /** A fixed price, net of VAT (2026-10-13): the contract value as typed; null prices from the margin again. */
  targetContractValue: z.number().gt(0, 'A price above zero').max(1e13).nullable().optional(),
  /** The company's VAT rate, or 0 for a zero-rated job — see `checkVatRate`. */
  vatRate: z.number().min(0).max(1).optional(),
  validUntil: z.string().regex(DAY, 'Use a date').optional().nullable(),
  /** The day the scope of work starts; the finish is derived from the plan. */
  plannedStart: z.string().regex(DAY, 'Use a date').optional().nullable(),
  systemUnit: z.string().trim().max(200).optional().nullable(),
  durationDays: z.number().int().min(0).optional().nullable(),
  notes: z.string().max(20000).optional().nullable(),
  terms: z.string().max(20000).optional().nullable(),
});

const sheetSchema = headerSchema.extend({
  lines: z.array(sheetLineSchema).max(1000, 'A costing takes at most 1,000 lines').optional(),
  sections: z.array(sheetSectionSchema).max(100).optional(),
  /** Keep the schedule of values equal to the contract value: spread it on save. */
  spread: z.boolean().optional(),
});

type SheetBody = z.infer<typeof sheetSchema>;

/**
 * The estimate's VAT is the company's rate or zero (a PEZA/BOI or export job),
 * as on the quotation. A costing may keep the rate it was saved with after
 * Settings change — that is the snapshot, not a third rate.
 */
async function checkVatRate(rate: number | undefined, keep?: number): Promise<number | undefined> {
  if (rate === undefined) return undefined;
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
  const companyRate = company ? Number(company.vatRate) : 0.12;
  const same = (a: number, b: number) => Math.abs(a - b) < 0.00005;
  if (same(rate, 0) || same(rate, companyRate) || (keep !== undefined && same(rate, keep))) return rate;
  throw badRequest(`VAT is the company rate (${(companyRate * 100).toFixed(0)}%) or 0%`, [
    { field: 'vatRate', message: 'Choose the company rate or 0%' },
  ]);
}

/** Refuses ids that are not what they claim, before anything is written. */
async function checkReferences(body: SheetBody, tx: Tx) {
  const catIds = new Set((body.lines ?? []).map((l) => l.costCategoryId));
  if (catIds.size) {
    const found = await tx.costCategory.count({ where: { id: { in: [...catIds] } } });
    if (found !== catIds.size) throw badRequest('A line names a cost category that does not exist');
  }
  const itemIds = new Set((body.lines ?? []).map((l) => l.itemId).filter((v): v is string => !!v));
  if (itemIds.size) {
    const found = await tx.item.count({ where: { id: { in: [...itemIds] } } });
    if (found !== itemIds.size) throw badRequest('A line names an item that does not exist');
  }
  const supplierIds = new Set((body.lines ?? []).map((l) => l.supplierId).filter((v): v is string => !!v));
  if (supplierIds.size) {
    const found = await tx.supplier.count({ where: { id: { in: [...supplierIds] } } });
    if (found !== supplierIds.size) throw badRequest('A line names a supplier that does not exist');
  }
  if (body.siteId && body.customerId) {
    const site = await tx.customerSite.findUnique({ where: { id: body.siteId }, select: { customerId: true } });
    if (!site || site.customerId !== body.customerId) throw badRequest('That location is not one of the customer\'s sites');
  }
  // A phase priced from cost names its buckets, each real and each on one phase only —
  // a bucket on two phases would count its money twice.
  const seen = new Map<string, string>();
  for (const sec of body.sections ?? []) {
    if (sec.valueSource !== 'CATEGORY') continue;
    if (!sec.costCategoryIds.length) throw badRequest(`Choose the cost the phase “${sec.name}” takes its value from`);
    for (const id of new Set(sec.costCategoryIds)) {
      const other = seen.get(id);
      if (other) throw badRequest(`One cost bucket is on both “${other}” and “${sec.name}” — its money would count twice`);
      seen.set(id, sec.name);
    }
  }
  if (seen.size) {
    const found = await tx.costCategory.count({ where: { id: { in: [...seen.keys()] } } });
    if (found !== seen.size) throw badRequest('A phase names a cost category that does not exist');
  }
}

const asDay = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : null);

/**
 * Writes the sheet's lines and scope against a costing, inside the caller's
 * transaction. Rows that exist keep their ids (a line or phase is updated in
 * place, never deleted and recreated), rows left out are removed, and the
 * order on the page is the order stored.
 */
/**
 * A supplier typed by name that is ON FILE (one active supplier of that name,
 * case- and space-blind) is linked; anything else stays the words typed.
 */
async function suppliersByName(tx: Tx, lines: SheetBody['lines']) {
  const key = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();
  const names = [...new Set((lines ?? []).filter((l) => !l.supplierId && l.supplierName?.trim()).map((l) => key(l.supplierName!)))];
  const found = new Map<string, string | null>();
  if (!names.length) return { key, found };
  const rows = await tx.supplier.findMany({
    where: { isActive: true, OR: names.map((n) => ({ name: { equals: n, mode: 'insensitive' as const } })) },
    select: { id: true, name: true },
  });
  for (const r of rows) {
    const k = key(r.name);
    // Two suppliers of one name: link neither — the words stay as typed.
    found.set(k, found.has(k) ? null : r.id);
  }
  return { key, found };
}

async function writeSheet(tx: Tx, costingId: string, body: SheetBody) {
  if (body.lines) {
    const byName = await suppliersByName(tx, body.lines);
    const own = new Set((await tx.costingLine.findMany({ where: { costingId }, select: { id: true } })).map((l) => l.id));
    const kept = body.lines.map((l) => l.id).filter((id): id is string => !!id && own.has(id));
    await tx.costingLine.deleteMany({ where: { costingId, id: { notIn: kept } } });
    for (const [i, l] of body.lines.entries()) {
      const heading = !!l.isHeading;
      const name = l.name?.trim() || null;
      const data = {
        costCategoryId: l.costCategoryId,
        itemId: heading ? null : l.itemId || null,
        isHeading: heading,
        name,
        // The description is what every older reader of a cost line prints, so
        // a line typed as a name alone carries it there too.
        description: l.description?.trim() || name || '',
        quantity: d(heading ? 0 : l.quantity),
        unit: l.unit?.trim() || 'pcs',
        unitCost: d(heading ? 0 : l.unitCost),
        amount: d(heading ? 0 : lineAmount(l.quantity, l.unitCost)),
        sortOrder: i,
        // A supplier on file wins; a typed name is kept only without one.
        ...(() => {
          if (heading) return { supplierId: null, supplierName: null };
          const linked = l.supplierId || (l.supplierName?.trim() ? byName.found.get(byName.key(l.supplierName)) : null) || null;
          return { supplierId: linked, supplierName: linked ? null : l.supplierName?.trim().replace(/\s+/g, ' ') || null };
        })(),
        lineNote: heading ? null : l.lineNote?.trim() || null,
      };
      if (l.id && own.has(l.id)) await tx.costingLine.update({ where: { id: l.id }, data });
      else await tx.costingLine.create({ data: { ...data, costingId } });
    }
  }

  if (body.sections) {
    const plan = planTasks(body.sections.map((s) => ({ durationDays: s.durationDays, tasks: s.tasks })));
    const own = new Set((await tx.scopeSection.findMany({ where: { costingId }, select: { id: true } })).map((s) => s.id));
    const kept = body.sections.map((s) => s.id).filter((id): id is string => !!id && own.has(id));
    await tx.scopeSection.deleteMany({ where: { costingId, id: { notIn: kept } } });

    for (const [i, s] of body.sections.entries()) {
      const data = {
        kind: s.kind,
        name: s.name,
        description: s.description?.trim() || null,
        // A phase with tasks lasts as long as they do; one without keeps what was typed.
        durationDays: s.tasks.length ? plan.sections[i].days : s.durationDays,
        value: d(s.value),
        valueSource: s.valueSource,
        costCategoryIds: s.valueSource === 'CATEGORY' ? [...new Set(s.costCategoryIds)] : [],
        sortOrder: i,
      };
      let sectionId: string;
      if (s.id && own.has(s.id)) {
        sectionId = s.id;
        await tx.scopeSection.update({ where: { id: s.id }, data });
      } else {
        sectionId = (await tx.scopeSection.create({ data: { ...data, costingId } })).id;
      }

      const ownTasks = new Set(
        (await tx.scopeTask.findMany({ where: { scopeSectionId: sectionId }, select: { id: true } })).map((t) => t.id),
      );
      const keptTasks = s.tasks.map((t) => t.id).filter((id): id is string => !!id && ownTasks.has(id));
      await tx.scopeTask.deleteMany({ where: { scopeSectionId: sectionId, id: { notIn: keptTasks } } });
      for (const [j, t] of s.tasks.entries()) {
        const taskData = { name: t.name, startDay: t.startDay ?? null, durationDays: t.durationDays, sortOrder: j };
        if (t.id && ownTasks.has(t.id)) await tx.scopeTask.update({ where: { id: t.id }, data: taskData });
        else await tx.scopeTask.create({ data: { ...taskData, scopeSectionId: sectionId } });
      }
    }

    // The costing's duration is the plan's, once there is a plan.
    if (plan.totalDays > 0) await tx.costing.update({ where: { id: costingId }, data: { durationDays: plan.totalDays } });
  }

  await recalc(costingId, tx, { strict: true });
  // Cost-priced phases follow the cost on every save; the rest spread only when asked.
  await spreadSections(tx, costingId, { spread: !!body.spread, strict: !!body.spread });
}

costingRoutes.post(
  '/',
  require_('gops.costing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema, req.body);
    const vatRate = await checkVatRate(body.vatRate);
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });

    const { costing, leadMoved } = await prisma.$transaction(async (tx) => {
      // "Start costing" from a lead. The costing takes the lead's customer and
      // site unless the body names its own, and the lead advances to COSTING —
      // but only from the stages before it. A lead already in NEGOTIATION, or
      // WON, must not be dragged backwards because somebody re-costed it.
      let lead: { id: string; number: string; customerId: string | null; siteId: string | null; status: string } | null =
        null;
      if (body.leadId) {
        lead = await tx.lead.findUnique({
          where: { id: body.leadId },
          select: { id: true, number: true, customerId: true, siteId: true, status: true },
        });
        if (!lead) throw notFound('Lead not found');
      }
      // Everything that can be refused is refused before the number is taken.
      await checkReferences(body, tx);

      const number = await nextNumber('costing', tx);
      const created = await tx.costing.create({
        data: {
          number,
          title: body.title,
          customerId: body.customerId || lead?.customerId || null,
          siteId: body.siteId || (body.customerId ? null : lead?.siteId) || null,
          leadId: lead?.id ?? null,
          ownerId: me.id,
          marginPct: d(body.marginPct ?? 0),
          targetContractValue: body.targetContractValue ? d(body.targetContractValue) : null,
          // Snapshotted, like a quotation revision's: a Settings change later
          // does not reprint the tax this estimate was made with.
          vatRate: d(vatRate ?? (company ? Number(company.vatRate) : 0.12)),
          validUntil: asDay(body.validUntil),
          plannedStart: asDay(body.plannedStart),
          systemUnit: body.systemUnit?.trim() || null,
          durationDays: body.durationDays ?? null,
          notes: body.notes || null,
          terms: body.terms || null,
        },
      });
      await writeSheet(tx, created.id, body);

      let moved = false;
      if (lead && LEAD_STAGES_BEFORE_COSTING.has(lead.status)) {
        await tx.lead.update({ where: { id: lead.id }, data: { status: 'COSTING' } });
        moved = true;
      }
      return { costing: (await loadFull(created.id, tx))!, leadMoved: moved ? lead : null };
    });

    await audit(
      {
        entityType: 'costing',
        entityId: costing.id,
        action: 'CREATED',
        summary: `Created costing ${costing.number} — ${costing.title}${costing.leadId ? ` (from lead)` : ''}`,
      },
      req,
    );
    if (leadMoved) {
      await audit(
        {
          entityType: 'lead',
          entityId: leadMoved.id,
          action: 'UPDATED',
          summary: `Lead ${leadMoved.number} moved to COSTING — costing ${costing.number} started`,
        },
        req,
      );
    }
    res.status(201).json(present(costing as unknown as Record<string, unknown>, await categoryRanks()));
  }),
);

/**
 * "Assign costing" on a lead: the salesperson hands the pricing to an
 * estimator. A DRAFT costing is created in the ASSIGNEE's name (they own it
 * and edit it), carrying the lead, its customer and site, who assigned it,
 * when, and the note. The lead moves to COSTING forwards only, as "Start
 * costing" does. The caller needs the right to edit the lead, not to cost —
 * the assignee is the one who must hold gops.costing.create.
 */
const assignSchema = z.object({
  leadId: z.string().min(1),
  assigneeId: z.string().min(1, 'Choose who will do the costing'),
  note: z.string().trim().max(2000).optional().nullable(),
});

costingRoutes.post(
  '/assign',
  require_('gops.leads.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(assignSchema, req.body);

    const { costing, leadMoved, lead } = await prisma.$transaction(async (tx) => {
      // Everything that can be refused is refused before the number is taken.
      const lead = await tx.lead.findUnique({
        where: { id: body.leadId },
        select: { id: true, number: true, companyName: true, description: true, customerId: true, siteId: true, status: true, assignedToId: true },
      });
      if (!lead) throw notFound('Lead not found');
      if (!canEditRecord(me, 'gops', 'leads', lead.assignedToId)) {
        throw forbidden('This lead is assigned to someone else');
      }
      if (lead.status === 'WON' || lead.status === 'LOST') throw badRequest(`This lead is ${lead.status.toLowerCase()} — there is nothing to cost`);
      const assignee = await resolveUser(body.assigneeId);
      if (!assignee) throw badRequest('That person is not an active user');
      if (!can(assignee, 'gops.costing.create')) throw badRequest(`${assignee.name} cannot make costings — pick someone who does`);

      const company = await tx.company.findUnique({ where: { id: 'company' }, select: { vatRate: true } });
      const what = (lead.description ?? '').split('\n')[0].trim();
      const title = (what ? `${lead.companyName} — ${what}` : lead.companyName).slice(0, 200);

      const number = await nextNumber('costing', tx);
      const created = await tx.costing.create({
        data: {
          number,
          title,
          customerId: lead.customerId,
          siteId: lead.siteId,
          leadId: lead.id,
          ownerId: assignee.id,
          vatRate: d(company ? Number(company.vatRate) : 0.12),
          assignedById: me.id,
          assignedAt: new Date(),
          assignmentNote: body.note || null,
        },
      });
      let moved = false;
      if (LEAD_STAGES_BEFORE_COSTING.has(lead.status)) {
        await tx.lead.update({ where: { id: lead.id }, data: { status: 'COSTING' } });
        moved = true;
      }
      return { costing: created, leadMoved: moved, lead };
    });

    if (costing.ownerId !== me.id) {
      await notify({
        userId: costing.ownerId,
        type: 'system',
        title: `Costing assigned to you: ${costing.title}`,
        body: `${costing.number} · from ${me.name}${costing.assignmentNote ? ` — ${costing.assignmentNote}` : ''}`,
        link: `/g-ops/costing/${costing.id}`,
      });
    }
    await audit(
      {
        entityType: 'costing',
        entityId: costing.id,
        action: 'CREATED',
        summary: `Assigned costing ${costing.number} — ${costing.title} — to ${costing.ownerId === me.id ? 'themselves' : (await prisma.user.findUnique({ where: { id: costing.ownerId }, select: { name: true } }))?.name} from lead ${lead.number}`,
        after: { ownerId: costing.ownerId, leadId: lead.id, assignmentNote: costing.assignmentNote },
      },
      req,
    );
    if (leadMoved) {
      await audit(
        {
          entityType: 'lead',
          entityId: lead.id,
          action: 'UPDATED',
          summary: `Lead ${lead.number} moved to COSTING — costing ${costing.number} assigned`,
        },
        req,
      );
    }
    res.status(201).json({ id: costing.id, number: costing.number, ownerId: costing.ownerId });
  }),
);

/** Loads a costing and refuses unless this user may edit it. */
async function forEdit(req: Parameters<typeof currentUser>[0], id: string) {
  const me = currentUser(req);
  const costing = await prisma.costing.findUnique({ where: { id } });
  if (!costing) throw notFound('Costing not found');
  if (!canEditRecord(me, 'gops', 'costing', costing.ownerId)) {
    throw forbidden('Only the author can edit this costing');
  }
  // A FINAL costing is a commercial record — an approved quotation and, later,
  // a project budget are derived from it. Reopen it deliberately.
  if (costing.status === 'FINAL') {
    throw badRequest('This costing is final. Set it back to draft before changing it.');
  }
  // One under approval is what the approver is looking at; it holds still.
  if (costing.status === 'PENDING_APPROVAL') {
    throw badRequest('This costing is with the approver. It can be changed once they decide.');
  }
  return costing;
}

/** Every field of the header that was sent, as a Prisma update. */
function headerData(body: Partial<z.infer<typeof headerSchema>>, vatRate: number | undefined): Prisma.CostingUpdateInput {
  const data: Prisma.CostingUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.notes !== undefined) data.notes = body.notes || null;
  if (body.terms !== undefined) data.terms = body.terms || null;
  if (body.durationDays !== undefined) data.durationDays = body.durationDays ?? null;
  if (body.marginPct !== undefined) data.marginPct = d(body.marginPct);
  if (body.targetContractValue !== undefined) data.targetContractValue = body.targetContractValue ? d(body.targetContractValue) : null;
  if (vatRate !== undefined) data.vatRate = d(vatRate);
  if (body.validUntil !== undefined) data.validUntil = asDay(body.validUntil);
  if (body.plannedStart !== undefined) data.plannedStart = asDay(body.plannedStart);
  if (body.systemUnit !== undefined) data.systemUnit = body.systemUnit?.trim() || null;
  if (body.customerId !== undefined) {
    data.customer = body.customerId ? { connect: { id: body.customerId } } : { disconnect: true };
  }
  if (body.siteId !== undefined) {
    data.site = body.siteId ? { connect: { id: body.siteId } } : { disconnect: true };
  }
  // Re-linking a costing to a lead is a correction, not a handoff: the lead's
  // stage only moves when a costing is STARTED from it (POST).
  if (body.leadId !== undefined) {
    data.lead = body.leadId ? { connect: { id: body.leadId } } : { disconnect: true };
  }
  return data;
}

/** The sheet editor's save: header, lines and scope, all or nothing. */
costingRoutes.put(
  '/:id/sheet',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const before = await forEdit(req, req.params.id);
    const body = parseBody(sheetSchema, req.body);
    const vatRate = await checkVatRate(body.vatRate, num(before.vatRate));

    const costing = await prisma.$transaction(async (tx) => {
      await checkReferences(body, tx);
      // PUT carries the whole header; a lead link is only ever corrected, never handed off here.
      const { leadId: _lead, ...header } = body;
      await tx.costing.update({ where: { id: before.id }, data: headerData(header, vatRate) });
      await writeSheet(tx, before.id, body);
      return (await loadFull(before.id, tx))!;
    });

    await audit(
      {
        entityType: 'costing',
        entityId: before.id,
        action: 'UPDATED',
        summary: `Updated costing ${before.number} — ${costing.lines.filter((l) => !l.isHeading).length} line(s), cost ${formatMoney(num(costing.totalCost))}, contract ${formatMoney(num(costing.contractValue))}`,
      },
      req,
    );
    res.json({ ...present(costing as unknown as Record<string, unknown>, await categoryRanks()), canEdit: true });
  }),
);

costingRoutes.patch(
  '/:id',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(headerSchema.partial().extend({ status: z.enum(['DRAFT', 'FINAL']).optional() }), req.body);

    const before = await prisma.costing.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Costing not found');
    if (!canEditRecord(me, 'gops', 'costing', before.ownerId)) {
      throw forbidden('Only the author can edit this costing');
    }
    if (before.status === 'PENDING_APPROVAL') {
      throw badRequest('This costing is with the approver. It can be changed once they decide.');
    }
    // Status is the one field that may change on a FINAL costing — that is how
    // it gets reopened.
    if (before.status === 'FINAL' && Object.keys(body).some((k) => k !== 'status')) {
      throw badRequest('This costing is final. Set it back to draft before changing it.');
    }
    // With a costing workflow active, FINAL means approved: the author does not
    // get to skip the approver by ticking it themselves.
    if (body.status === 'FINAL' && before.status !== 'FINAL' && (await approvalConfigured(num(before.contractValue)))) {
      throw badRequest('Costings are approved here — submit it for approval instead of marking it final.');
    }
    const vatRate = await checkVatRate(body.vatRate, num(before.vatRate));

    const data = headerData(body, vatRate);
    if (body.status !== undefined) data.status = body.status;
    // When it became final, for "Final this month"; reopening clears it.
    if (body.status === 'FINAL' && before.status !== 'FINAL') data.finalAt = new Date();
    if (body.status === 'DRAFT') data.finalAt = null;
    await prisma.$transaction(async (tx) => {
      await tx.costing.update({ where: { id: req.params.id }, data });
      await recalc(req.params.id, tx, { strict: body.targetContractValue !== undefined || body.marginPct !== undefined });
      // A cost-priced phase follows the price.
      await spreadSections(tx, req.params.id, { spread: false });
    });

    const costing = await loadFull(req.params.id);
    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: body.status === 'FINAL' ? 'COMPLETED' : 'UPDATED',
        summary:
          body.status === 'FINAL'
            ? `Marked costing ${before.number} final — contract value ${formatMoney(num(costing!.contractValue))}`
            : body.status === 'DRAFT' && before.status === 'FINAL'
              ? `Reopened costing ${before.number}`
              : `Updated costing ${before.number}`,
      },
      req,
    );

    res.json(present(costing as unknown as Record<string, unknown>, await categoryRanks()));
  }),
);

costingRoutes.delete(
  '/:id',
  require_('gops.costing.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await prisma.costing.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quotationRevisions: true, jobs: true } } },
    });
    if (!costing) throw notFound('Costing not found');
    if (!canEditRecord(me, 'gops', 'costing', costing.ownerId)) {
      throw forbidden('Only the author can delete this costing');
    }
    if (costing.status === 'PENDING_APPROVAL') {
      throw badRequest('This costing is with the approver and cannot be deleted while they decide.');
    }
    if (costing._count.quotationRevisions > 0) {
      throw badRequest(
        `${costing._count.quotationRevisions} quotation revision(s) are built on this costing`,
      );
    }

    await prisma.costing.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted costing ${costing.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Approval ─────────────────────────────────────────────────────────────────

/**
 * Sends a DRAFT costing to the approval engine. It is claimed with a
 * conditional update, so two presses submit once, and a submission the engine
 * refuses (no workflow, nobody to approve) puts it straight back to DRAFT —
 * never left pending with no approval behind it.
 */
costingRoutes.post(
  '/:id/submit',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await prisma.costing.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { lines: { where: { isHeading: false } } } } },
    });
    if (!costing) throw notFound('Costing not found');
    if (!canEditRecord(me, 'gops', 'costing', costing.ownerId)) {
      throw forbidden('Only the author can submit this costing');
    }
    if (costing.status !== 'DRAFT') throw badRequest('Only a draft costing is submitted for approval');
    if (!costing._count.lines) throw badRequest('Add at least one cost line before submitting for approval');

    const claimed = await prisma.costing.updateMany({
      where: { id: costing.id, status: 'DRAFT' },
      data: { status: 'PENDING_APPROVAL' },
    });
    if (!claimed.count) throw badRequest('This costing was submitted a moment ago');

    try {
      await submitForApproval({
        documentType: 'costing',
        documentId: costing.id,
        documentNumber: costing.number,
        subject: costing.title,
        amount: num(costing.contractValue),
        link: `/g-ops/costing/${costing.id}`,
        // The author, not whoever pressed the button: an admin submitting for
        // somebody must not become able to approve a costing they did not make.
        requesterId: costing.ownerId,
      });
    } catch (err) {
      await prisma.costing.update({ where: { id: costing.id }, data: { status: 'DRAFT' } });
      throw err;
    }
    // FINAL already when every step was the author's own (`preparerSigns`).
    const after = await prisma.costing.findUnique({ where: { id: costing.id }, select: { status: true } });
    res.json({ ok: true, status: after?.status ?? 'PENDING_APPROVAL' });
  }),
);

/** The approver's decision moves the costing: approved → FINAL, rejected → back to DRAFT to rework. */
export async function settleCosting(documentId: string, outcome: 'APPROVED' | 'REJECTED') {
  const claimed = await prisma.costing.updateMany({
    where: { id: documentId, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'FINAL', finalAt: new Date() } : { status: 'DRAFT', finalAt: null },
  });
  if (!claimed.count) return;
  const costing = await prisma.costing.findUnique({ where: { id: documentId }, select: { number: true, contractValue: true } });
  await audit({
    entityType: 'costing',
    entityId: documentId,
    action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED',
    summary:
      outcome === 'APPROVED'
        ? `Costing ${costing?.number} approved — final at ${formatMoney(num(costing?.contractValue))}`
        : `Costing ${costing?.number} returned to draft`,
  });
}

onApprovalSettled('costing', async (request, outcome) => {
  await settleCosting(request.documentId, outcome);
});

// ── Duplicate ────────────────────────────────────────────────────────────────

/**
 * A fresh DRAFT copy of a costing: header, cost lines, scope sections and
 * their tasks, under a new number and owned by whoever asked.
 *
 * This is how a service contract is renewed (model §4.5): the old contract's
 * costing is copied at last year's prices, repriced, and a new contract is
 * built on the copy. The prices are copied deliberately and the page says so —
 * a renewal that silently kept them would be a price freeze nobody decided on.
 *
 * What is NOT copied: the lead link (a copy answers no lead), the quotation
 * revisions and jobs built on the original (they are the original's history),
 * the status (a copy is always a draft — its numbers are about to change) and
 * the validity date (the copy's prices have not been offered to anyone yet).
 */
costingRoutes.post(
  '/:id/duplicate',
  require_('gops.costing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ title: z.string().trim().min(2).optional() }),
      req.body ?? {},
    );

    const source = await prisma.costing.findUnique({
      where: { id: req.params.id },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        scopeSections: {
          orderBy: { sortOrder: 'asc' },
          include: { tasks: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!source) throw notFound('Costing not found');
    // Copying is reading: someone who may only see their own costings may only
    // copy their own.
    if (onlyOwn(me) && source.ownerId !== me.id) {
      throw forbidden('This costing belongs to someone else');
    }

    const copyId = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('costing', tx);
      const copy = await tx.costing.create({
        data: {
          number,
          title: body.title ?? source.title,
          status: 'DRAFT',
          customerId: source.customerId,
          siteId: source.siteId,
          ownerId: me.id,
          marginPct: source.marginPct,
          targetContractValue: source.targetContractValue,
          vatRate: source.vatRate,
          systemUnit: source.systemUnit,
          durationDays: source.durationDays,
          notes: source.notes,
          terms: source.terms,
          lines: {
            create: source.lines.map((l) => ({
              costCategoryId: l.costCategoryId,
              itemId: l.itemId,
              name: l.name,
              description: l.description,
              isHeading: l.isHeading,
              quantity: l.quantity,
              unit: l.unit,
              unitCost: l.unitCost,
              amount: l.amount,
              sortOrder: l.sortOrder,
              supplierId: l.supplierId,
              supplierName: l.supplierName,
              lineNote: l.lineNote,
            })),
          },
          scopeSections: {
            create: source.scopeSections.map((s) => ({
              kind: s.kind,
              name: s.name,
              description: s.description,
              durationDays: s.durationDays,
              value: s.value,
              valueSource: s.valueSource,
              costCategoryIds: s.costCategoryIds,
              sortOrder: s.sortOrder,
              tasks: {
                create: s.tasks.map((t) => ({
                  name: t.name,
                  startDay: t.startDay,
                  durationDays: t.durationDays,
                  sortOrder: t.sortOrder,
                })),
              },
            })),
          },
        },
      });
      // Totals are recomputed from the copied lines rather than copied, so the
      // copy can never carry a figure its own lines do not add up to.
      await recalc(copy.id, tx);
      return copy.id;
    });

    const copy = await loadFull(copyId);
    await audit(
      {
        entityType: 'costing',
        entityId: copyId,
        action: 'CREATED',
        summary: `Duplicated costing ${source.number} as ${copy!.number} — ${copy!.title}`,
      },
      req,
    );
    res.status(201).json({
      ...present(copy as unknown as Record<string, unknown>, await categoryRanks()),
      canEdit: true,
      duplicatedFrom: { id: source.id, number: source.number },
    });
  }),
);

// ── The schedule of values ───────────────────────────────────────────────────
//
// Lines, phases and tasks are written by the sheet's one save (PUT /:id/sheet);
// the one-at-a-time routes went on 2026-10-10 — nothing called them but the
// verify scripts, which now save the sheet as the editor does.

/**
 * Spreads the contract value across the scope sections in proportion to what
 * is already there, or evenly when nothing has been set.
 *
 * The Schedule of Values has to add up to the contract value or progress
 * billing cannot be right, and asking someone to reconcile it by hand after
 * every markup change is how it silently stops adding up.
 */
costingRoutes.post(
  '/:id/sections/distribute',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const costing = await forEdit(req, req.params.id);
    const count = await prisma.$transaction((tx) => spreadSections(tx, req.params.id, { spread: true, strict: true }));
    if (!count) throw badRequest('Add at least one scope section first');

    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Distributed ${formatMoney(num(costing.contractValue))} across ${count} scope section(s)`,
      },
      req,
    );

    const full = await loadFull(req.params.id);
    res.json(present(full as unknown as Record<string, unknown>, await categoryRanks()));
  }),
);

// ── PDF: the Project Costing and the Scope of Work ────────────────────

/**
 * The costing's route, one slot a step: a DRAFT — returned, or reopened
 * after its approval, too — prints the route submitting it now would take
 * (`approvalSlots` with the submit's own amount and author); a pending one
 * its open request, each step signed and dated or still open; a FINAL one
 * the request that approved it — and none when no approval stands behind it
 * (`approvalStands`: returned and then made final by a project built on the
 * draft, or reopened and made final again with the route switched off),
 * because nobody will ever sign that route.
 */
async function costingRouteSlots(costing: { id: string; status: string; ownerId: string; contractValue: Prisma.Decimal }): Promise<ApprovalSlot[]> {
  if (costing.status === 'DRAFT') return approvalSlots('costing', costing.id, { amount: num(costing.contractValue), requesterId: costing.ownerId });
  if (costing.status === 'FINAL' && !(await approvalStands('costing', costing.id, 'Reopened costing'))) return [];
  return approvalSlots('costing', costing.id);
}

const pct = (v: number, places = 2) => `${(v * 100).toFixed(places).replace(/\.?0+$/, '')}%`;
const qty = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));

/**
 * The Project Costing on paper, worked out for the designed layout
 * (2026-10-13, Admin › PDF Templates › Costing): its fields, the cost table —
 * each bucket a numbered heading, its lines (code, name over description,
 * unit, quantity, unit cost, amount; a subheading as a heading) and its
 * subtotal — the summary (cost, the margin as a share of the price, the
 * subtotal, VAT, the total; only the last bold), and the sign-offs: Prepared
 * by, then the route as the workflow names its steps, who signed and when,
 * else who is assigned with "Pending" (a DRAFT prints the route submitting it
 * now would take; a costing final with no approval behind it prints none).
 * Internal notes never print. Also the Scope of Work chart, the appendix the
 * route joins behind the designed pages.
 */
export async function costingPaper(me: ReturnType<typeof currentUser>, id: string, deciderOnly = false) {
  const costing = await loadFull(id);
  if (!costing) throw notFound('Costing not found');
  await assertCostingVisible(me, costing, deciderOnly);

  const [ranks, currency] = await Promise.all([categoryRanks(), companyCurrency()]);
  const view = present(costing as unknown as Record<string, unknown>, ranks);
  const lines = view.lines as unknown as {
    code: string | null;
    name: string | null;
    description: string;
    isHeading: boolean;
    unit: string;
    quantity: number;
    unitCost: number;
    amount: number;
    costCategory: { id: string; name: string };
    supplier: { name: string } | null;
    supplierName: string | null;
    lineNote: string | null;
  }[];
  const day = (key: unknown) => (key ? formatDate(new Date(`${key as string}T00:00:00Z`)) : '');

  const rows: DesignData['rows'] = [];
  const buckets = new Map<string, { name: string; rank: number; lines: typeof lines }>();
  for (const l of lines) {
    const b = buckets.get(l.costCategory.id) ?? { name: l.costCategory.name, rank: ranks.get(l.costCategory.id) ?? 0, lines: [] };
    b.lines.push(l);
    buckets.set(l.costCategory.id, b);
  }
  for (const b of [...buckets.values()].sort((a, c) => a.rank - c.rank)) {
    rows.push({ heading: b.name });
    let subtotal = 0;
    for (const l of b.lines) {
      if (l.isHeading) {
        rows.push({ heading: l.name || l.description });
        continue;
      }
      rows.push(
        costingLineRow({
          code: l.code,
          name: l.name || l.description,
          description: l.name ? l.description : null,
          unit: l.unit,
          quantity: l.quantity,
          unitCost: formatAmount(l.unitCost),
          amount: formatAmount(l.amount),
          supplier: l.supplier?.name ?? l.supplierName,
          note: l.lineNote,
        }),
      );
      subtotal += Math.round(l.amount * 100);
    }
    rows.push(costingSubtotalRow(b.name, formatAmount(subtotal / 100)));
  }

  const totals = [
    { label: 'Project budgeted cost', value: formatMoney(view.totalCost, currency) },
    {
      label: `Margin (${pct(view.grossMarginPct)} of the price${view.targetContractValue ? ', fixed price' : ''})`,
      value: formatMoney(view.marginAmount, currency),
    },
    { label: 'Subtotal', value: formatMoney(view.contractValue, currency) },
    ...(view.vatRate > 0 ? [{ label: `VAT (${ratePct(view.vatRate)})`, value: formatMoney(view.vatAmount, currency) }] : []),
    { label: 'Total', value: formatMoney(view.grandTotal, currency), bold: true },
  ];

  const [author, slots] = await Promise.all([contactOf(costing.ownerId), costingRouteSlots(costing)]);
  const signatories: Signatory[] = [
    { role: 'Prepared by', name: costing.owner.name, ...author, at: preparedAt(slots) ?? costing.createdAt },
    ...(slots.length ? slotSignatories(slots) : costing.status === 'DRAFT' ? [{ role: 'Approved by' }] : []),
  ];

  const location = costing.site ? [costing.site.name, costing.site.address, costing.site.city].filter(Boolean).join(', ') : '';
  const fields: Record<string, string> = {
    'costing.number': costing.number,
    'costing.title': costing.title,
    'costing.date': formatShortDate(costing.createdAt),
    'costing.dateLong': formatDate(costing.createdAt),
    'costing.status': statusLabel(costing.status),
    'costing.systemUnit': costing.systemUnit ?? '',
    'costing.location': location,
    'costing.validUntil': costing.validUntil ? formatDate(costing.validUntil) : '',
    'costing.plannedStart': day(view.plannedStart),
    'costing.plannedFinish': day(view.plannedFinish),
    'costing.planDays': view.planDays > 0 ? `${view.planDays} working day${view.planDays === 1 ? '' : 's'} (Mon–Sat)` : '',
    'costing.terms': costing.terms ?? '',
    'costing.currency': currency,
    'costing.totalCost': formatAmount(view.totalCost),
    'costing.marginPct': pct(view.grossMarginPct),
    'costing.marginAmount': formatAmount(view.marginAmount),
    'costing.contractValue': formatAmount(view.contractValue),
    'costing.vatRate': ratePct(view.vatRate),
    'costing.vatAmount': formatAmount(view.vatAmount),
    'costing.grandTotal': formatAmount(view.grandTotal),
    'customer.name': costing.customer?.name ?? '',
    'owner.name': costing.owner.name,
    'owner.position': (costing.owner as { position?: string | null }).position ?? '',
    'owner.email': author.email ?? '',
    'owner.phone': author.phone ?? '',
  };

  // The Scope of Work: always the Gantt chart, on landscape pages of its own
  // behind the estimate (2026-10-09) — a phase without tasks is a bar over its
  // own planned days, dated from the start when the costing has one.
  const scope = view.scopeSections as unknown as {
    name: string;
    startDay: number | null;
    planDays: number;
    tasks: { name: string; start: number; durationDays: number }[];
  }[];
  const groups: PdfGanttGroup[] = scope.map((sec) => ({
    name: sec.name,
    start: sec.startDay ?? undefined,
    days: sec.planDays,
    tasks: sec.tasks.map((t) => ({ name: t.name, start: t.start, days: t.durationDays })),
  }));
  const appendix: PdfSection | null = groups.length
    ? {
        kind: 'gantt',
        title: 'Scope of work',
        landscape: true,
        groups,
        legend: planLegend(view.planDays, view.plannedStart as string | null, view.plannedFinish as string | null),
        startDate: (view.plannedStart as string | null) ?? undefined,
      }
    : null;

  const data: DesignData = { title: `Project Costing ${costing.number}`, fields, rows, totals, signatories };
  return { costing, data, appendix };
}

/** The Scope of Work chart on landscape pages of its own, to join behind the designed estimate. */
export async function costingAppendix(costing: { number: string; title: string; createdAt: Date; customer: { name: string } | null }, appendix: PdfSection) {
  return renderDocument({
    title: 'Project Costing',
    documentNumber: costing.number,
    date: costing.createdAt,
    reference: `${costing.title}${costing.customer ? ` — ${costing.customer.name}` : ''}`,
    sections: [appendix],
    appendixOnly: true,
  });
}

costingRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { costing, data, appendix } = await costingPaper(me, req.params.id, res.locals.deciderOnly === true);
    const { design } = await costingDesign();
    const estimate = await renderDesigned(design, data);
    const pdf = appendix ? await appendPdf(estimate, await costingAppendix(costing, appendix)) : estimate;

    await audit({ entityType: 'costing', entityId: costing.id, action: 'EXPORTED', summary: `Printed the Project Costing ${costing.number}` }, req);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Project Costing', number: costing.number, author: costing.owner.name, date: costing.createdAt })));
    res.send(pdf);
  }),
);

