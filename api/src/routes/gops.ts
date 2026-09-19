import { Router } from 'express';

import { prisma } from '../prisma';
import { handler } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';

/**
 * G-OPS — the module overview.
 *
 * One read, not twenty. The dashboard used to count each tile with its own
 * `?pageSize=1` request off a list screen, which is fine for four tiles and
 * silly for twenty: twenty round trips, twenty query plans, and a page that
 * fills in raggedly. This groups each entity once and returns the lot.
 *
 * READ ONLY, and it adds no table. Every figure is a count of documents the
 * other phases already record — the same rule Insights runs under, for the
 * same reason: a screen that keeps its own copy of a number acquires the
 * ability to disagree with the records behind it.
 *
 * It is COUNTS, not money. Value lives in Insights, which reconciles it
 * against those documents (model §11). Two places adding up the pipeline is
 * two pipeline figures.
 *
 * **Every block is gated on its own permission**, not on the dashboard's.
 * Holding `gops.dashboard.view_all` is permission to see the overview, not
 * permission to learn how many quotations are out — a count is a small leak
 * wearing a number, and the client cannot be the one to decide that.
 */

export const gopsRoutes = Router();
gopsRoutes.use(authenticate);

/** `{ DRAFT: 3, FINAL: 1 }` from a Prisma groupBy, zero-filled by the caller. */
type Tally = Record<string, number>;

function tally(rows: { status?: string | null; _count: { _all: number } }[]): Tally {
  const out: Tally = {};
  for (const r of rows) if (r.status) out[r.status] = r._count._all;
  return out;
}

/** Reading a screen means holding either view scope over it. */
function canSee(
  user: ReturnType<typeof currentUser>,
  submodule: string,
): boolean {
  return (
    user.isSuperAdmin ||
    user.permissions.has(`gops.${submodule}.view_all`) ||
    user.permissions.has(`gops.${submodule}.view_own`)
  );
}

gopsRoutes.get(
  '/overview',
  require_('gops.dashboard.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);

    const sees = {
      leads: canSee(me, 'leads'),
      quotations: canSee(me, 'quotations'),
      costing: canSee(me, 'costing'),
      projects: canSee(me, 'projects'),
      progress: canSee(me, 'progress_billing'),
      contracts: canSee(me, 'service_contracts'),
      visits: canSee(me, 'visits'),
      reports: canSee(me, 'pm_reports'),
    };

    // Someone who can only see their own records must not be counting the
    // whole company's. Where a screen is owner-scoped, so is its tile.
    const mineOnly = (submodule: string) =>
      !me.isSuperAdmin && !me.permissions.has(`gops.${submodule}.view_all`);

    const soon = new Date();
    soon.setDate(soon.getDate() + 60);
    const now = new Date();

    const [leads, quotations, costings, jobs, reportsPending, contracts, expiring, visitsDue, serviceReports] =
      await Promise.all([
        sees.leads
          ? prisma.lead.groupBy({
              by: ['status'],
              _count: { _all: true },
              where: mineOnly('leads') ? { assignedToId: me.id } : {},
            })
          : null,
        sees.quotations
          ? prisma.quotation.groupBy({
              by: ['outcome'],
              _count: { _all: true },
              where: mineOnly('quotations') ? { ownerId: me.id } : {},
            })
          : null,
        sees.costing
          ? prisma.costing.groupBy({
              by: ['status'],
              _count: { _all: true },
              where: mineOnly('costing') ? { ownerId: me.id } : {},
            })
          : null,
        sees.projects
          ? prisma.job.groupBy({
              by: ['status'],
              _count: { _all: true },
              where: { type: 'PROJECT' },
            })
          : null,
        sees.progress
          ? prisma.progressReport.count({ where: { status: 'SUBMITTED' } })
          : null,
        sees.contracts
          ? prisma.serviceContract.groupBy({ by: ['status'], _count: { _all: true } })
          : null,
        // "Up for renewal" is a date question, not a status one: still running,
        // but ending inside the window the renewals screen works to.
        sees.contracts
          ? prisma.serviceContract.count({
              where: { status: 'ACTIVE', endsAt: { lte: soon } },
            })
          : null,
        sees.visits
          ? prisma.serviceVisit.count({
              where: { status: 'SCHEDULED', dueDate: { lte: now } },
            })
          : null,
        sees.reports
          ? prisma.serviceReport.count({ where: { status: 'PENDING_APPROVAL' } })
          : null,
      ]);

    res.json({
      // The client renders a section only when its block is present, so a
      // permission it does not hold is an absent key rather than a zero.
      sales: sees.leads || sees.quotations || sees.costing
        ? {
            leads: leads ? tally(leads) : null,
            quotations: quotations
              ? tally(quotations.map((q) => ({ status: q.outcome, _count: q._count })))
              : null,
            costings: costings ? tally(costings) : null,
          }
        : null,
      delivery: sees.projects || sees.progress
        ? {
            jobs: jobs ? tally(jobs) : null,
            reportsAwaitingApproval: reportsPending,
          }
        : null,
      aftermarket: sees.contracts || sees.visits || sees.reports
        ? {
            contracts: contracts ? tally(contracts) : null,
            upForRenewal: expiring,
            visitsDue,
            reportsAwaitingApproval: serviceReports,
          }
        : null,
    });
  }),
);
