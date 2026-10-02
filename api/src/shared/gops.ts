import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { manilaDayEnd, manilaDayStart } from './day';

/**
 * The G-OPS overview, decided once.
 *
 * `GET /gops/overview` (the G-OPS dashboard) and the Insights brief both print
 * these counts. The brief used to be where a second copy of the where-clauses
 * would have gone, and a hand-copied where-clause is exactly how two screens
 * come to disagree — so the handler body moved here, unchanged, and both call
 * it. Change a figure HERE, never in one of its readers.
 *
 * READ ONLY, and it adds no table. Every figure is a count of documents the
 * other phases already record. It is COUNTS, not money: value lives in
 * Insights, which reconciles it against those documents (model §11).
 *
 * **Every block is gated on its own permission**, not on the dashboard's.
 * Holding `gops.dashboard.view_all` is permission to see the overview, not
 * permission to learn how many quotations are out — a count is a small leak
 * wearing a number, and the client cannot be the one to decide that.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The from/to range, as a Prisma filter on one date column.
 *
 * Two kinds of figure live on this dashboard and only one of them takes a
 * range. Period ACTIVITY — quotations raised, PM visits accomplished — is a
 * question about a window, and dated by the column that records when the
 * thing happened: `createdAt` for a document that was raised, `performedAt`
 * for work that was carried out. A LIVE QUEUE — projects in progress,
 * contracts running — is a question about right now, and filtering it by
 * date wouldn't narrow the dashboard, it would hide what is open. Those
 * stay unfiltered whatever range is showing.
 *
 * The days are Manila's. A document raised is an instant, so its range runs
 * from Manila midnight of `from` to the last instant of `to` in Manila. `from`
 * used to be UTC midnight — 08:00 here — and a range left out whatever was
 * raised before 08:00 on its first day: "this month" on the 1st, "this year"
 * on 1 January. Work performed is a DATE, which Prisma binds as its UTC date,
 * so there UTC midnight IS the day, and Manila midnight would read as the day
 * before. The end of a Manila day is still that day to a DATE, so `to` serves
 * both. verify-aftermarket pins the PM count through `/gops/overview`.
 */
export function periodWhere(
  req: { query: { from?: unknown; to?: unknown } },
  column: 'createdAt' | 'performedAt' = 'createdAt',
) {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  if (!from && !to) return {};
  const start = (key: string) =>
    column === 'createdAt' && DAY_KEY.test(key) ? manilaDayStart(key) : new Date(key);
  return {
    [column]: {
      ...(from ? { gte: start(from) } : {}),
      // A bare date is midnight, which would cut off "to" before its own day
      // has started — push it to the end of that day instead.
      ...(to ? { lte: DAY_KEY.test(to) ? manilaDayEnd(to) : new Date(to) } : {}),
    },
  };
}

/** `{ DRAFT: 3, FINAL: 1 }` from a Prisma groupBy, zero-filled by the caller. */
export type Tally = Record<string, number>;

function tally(rows: { status?: string | null; _count: { _all: number } }[]): Tally {
  const out: Tally = {};
  for (const r of rows) if (r.status) out[r.status] = r._count._all;
  return out;
}

/** Reading a screen means holding either view scope over it. */
function canSee(user: ResolvedUser, submodule: string): boolean {
  return (
    user.isSuperAdmin ||
    user.permissions.has(`gops.${submodule}.view_all`) ||
    user.permissions.has(`gops.${submodule}.view_own`)
  );
}

export interface GopsOverview {
  sales: { leads: Tally | null; quotations: Tally | null; costings: Tally | null } | null;
  delivery: { jobs: Tally | null; reportsAwaitingApproval: number | null } | null;
  aftermarket: {
    contracts: Tally | null;
    activeContracts: number | null;
    pmAccomplished: number | null;
  } | null;
  /**
   * Whether an owner-scoped block counted the caller's own records only.
   * NOT part of the `/gops/overview` response — the route strips it, so that
   * response stays byte-identical. The Insights brief reads it to say "yours"
   * on a line that would otherwise pass one person's count off as the
   * company's.
   */
  _scope: { leads: 'all' | 'mine'; quotations: 'all' | 'mine'; costings: 'all' | 'mine' };
}

/**
 * The G-OPS dashboard's figures. `query` is the request's own query object —
 * pass the same `from`/`to` strings the G-OPS page sends, so the same
 * `periodWhere` decides the window.
 */
export async function gopsOverview(
  me: ResolvedUser,
  query: { from?: unknown; to?: unknown },
): Promise<GopsOverview> {
  const req = { query };
  const period = periodWhere(req);
  const performed = periodWhere(req, 'performedAt');

  const sees = {
    leads: canSee(me, 'leads'),
    quotations: canSee(me, 'quotations'),
    costing: canSee(me, 'costing'),
    projects: canSee(me, 'projects'),
    progress: canSee(me, 'progress_billing'),
    contracts: canSee(me, 'service_contracts'),
    visits: canSee(me, 'visits'),
  };

  // Someone who can only see their own records must not be counting the
  // whole company's. Where a screen is owner-scoped, so is its tile.
  const mineOnly = (submodule: string) =>
    !me.isSuperAdmin && !me.permissions.has(`gops.${submodule}.view_all`);

  const [leads, quotations, costings, jobs, reportsPending, contracts, activeContracts, pmAccomplished] =
    await Promise.all([
      sees.leads
        ? prisma.lead.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('leads') ? { assignedToId: me.id } : {}) },
          })
        : null,
      sees.quotations
        ? prisma.quotation.groupBy({
            by: ['outcome'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('quotations') ? { ownerId: me.id } : {}) },
          })
        : null,
      sees.costing
        ? prisma.costing.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { ...period, ...(mineOnly('costing') ? { ownerId: me.id } : {}) },
          })
        : null,
      sees.projects
        ? prisma.job.groupBy({
            by: ['status'],
            _count: { _all: true },
            where: { type: 'PROJECT' },
          })
        : null,
      sees.progress ? prisma.progressReport.count({ where: { status: 'SUBMITTED' } }) : null,
      sees.contracts ? prisma.serviceContract.groupBy({ by: ['status'], _count: { _all: true } }) : null,
      // Cover the business is carrying right now — a live figure, so no range.
      sees.contracts ? prisma.serviceContract.count({ where: { status: 'ACTIVE' } }) : null,
      // PM actually carried out, dated by the day the engineer did the work
      // rather than the day the visit row was created — a visit scheduled in
      // January and performed in March belongs to March.
      sees.visits
        ? prisma.serviceVisit.count({
            where: { kind: 'PREVENTIVE_MAINTENANCE', status: 'COMPLETED', ...performed },
          })
        : null,
    ]);

  return {
    // The client renders a section only when its block is present, so a
    // permission it does not hold is an absent key rather than a zero.
    sales:
      sees.leads || sees.quotations || sees.costing
        ? {
            leads: leads ? tally(leads) : null,
            quotations: quotations
              ? tally(quotations.map((q) => ({ status: q.outcome, _count: q._count })))
              : null,
            costings: costings ? tally(costings) : null,
          }
        : null,
    delivery:
      sees.projects || sees.progress
        ? {
            jobs: jobs ? tally(jobs) : null,
            reportsAwaitingApproval: reportsPending,
          }
        : null,
    aftermarket:
      sees.contracts || sees.visits
        ? {
            contracts: contracts ? tally(contracts) : null,
            activeContracts,
            pmAccomplished,
          }
        : null,
    _scope: {
      leads: mineOnly('leads') ? 'mine' : 'all',
      quotations: mineOnly('quotations') ? 'mine' : 'all',
      costings: mineOnly('costing') ? 'mine' : 'all',
    },
  };
}
