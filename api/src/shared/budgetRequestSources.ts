import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, forbidden, notFound } from '../http/kit';
import { audit } from './audit';
import { cents, num, refreshBudgetRequest } from './finance';
import { postJobCost } from './inventory';
import { inBase, RATE_SELECT } from './exchangeRates';
import { revisionCostingIds } from './costingSets';
import { valueRevision } from './pipeline';
import { salesOrderSpend } from './orderStock';
import { visibleOwners } from './team';
import type { ResolvedUser } from '../permissions/resolve';

/**
 * WHAT A BUDGET REQUEST IS FOR (2026-10-26, the owner's call: "valid not only
 * for project but also on Sales Order, Quotation and Costing").
 *
 * A request names exactly one of four records when it is raised. A PROJECT's
 * request is what it always was — checked against Budget Monitoring, its
 * released cash COMMITTED on the project's ledger and its liquidation INCURRED
 * there. The other three post to no ledger: each is checked against the
 * record's own cost —
 *
 *  - a COSTING (final only): its cost per budget line;
 *  - a QUOTATION (open or won): the cost per budget line of the costings
 *    behind its value revision, else its lines' whole cost;
 *  - a SALES ORDER (issued): its quoted cost less what its purchasing has
 *    committed and received (`salesOrderSpend()`, which counts the order's
 *    budget request cash too);
 *
 * less the other requests on the same money: released cash still out is
 * committed, a liquidated request's spend is incurred — the project's rule,
 * read off the requests instead of a ledger. Going over is said, never
 * refused. When a project is built from the costing or the quotation (or the
 * sales order's quotation), `adoptBudgetRequests()` hands its requests to the
 * project: they take its `jobId`, their released cash is committed and their
 * approved liquidations incurred on its ledger, so Budget Monitoring sees them.
 * The record it was raised for stays on the request as its history.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export type SourceKind = 'project' | 'sales_order' | 'quotation' | 'costing';

export const SOURCE_KINDS: SourceKind[] = ['project', 'sales_order', 'quotation', 'costing'];

export const SOURCE_WORDS: Record<SourceKind, string> = {
  project: 'Project',
  sales_order: 'Sales order',
  quotation: 'Quotation',
  costing: 'Costing',
};

/** What a request's reads include to say what it is for. */
export const SOURCE_INCLUDE = {
  job: { select: { id: true, number: true, name: true, projectManager: { select: { id: true, name: true } } } },
  salesOrder: { select: { id: true, number: true, ownerId: true, quotation: { select: { subject: true } } } },
  quotation: { select: { id: true, number: true, subject: true, ownerId: true } },
  costing: { select: { id: true, number: true, title: true, ownerId: true } },
} satisfies Prisma.BudgetRequestInclude;

type SourceRow = {
  job?: { id: string; number: string; name: string } | null;
  salesOrder?: { id: string; number: string; quotation: { subject: string } } | null;
  quotation?: { id: string; number: string; subject: string } | null;
  costing?: { id: string; number: string; title: string } | null;
};

export interface RequestSource {
  kind: SourceKind;
  id: string;
  number: string;
  name: string;
  /** "GT-PRJ-2026-0001 — Name", "Sales order GT-SO-… — Subject". */
  label: string;
  link: string;
}

/**
 * What a request is for, as it stands: the project once it has one (raised on
 * it, or handed to it), else the record it was raised on.
 */
export function sourceOf(r: SourceRow): RequestSource | null {
  if (r.job) return { kind: 'project', id: r.job.id, number: r.job.number, name: r.job.name, label: `${r.job.number} — ${r.job.name}`, link: `/g-ops/projects/${r.job.id}` };
  if (r.salesOrder) {
    const name = r.salesOrder.quotation.subject;
    return { kind: 'sales_order', id: r.salesOrder.id, number: r.salesOrder.number, name, label: `Sales order ${r.salesOrder.number} — ${name}`, link: `/g-ops/sales-orders/${r.salesOrder.id}` };
  }
  if (r.quotation) {
    return { kind: 'quotation', id: r.quotation.id, number: r.quotation.number, name: r.quotation.subject, label: `Quotation ${r.quotation.number} — ${r.quotation.subject}`, link: `/g-ops/quotations/${r.quotation.id}` };
  }
  if (r.costing) {
    return { kind: 'costing', id: r.costing.id, number: r.costing.number, name: r.costing.title, label: `Costing ${r.costing.number} — ${r.costing.title}`, link: `/g-ops/costing/${r.costing.id}` };
  }
  return null;
}

/** The record it was RAISED on, when that is not (or no longer only) the project. */
export function raisedOn(r: SourceRow): RequestSource | null {
  return sourceOf({ ...r, job: null });
}

/** The where-clause of "every request for this record" — the list's `?salesOrderId=` and kin. */
export function sourceFilter(f: Record<string, string>): Prisma.BudgetRequestWhereInput[] {
  const and: Prisma.BudgetRequestWhereInput[] = [];
  if (f.jobId) and.push({ jobId: f.jobId });
  if (f.salesOrderId) and.push({ salesOrderId: f.salesOrderId });
  if (f.quotationId) and.push({ quotationId: f.quotationId });
  if (f.costingId) and.push({ costingId: f.costingId });
  if (f.for) {
    const kind = f.for as SourceKind;
    if (!SOURCE_KINDS.includes(kind)) throw badRequest(`For must be one of ${SOURCE_KINDS.join(', ')}`);
    if (kind === 'project') and.push({ jobId: { not: null } });
    else and.push({ jobId: null, [kind === 'sales_order' ? 'salesOrderId' : kind === 'quotation' ? 'quotationId' : 'costingId']: { not: null } });
  }
  return and;
}

/** The search's words for a request's source. */
export function sourceSearch(term: string): Prisma.BudgetRequestWhereInput[] {
  const like = { contains: term, mode: 'insensitive' as const };
  return [
    { job: { name: like } },
    { job: { number: like } },
    { salesOrder: { number: like } },
    { quotation: { number: like } },
    { quotation: { subject: like } },
    { costing: { number: like } },
    { costing: { title: like } },
  ];
}

export interface SourceInput {
  jobId?: string | null;
  salesOrderId?: string | null;
  quotationId?: string | null;
  costingId?: string | null;
}

const OPEN_OR_WON = ['OPEN', 'SUBMITTED', 'NEGOTIATION', 'WON'] as const;

/**
 * May `me` raise a request on a record that is not a project? The owner's
 * call: whoever prepared it, their Team Leader ("Reports to"), or anyone who
 * may read it — through its module's View All, or its owner in their Own /
 * Team scope.
 */
async function mayRaiseOn(me: ResolvedUser, module: 'sales_orders' | 'quotations' | 'costing', ownerId: string) {
  if (me.isSuperAdmin || ownerId === me.id) return true;
  if (me.permissions.has(`gops.${module}.view_all`)) return true;
  if (visibleOwners(me, 'gops', module).includes(ownerId)) return true;
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { supervisorId: true } });
  return owner?.supervisorId === me.id;
}

/**
 * The record a new request is for: exactly one, still standing — a running
 * project, an ISSUED sales order, an OPEN or WON quotation, a FINAL costing —
 * and one the caller may raise it on. Returns the columns to write and the
 * number to name it by.
 */
export async function checkSource(me: ResolvedUser, body: SourceInput) {
  const given = (['jobId', 'salesOrderId', 'quotationId', 'costingId'] as const).filter((k) => body[k]);
  if (given.length === 0) throw badRequest('What is the cash for? Name a project, a sales order, a quotation or a costing');
  if (given.length > 1) throw badRequest('A budget request is for one thing — a project, a sales order, a quotation or a costing, not several');
  const columns = { jobId: null as string | null, salesOrderId: null as string | null, quotationId: null as string | null, costingId: null as string | null };
  if (body.jobId) {
    const job = await prisma.job.findUnique({ where: { id: body.jobId }, select: { id: true, number: true, status: true } });
    if (!job) throw notFound('Project not found');
    if (job.status === 'CANCELLED') throw badRequest(`${job.number} is cancelled — nothing can be requested against it`);
    return { columns: { ...columns, jobId: job.id }, number: job.number, kind: 'project' as const };
  }
  if (body.salesOrderId) {
    const so = await prisma.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { id: true, number: true, status: true, ownerId: true } });
    if (!so) throw notFound('Sales order not found');
    if (so.status !== 'ISSUED') throw badRequest(`${so.number} is not issued — a budget request takes an issued sales order`);
    if (!(await mayRaiseOn(me, 'sales_orders', so.ownerId))) throw forbidden(`You cannot raise a budget request on ${so.number}`);
    return { columns: { ...columns, salesOrderId: so.id }, number: so.number, kind: 'sales_order' as const };
  }
  if (body.quotationId) {
    const q = await prisma.quotation.findUnique({ where: { id: body.quotationId }, select: { id: true, number: true, outcome: true, ownerId: true } });
    if (!q) throw notFound('Quotation not found');
    if (!(OPEN_OR_WON as readonly string[]).includes(q.outcome)) throw badRequest(`${q.number} is not open or won — a budget request takes an open or won quotation`);
    if (!(await mayRaiseOn(me, 'quotations', q.ownerId))) throw forbidden(`You cannot raise a budget request on ${q.number}`);
    return { columns: { ...columns, quotationId: q.id }, number: q.number, kind: 'quotation' as const };
  }
  const c = await prisma.costing.findUnique({ where: { id: body.costingId! }, select: { id: true, number: true, status: true, ownerId: true } });
  if (!c) throw notFound('Costing not found');
  if (c.status !== 'FINAL') throw badRequest(`${c.number} is not final — a budget request takes a final (approved) costing`);
  if (!(await mayRaiseOn(me, 'costing', c.ownerId))) throw forbidden(`You cannot raise a budget request on ${c.number}`);
  return { columns: { ...columns, costingId: c.id }, number: c.number, kind: 'costing' as const };
}

export interface PoolLine {
  id: string;
  code: string;
  name: string;
  budgeted: number;
  committed: number;
  incurred: number;
  consumed: number;
  available: number;
}

/** A request's weight on the money it draws: released cash out is committed, a liquidated one's spend incurred. */
function weigh(r: { amountReleased: Prisma.Decimal; amountRefunded: Prisma.Decimal; amountSpent: Prisma.Decimal; liquidatedAt: Date | null; status: string }) {
  if (!['RELEASED', 'REFUND_DUE', 'LIQUIDATED'].includes(r.status)) return { committed: 0, incurred: 0 };
  return r.liquidatedAt
    ? { committed: 0, incurred: num(r.amountSpent) }
    : { committed: Math.max(0, num(r.amountReleased) - num(r.amountRefunded)), incurred: 0 };
}

const REQUEST_WEIGHT = { id: true, costCategoryId: true, amountReleased: true, amountRefunded: true, amountSpent: true, liquidatedAt: true, status: true } as const;

/** The costings the quotation's value revision was costed from (none when it has no costing). */
async function quotationCostings(quotationId: string, db: Db = prisma) {
  const revisions = await db.quotationRevision.findMany({ where: { quotationId }, select: { id: true, status: true, revision: true, costingId: true } });
  const rev = valueRevision(revisions);
  return { rev, costingIds: rev ? await revisionCostingIds(rev, db as Tx) : [] };
}

/** The quotations whose revisions were costed from any of these costings. */
async function quotationsOfCostings(costingIds: string[]) {
  if (!costingIds.length) return [];
  const [direct, linked] = await Promise.all([
    prisma.quotationRevision.findMany({ where: { costingId: { in: costingIds } }, select: { quotationId: true } }),
    prisma.quotationRevisionCosting.findMany({ where: { costingId: { in: costingIds } }, select: { revision: { select: { quotationId: true } } } }),
  ]);
  return [...new Set([...direct.map((d) => d.quotationId), ...linked.map((l) => l.revision.quotationId)])];
}

/**
 * The budget a request on a sales order, a quotation or a costing is checked
 * against, in Budget Monitoring's shape (one row per budget line, or ONE
 * "whole cost" row where the record carries no budget lines), with the
 * request's own weight left out (`excludeId`). Null for a project request —
 * that reads the project's ledger.
 */
export async function recordBudget(source: RequestSource, excludeId: string | null): Promise<{ lines: PoolLine[]; total: Omit<PoolLine, 'id' | 'code' | 'name'>; perLine: boolean } | null> {
  const others = (where: Prisma.BudgetRequestWhereInput) =>
    prisma.budgetRequest.findMany({ where: { AND: [where, { jobId: null }, excludeId ? { id: { not: excludeId } } : {}] }, select: REQUEST_WEIGHT });
  const whole = (name: string, budgeted: number, committed: number, incurred: number) => {
    const line: PoolLine = { id: 'whole', code: '', name, budgeted: cents(budgeted), committed: cents(committed), incurred: cents(incurred), consumed: 0, available: cents(budgeted - committed - incurred) };
    const { id: _i, code: _c, name: _n, ...total } = line;
    return { lines: [line], total, perLine: false };
  };

  if (source.kind === 'project') return null;
  if (source.kind === 'sales_order') {
    const spend = await salesOrderSpend(source.id, prisma, { excludeBudgetRequestId: excludeId ?? undefined });
    if (!spend) return null;
    return whole('Sales order cost', spend.quoted, spend.committed, spend.incurred);
  }

  let costingIds: string[];
  let requests: Prisma.BudgetRequestGetPayload<{ select: typeof REQUEST_WEIGHT }>[];
  if (source.kind === 'quotation') {
    const { rev, costingIds: ids } = await quotationCostings(source.id);
    costingIds = ids;
    requests = await others({ OR: [{ quotationId: source.id }, ...(ids.length ? [{ costingId: { in: ids } }] : [])] });
    if (!ids.length) {
      // No costing behind it: the value revision's lines' whole cost, in pesos.
      const [items, q] = await Promise.all([
        rev ? prisma.quotationItem.findMany({ where: { revisionId: rev.id, isHeading: false }, select: { costAmount: true } }) : [],
        prisma.quotation.findUnique({ where: { id: source.id }, select: RATE_SELECT }),
      ]);
      const cost = inBase(cents(items.reduce((s, i) => s + num(i.costAmount), 0)), q ?? {});
      const w = requests.reduce((acc, r) => { const x = weigh(r); return { committed: acc.committed + x.committed, incurred: acc.incurred + x.incurred }; }, { committed: 0, incurred: 0 });
      return whole('Quoted cost', cost, w.committed, w.incurred);
    }
  } else {
    costingIds = [source.id];
    const quotations = await quotationsOfCostings(costingIds);
    requests = await others({ OR: [{ costingId: source.id }, ...(quotations.length ? [{ quotationId: { in: quotations } }] : [])] });
  }

  const [categories, cost] = await Promise.all([
    prisma.costCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true, isActive: true } }),
    prisma.costingLine.groupBy({ by: ['costCategoryId'], where: { costingId: { in: costingIds }, isHeading: false }, _sum: { amount: true } }),
  ]);
  const budget = new Map(cost.map((c) => [c.costCategoryId, num(c._sum.amount)]));
  const weight = new Map<string, { committed: number; incurred: number }>();
  for (const r of requests) {
    const w = weigh(r);
    const was = weight.get(r.costCategoryId) ?? { committed: 0, incurred: 0 };
    weight.set(r.costCategoryId, { committed: was.committed + w.committed, incurred: was.incurred + w.incurred });
  }
  const lines: PoolLine[] = categories
    .filter((c) => c.isActive || budget.has(c.id) || weight.has(c.id))
    .map((c) => {
      const b = budget.get(c.id) ?? 0;
      const w = weight.get(c.id) ?? { committed: 0, incurred: 0 };
      return { id: c.id, code: c.code, name: c.name, budgeted: cents(b), committed: cents(w.committed), incurred: cents(w.incurred), consumed: 0, available: cents(b - w.committed - w.incurred) };
    });
  const sum = (k: 'budgeted' | 'committed' | 'incurred') => cents(lines.reduce((s, l) => s + l[k], 0));
  const total = { budgeted: sum('budgeted'), committed: sum('committed'), incurred: sum('incurred'), consumed: 0, available: cents(sum('budgeted') - sum('committed') - sum('incurred')) };
  return { lines, total, perLine: true };
}

/**
 * A project built from a costing or a quotation takes over the budget
 * requests raised on them — and on the sales orders of that quotation — in
 * the transaction that built it (the owner's call, 2026-10-26). Each takes the
 * project's `jobId`; `refreshBudgetRequest()` then commits its released cash
 * on the project's ledger, and an approved liquidation that charged no
 * project is charged there now, INCURRED at what was spent, as its own
 * approval would have. A request already on a project is left alone.
 */
export async function adoptBudgetRequests(tx: Tx, jobId: string, from: { costingIds: string[]; quotationId?: string | null; actor?: { id: string; name: string } }) {
  const or: Prisma.BudgetRequestWhereInput[] = [];
  if (from.costingIds.length) or.push({ costingId: { in: from.costingIds } });
  if (from.quotationId) {
    or.push({ quotationId: from.quotationId });
    or.push({ salesOrder: { quotationId: from.quotationId } });
  }
  if (!or.length) return [];
  const job = await tx.job.findUnique({ where: { id: jobId }, select: { number: true } });
  const requests = await tx.budgetRequest.findMany({
    where: { jobId: null, OR: or, status: { notIn: ['REJECTED', 'CANCELLED'] } },
    include: {
      liquidations: { where: { status: { in: ['APPROVED', 'SETTLED', 'REIMBURSED'] }, jobId: null }, select: { id: true, number: true, total: true, purpose: true, claimedBy: { select: { name: true } } } },
    },
  });
  for (const r of requests) {
    const claimed = await tx.budgetRequest.updateMany({ where: { id: r.id, jobId: null }, data: { jobId } });
    if (!claimed.count) continue;
    // Claims still in the making follow the request onto the project.
    await tx.expenseClaim.updateMany({ where: { budgetRequestId: r.id, jobId: null, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { jobId } });
    for (const claim of r.liquidations) {
      await tx.expenseClaim.update({ where: { id: claim.id }, data: { jobId, postedToJob: true, postedAt: new Date() } });
      await postJobCost(tx, {
        jobId,
        costCategoryId: r.costCategoryId,
        state: 'INCURRED',
        amount: num(claim.total),
        sourceType: 'expense_claim',
        sourceId: claim.id,
        sourceNumber: claim.number,
        description: `${claim.claimedBy.name} — ${claim.purpose} (liquidation of ${r.number}, before the project was built)`,
      });
    }
    await refreshBudgetRequest(tx, r.id);
    await audit(
      {
        entityType: 'budget_request',
        entityId: r.id,
        action: 'UPDATED',
        summary: `${r.number} taken over by project ${job?.number ?? ''} — its cash now counts on the project's budget`,
        ...(from.actor ? { actorId: from.actor.id, actorName: from.actor.name } : {}),
      },
      undefined,
      tx,
    );
  }
  return requests.map((r) => r.number);
}
