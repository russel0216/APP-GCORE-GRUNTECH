import { Prisma, type ApprovalRequest, type ApprovalStep } from '@prisma/client';
import { prisma } from '../prisma';
import { teamOfRequester, teamPostHolders } from './teamPosts';
import { badRequest, conflict, forbidden, notFound } from '../http/kit';
import { notify } from './notifications';
import { audit } from './audit';
import { mailConfig, sendMail } from './mail';
import { env } from '../env';
import type { Signatory } from './pdf';
import type { ResolvedUser } from '../permissions/resolve';

/**
 * The approval engine (model §6.1).
 *
 * ONE engine for Leave, Overtime, Purchase Requests, Budget Requests,
 * Quotations, Purchase Orders, Invoices and Expenses. A module submits a
 * document and subscribes to the outcome; it never implements routing,
 * notification or history itself.
 *
 * Routing is data. A workflow is picked by (documentType, amount), and each
 * step names its approver by ROLE, by USER, by SUPERVISOR (the requester's
 * direct report line) or by HR. That covers every case in the requirements,
 * including "approvers are to whom they are directly reporting … otherwise HR
 * will approve", and the overtime rule where the supervisor AND HR must both
 * approve before the cost posts.
 */

// ── Outcome subscriptions ────────────────────────────────────────────────────
// Modules register here instead of the engine importing them. In Phase 6 the
// overtime module will subscribe to 'overtime_request' and post to the job cost
// ledger when — and only when — every step including HR has approved.

export type ApprovalOutcome = 'APPROVED' | 'REJECTED';
type Listener = (req: ApprovalRequest, outcome: ApprovalOutcome) => Promise<void>;

const listeners = new Map<string, Listener[]>();

export function onApprovalSettled(documentType: string, fn: Listener): void {
  const existing = listeners.get(documentType) ?? [];
  existing.push(fn);
  listeners.set(documentType, existing);
}

async function emitSettled(req: ApprovalRequest, outcome: ApprovalOutcome): Promise<void> {
  const subscribers = listeners.get(req.documentType) ?? [];

  // A settled approval with nobody listening is a silent data inconsistency:
  // the decision is recorded, but whatever it was supposed to trigger — marking
  // a revision approved, posting overtime to a job budget — never happens.
  // Subscriptions register as a side effect of importing a module, so a change
  // to the import graph can break this without any other symptom.
  if (subscribers.length === 0) {
    console.warn(
      `Approval ${req.id} for "${req.documentType}" settled as ${outcome} with no subscriber. ` +
        `If that document type is meant to react, its module may not be imported.`,
    );
  }

  for (const fn of subscribers) {
    try {
      await fn(req, outcome);
    } catch (err) {
      // A subscriber failing must not roll back a recorded approval decision —
      // the decision is the record of fact. Surface it loudly instead.
      console.error(
        `Approval subscriber for ${req.documentType} failed on request ${req.id}:`,
        err,
      );
    }
  }
}

// ── Choosing a workflow ──────────────────────────────────────────────────────

/**
 * Picks the workflow whose amount band contains `amount`. Bands are how
 * "approval thresholds should be configurable in Settings" is expressed —
 * a PR under ₱50k takes one route, over it takes another.
 */
export async function pickWorkflow(
  documentType: string,
  amount?: number | null,
  opts: { option?: string | null; requesterId?: string | null } = {},
) {
  const candidates = await prisma.approvalWorkflow.findMany({
    where: { documentType, isActive: true },
    include: { steps: { orderBy: { sequence: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  // The preparer's roles: a route keyed to one of them is theirs. Without a
  // requester only the general routes apply.
  const roleIds = new Set(
    opts.requesterId && candidates.some((w) => w.requesterRoleId)
      ? (await prisma.userRole.findMany({ where: { userId: opts.requesterId }, select: { roleId: true } })).map((r) => r.roleId)
      : [],
  );
  const forPreparer = (w: (typeof candidates)[number]) => !w.requesterRoleId || roleIds.has(w.requesterRoleId);
  const value = amount ?? 0;
  const inBand = (w: (typeof candidates)[number]) => {
    const min = w.minAmount ? Number(w.minAmount) : null;
    const max = w.maxAmount ? Number(w.maxAmount) : null;
    if (min !== null && value < min) return false;
    if (max !== null && value > max) return false;
    return true;
  };
  // An optional route is only ever the one the submitter asked for, and only
  // where it applies; a standard pick never lands on one.
  if (opts.option) {
    return candidates.find((w) => w.id === opts.option && w.optionLabel && inBand(w) && forPreparer(w)) ?? null;
  }
  const matching = candidates.filter((w) => !w.optionLabel && inBand(w) && forPreparer(w));
  // A route keyed to the preparer's role beats the general one; among those,
  // the shortest (the senior role's: a CEO's beats a team leader's); then the
  // most specific band (the narrowest one that still matches).
  matching.sort((a, b) => {
    const keyed = (w: typeof a) => (w.requesterRoleId ? 0 : 1);
    if (keyed(a) !== keyed(b)) return keyed(a) - keyed(b);
    if (a.requesterRoleId && b.requesterRoleId && a.steps.length !== b.steps.length) return a.steps.length - b.steps.length;
    const span = (w: typeof a) =>
      (w.maxAmount ? Number(w.maxAmount) : Number.MAX_SAFE_INTEGER) -
      (w.minAmount ? Number(w.minAmount) : 0);
    return span(a) - span(b);
  });
  return matching[0] ?? null;
}

/**
 * The optional routes a submitter may choose for this document and amount —
 * e.g. "Add the CEO as approver" on a quotation over ₱1,000,000. Each is an
 * ordinary workflow with an `optionLabel`, so what it adds is data an
 * administrator edits like any other route.
 */
export async function approvalOptions(documentType: string, amount?: number | null): Promise<{ id: string; label: string }[]> {
  const value = amount ?? 0;
  const rows = await prisma.approvalWorkflow.findMany({
    where: { documentType, isActive: true, optionLabel: { not: null } },
    select: { id: true, optionLabel: true, minAmount: true, maxAmount: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows
    .filter((w) => (w.minAmount == null || value >= Number(w.minAmount)) && (w.maxAmount == null || value <= Number(w.maxAmount)))
    .map((w) => ({ id: w.id, label: w.optionLabel! }));
}

// ── Resolving who may act on a step ──────────────────────────────────────────

/**
 * What a document tells the engine about itself beyond who raised it. A
 * PROJECT_MANAGER step needs the project; everything else needs nothing. Kept
 * on the request (`ApprovalRequest.jobId`) so a step is resolved the same way
 * at submission, in the queue, on the page and on the PDF.
 */
export interface ApprovalContext {
  jobId?: string | null;
  /** The manager the document names itself (a job order's), read before the job's. */
  projectManagerId?: string | null;
  /**
   * An importation (2026-10-17, the owner's chart): a purchase order or an
   * incoming report with no VAT. A step naming a role in `IMPORTATION_ROLES`
   * goes to that role's importation twin instead.
   */
  importation?: boolean;
  /**
   * The team the document is FOR, read in place of the requester's own
   * (2026-10-21, the hiring contract: HR prepares it, and its Technical
   * Manager and Team Leader steps are the hiring team's — the manpower
   * request's team). Null or absent: the requester's team, as always.
   */
  teamId?: string | null;
}

/** The context a stored request carries. */
export const ctxOf = (r: { jobId: string | null; projectManagerId?: string | null; importation?: boolean; teamId?: string | null }): ApprovalContext => ({
  jobId: r.jobId,
  projectManagerId: r.projectManagerId ?? null,
  importation: r.importation ?? false,
  teamId: r.teamId ?? null,
});

/** The team a step is scoped to: the document's (`ctx.teamId`), else the requester's. */
const teamFor = async (requesterId: string, tx: Prisma.TransactionClient, ctx: ApprovalContext) => ctx.teamId ?? (await teamOfRequester(requesterId, tx));

/**
 * Roles with an IMPORTATION twin (2026-10-17, the owner's chart: Dina is the
 * Purchasing Manager (Local), Carter the Purchasing Manager (Importation)).
 * On an importation (`ApprovalContext.importation`) a step naming the key
 * goes to the twin's holders — never to both, so the paper and the panel
 * name one person; with nobody holding the twin, the local manager decides.
 */
export const IMPORTATION_ROLES: Record<string, string> = { purchasing_manager: 'purchasing_manager_import' };

/** The role id a ROLE step resolves to under this context — the importation twin's where one is held. */
async function stepRoleId(step: ApprovalStep, ctx: ApprovalContext, tx: Prisma.TransactionClient): Promise<string | null> {
  if (!step.roleId || !ctx.importation) return step.roleId;
  const role = await tx.role.findUnique({ where: { id: step.roleId }, select: { key: true } });
  const twinKey = role && IMPORTATION_ROLES[role.key];
  if (!twinKey) return step.roleId;
  const twin = await tx.role.findUnique({ where: { key: twinKey }, select: { id: true, users: { where: { user: { isActive: true } }, select: { userId: true }, take: 1 } } });
  return twin && twin.users.length ? twin.id : step.roleId;
}

/** The role a PROJECT_MANAGER step falls back to when it names none. */
export const PROJECT_MANAGER_FALLBACK_ROLE = 'ceo';

/**
 * The requester's "Reports to" for a SUPERVISOR step: the first ACTIVE login
 * up the reporting line (2026-10-23, the owner's report: leave and overtime
 * "not appearing to the superior" — a "Reports to" who had been deactivated
 * held every request of their reports, telling and queueing nobody). Steps
 * past an inactive manager to theirs, six levels at most, never the
 * requester themself; null when the line holds nobody active, so the step
 * takes its fallback (the role, else HR) as a request with no "Reports to"
 * does.
 */
export async function activeSupervisor(requesterId: string, tx: Prisma.TransactionClient = prisma): Promise<string | null> {
  const me = await tx.user.findUnique({ where: { id: requesterId }, select: { supervisorId: true } });
  if (!me?.supervisorId) return null;
  // A "Reports to" naming the person themself is left as it is: the step
  // then routes to the requester alone and submit refuses, naming the cause.
  if (me.supervisorId === requesterId) return requesterId;
  const seen = new Set<string>([requesterId]);
  let at: string | null = me.supervisorId;
  for (let hop = 0; hop < 6 && at && !seen.has(at); hop++) {
    seen.add(at);
    const next: { id: string; isActive: boolean; supervisorId: string | null } | null = await tx.user.findUnique({ where: { id: at }, select: { id: true, isActive: true, supervisorId: true } });
    if (!next) return null;
    if (next.isActive) return next.id;
    at = next.supervisorId;
  }
  return null;
}

/**
 * The set of user ids allowed to act on one step.
 *
 * SUPERVISOR falls back to HR when the requester has no supervisor set —
 * "Approvers are to whom they are directly reporting … otherwise HR will
 * approve". Without that fallback a new hire's first leave request would
 * silently route to nobody. A SUPERVISOR step that names a role (`roleId`)
 * falls back to that role instead: a quotation from a salesperson with no
 * "Reports to" goes to the sales managers, not to HR. HR stays the fallback
 * for every step that names none (leave, overtime, claims…).
 *
 * PROJECT_MANAGER is the manager of the project the document names (a budget
 * request's), and falls back to the step's role — the CEO / President unless the step
 * names another — when the project has no manager, the document names no
 * project, or the manager IS the requester (2026-10-07, the owner's call: a
 * PM's own request goes up to management, never to nobody). The project's
 * manager is its Technical Manager (2026-10-15); a step falling back to the
 * `technical_manager` role asks the one on the requester's team.
 */
export async function approversForStep(
  step: ApprovalStep,
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: ApprovalContext = {},
): Promise<string[]> {
  switch (step.approverType) {
    case 'PROJECT_MANAGER': {
      const named = ctx.projectManagerId
        ? await tx.user.findUnique({ where: { id: ctx.projectManagerId }, select: { id: true, isActive: true } })
        : null;
      const job =
        !named && ctx.jobId
          ? await tx.job.findUnique({ where: { id: ctx.jobId }, select: { projectManager: { select: { id: true, isActive: true } } } })
          : null;
      const manager = named ?? job?.projectManager;
      if (manager && manager.isActive && manager.id !== requesterId) return [manager.id];
      if (step.roleId) {
        const rows = await tx.userRole.findMany({
          where: { roleId: step.roleId, user: { isActive: true } },
          select: { userId: true, role: { select: { key: true } } },
        });
        const holders = rows.map((r) => r.userId);
        // The Technical Manager fallback (2026-10-15: the project's manager IS
        // its Technical Manager) is the one on the requester's own team, as a
        // ROLE step naming that role is — never a Technical Manager of another team.
        if (rows.length && OWN_TEAM_ROLES.includes(rows[0].role.key)) {
          const post = await teamPostHolders(rows[0].role.key, await teamFor(requesterId, tx, ctx), requesterId, tx);
          return post ?? leadersFor(holders, requesterId, tx, ctx.teamId);
        }
        return holders;
      }
      return usersInRole(PROJECT_MANAGER_FALLBACK_ROLE, tx);
    }

    case 'USER':
      return step.userId ? [step.userId] : [];

    case 'ROLE': {
      const roleId = await stepRoleId(step, ctx, tx);
      if (!roleId) return [];
      const rows = await tx.userRole.findMany({
        where: { roleId, user: { isActive: true } },
        select: { userId: true, role: { select: { key: true } } },
      });
      let holders = rows.map((r) => r.userId);
      // A ROLE step's other roles decide it too (2026-10-19, "Checking" by the
      // Account Payable Officer or the Credit and Collection Officer).
      if (step.alsoRoleIds?.length) {
        const also = await tx.userRole.findMany({
          where: { roleId: { in: step.alsoRoleIds }, user: { isActive: true } },
          select: { userId: true },
        });
        holders = [...new Set([...holders, ...also.map((a) => a.userId)])];
        return holders;
      }
      if (!rows.length) return holders;
      const key = rows[0].role.key;
      // A team's post set on Admin › Categories › Teams (shared or named) first.
      const post = await teamPostHolders(key, await teamFor(requesterId, tx, ctx), requesterId, tx);
      if (post) return post;
      if (TEAM_SCOPED_ROLES.includes(key)) return supportersFor(holders, requesterId, tx, ctx.teamId);
      // A Team Leader named as a ROLE step (the hiring contract's step 2,
      // 2026-10-21) is the team's leader too, as on a SUPERVISOR step.
      if (OWN_TEAM_ROLES.includes(key) || TEAM_FIRST_ROLES.includes(key)) return leadersFor(holders, requesterId, tx, ctx.teamId);
      return holders;
    }

    case 'SUPERVISOR': {
      // The requester's "Reports to" — the first ACTIVE one up the line
      // (2026-10-23: a manager deactivated or gone left every request of
      // their reports waiting on a login nobody uses).
      const supervisorId = await activeSupervisor(requesterId, tx);
      let base: string[];
      // A step naming a TEAM_FIRST role (Team Leader) goes to the holders on
      // the requester's own team before their "Reports to" (2026-10-17, the
      // owner's call: "always the Team Leader" — a welder reports to a Project
      // Lead, an engineer to the Technical Manager, and their documents still
      // go to the team's leader). Department staff with no team, and a team
      // with no leader, keep the "Reports to".
      const onTeam = step.roleId ? await teamFirstHolders(step.roleId, requesterId, tx, ctx.teamId) : [];
      if (onTeam.length) base = onTeam;
      else if (supervisorId) {
        // A role that ALSO reports to other roles (Admin › Roles › Hierarchy,
        // 2026-10-20 — the Warehouse Supervisor to both Purchasing Managers)
        // sends the step to those roles' holders beside the "Reports to".
        const mine = await tx.userRole.findMany({
          where: { userId: requesterId },
          select: { role: { select: { alsoReportsToRoleIds: true } } },
        });
        const extraRoles = [...new Set(mine.flatMap((r) => r.role.alsoReportsToRoleIds))];
        const extra = extraRoles.length
          ? await tx.userRole.findMany({
              where: { roleId: { in: extraRoles }, user: { isActive: true }, userId: { not: requesterId } },
              select: { userId: true },
            })
          : [];
        base = [...new Set([supervisorId, ...extra.map((r) => r.userId)])];
      } else if (step.roleId) {
        const rows = await tx.userRole.findMany({
          where: { roleId: step.roleId, user: { isActive: true } },
          select: { userId: true },
        });
        base = await leadersFor(rows.map((r) => r.userId), requesterId, tx, ctx.teamId);
      } else base = await usersInRole('hr', tx);
      // The step's other roles, on the requester's own team only — beside
      // the "Reports to" or the fallback, never instead of them.
      const also = await teamHoldersOf(step.alsoRoleIds ?? [], requesterId, tx, ctx.teamId);
      return also.length ? [...new Set([...base, ...also])] : base;
    }

    case 'HR':
      return usersInRole('hr', tx);

    default:
      return [];
  }
}

/**
 * Roles whose step goes to the holders who SUPPORT the requester's team
 * (2026-10-12, the owner's call: "in admin back support, even they are
 * reporting to specific manager, allow me to set where they support in back
 * admin"). Each holder's teams are `UserSupportTeam` rows, set in Admin ›
 * Users; the reporting line ("Reports to") is untouched by it.
 */
export const TEAM_SCOPED_ROLES = ['back_support'];

/**
 * Roles whose ROLE step goes to the holders on the PREPARER's own team
 * (`Employee.industryId`, the Team on Admin › Users), as a Team Leader step
 * does (`leadersFor`): a Technical Manager handles their own team's costings,
 * purchase requisitions and requests for approval (2026-10-13, the owner's
 * report: Ivan's HIT costing was waiting on every Technical Manager, where
 * Ricardo alone handles HIT). A preparer with no team, or a team with no
 * Technical Manager, goes to every holder — never to nobody.
 */
export const OWN_TEAM_ROLES = ['technical_manager', 'service_manager'];

/**
 * Roles a SUPERVISOR step names whose holders on the requester's TEAM decide
 * it before the requester's "Reports to" (2026-10-17, the owner's call:
 * "always the Team Leader"). Only Team Leader: a leave or overtime step names
 * no role and stays the direct superior's.
 */
export const TEAM_FIRST_ROLES = ['team_leader'];

/** The TEAM_FIRST holders of `roleId` on the requester's own team, never the requester; empty for any other role. */
async function teamFirstHolders(roleId: string, requesterId: string, tx: Prisma.TransactionClient, teamId?: string | null): Promise<string[]> {
  const role = await tx.role.findUnique({ where: { id: roleId }, select: { key: true } });
  if (!role || !TEAM_FIRST_ROLES.includes(role.key)) return [];
  const post = await teamPostHolders(role.key, teamId ?? (await teamOfRequester(requesterId, tx)), requesterId, tx);
  if (post) return post;
  return teamHoldersOf([roleId], requesterId, tx, teamId);
}

/**
 * The holders of a team-scoped role (Back Support) who decide for this
 * requester — the Technical Manager's team rule (2026-10-13, the owner's
 * call: "apply the same team rule to Back Support"), with the teams a holder
 * is set to support on top: a holder handles the teams ticked under
 * "Supports teams" on Admin › Users, else their OWN team
 * (`Employee.industryId`). The step goes to those handling the requester's
 * team, else to every holder — a requester with no team, or a team nobody
 * handles, never stalls. (Until this, a holder with nothing ticked handled
 * every team.)
 */
export async function supportersFor(holders: string[], requesterId: string, tx: Prisma.TransactionClient = prisma, teamId?: string | null): Promise<string[]> {
  if (!holders.length) return holders;
  const [requester, links, own] = await Promise.all([
    teamId ? { industryId: teamId } : tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } }),
    tx.userSupportTeam.findMany({ where: { userId: { in: holders } }, select: { userId: true, industryId: true } }),
    tx.employee.findMany({ where: { userId: { in: holders } }, select: { userId: true, industryId: true } }),
  ]);
  const team = requester?.industryId ?? null;
  if (!team) return holders;
  const handles = (h: string) => {
    const ticked = links.filter((l) => l.userId === h);
    return ticked.length ? ticked.some((l) => l.industryId === team) : own.some((e) => e.userId === h && e.industryId === team);
  };
  const onTeam = holders.filter(handles);
  return onTeam.length ? onTeam : holders;
}

/**
 * The holders of a SUPERVISOR step's fallback role who decide for a requester
 * with no "Reports to" — and of an `OWN_TEAM_ROLES` step (the Technical
 * Manager's) for every requester: those on the requester's own team
 * (`Employee.industryId`) — the CEO on SIT goes to SIT's Team Leader, not to
 * every Team Leader (2026-10-12) — else every holder, so a document never
 * stalls because the team has no leader. The requester is never the reason a
 * team counts as led: a Team Leader alone on their team falls back to all.
 */
export async function leadersFor(holders: string[], requesterId: string, tx: Prisma.TransactionClient = prisma, teamId?: string | null): Promise<string[]> {
  if (!holders.length) return holders;
  const requester = teamId ? { industryId: teamId } : await tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } });
  if (!requester?.industryId) return holders;
  const onTeam = await tx.employee.findMany({
    where: { userId: { in: holders.filter((h) => h !== requesterId) }, industryId: requester.industryId },
    select: { userId: true },
  });
  const ids = new Set(onTeam.map((e) => e.userId));
  const led = holders.filter((h) => ids.has(h));
  return led.length ? led : holders;
}

/**
 * The active holders of `roleIds` on the requester's own team
 * (`Employee.industryId`) — never every holder, never the requester. The
 * borrow slip's first step (2026-10-14): a Technical Manager on the
 * requester's team decides it beside their "Reports to".
 */
export async function teamHoldersOf(roleIds: string[], requesterId: string, tx: Prisma.TransactionClient = prisma, teamId?: string | null): Promise<string[]> {
  if (!roleIds.length) return [];
  const requester = teamId ? { industryId: teamId } : await tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } });
  if (!requester?.industryId) return [];
  const rows = await tx.userRole.findMany({
    where: {
      roleId: { in: roleIds },
      userId: { not: requesterId },
      user: { isActive: true, employee: { industryId: requester.industryId } },
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * Whether the requester HOLDS a step — the role it names (a ROLE step's, or a
 * SUPERVISOR step's fallback: "Team Leader" on the quotation is the
 * `team_leader` role), or the person a USER step names. On a route that lets
 * the preparer sign (`ApprovalWorkflow.preparerSigns`) such a step is signed
 * at submit, dated the submit instant (the owner's call, 2026-10-12: a Team
 * Leader's own quotation, the CEO's own sales order, a Technical Manager's
 * own costing). An HR step is never held: HR never signs its own filing. A
 * PROJECT_MANAGER step is held when the document names the preparer as its
 * Technical Manager, or names none and the preparer holds its role (the job
 * order, 2026-10-16).
 */
export async function holdsStep(
  step: ApprovalStep,
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: ApprovalContext = {},
): Promise<boolean> {
  if (step.approverType === 'USER') return step.userId === requesterId;
  // A job order's Technical Manager step (2026-10-16, the owner's report:
  // Brian Jay, UIT's Technical Manager, raised one and was not on it): held
  // when the order names the preparer as its Technical Manager, or names
  // nobody and the preparer holds the step's role — never when it names
  // somebody else, who must sign it.
  if (step.approverType === 'PROJECT_MANAGER') {
    if (ctx.projectManagerId) return ctx.projectManagerId === requesterId;
    if (ctx.jobId) return false;
    if (!step.roleId) return false;
    return !!(await tx.userRole.findFirst({
      where: { userId: requesterId, roleId: step.roleId, user: { isActive: true } },
      select: { userId: true },
    }));
  }
  if (step.approverType === 'ROLE' || step.approverType === 'SUPERVISOR') {
    // A SUPERVISOR step's other roles count too: a Technical Manager's own
    // borrow request is signed at submit as a Team Leader's is. A ROLE step
    // on an importation is its importation twin's.
    const own = step.approverType === 'ROLE' ? await stepRoleId(step, ctx, tx) : step.roleId;
    const roleIds = [own, ...(step.alsoRoleIds ?? [])].filter((r): r is string => !!r);
    if (!roleIds.length) return false;
    return !!(await tx.userRole.findFirst({
      where: { userId: requesterId, roleId: { in: roleIds }, user: { isActive: true } },
      select: { userId: true },
    }));
  }
  return false;
}

/** The sequences of a route the requester signs at submit — none unless the route lets the preparer sign. */
export async function heldSequences(
  workflow: { preparerSigns: boolean; steps: ApprovalStep[] },
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: ApprovalContext = {},
): Promise<Set<number>> {
  const held = new Set<number>();
  if (!workflow.preparerSigns) return held;
  for (const step of workflow.steps) if (await holdsStep(step, requesterId, tx, ctx)) held.add(step.sequence);
  return held;
}

/**
 * Who may decide the step a PENDING request is at, and in whose place — the
 * ONE test act() and the document's Approval panel (`canAct`) both apply.
 *
 * Never the requester (rule 3, super admins included). An eligible approver
 * acts in their own right. On a route with `standIns`, the manager ("Reports
 * to") of an eligible approver may decide it instead — `onBehalfOfId` is the
 * report they stand in for (the owner's call, 2026-10-12: "the manager or the
 * person they report to can approve … don't show them in the approval"), so
 * nothing lists, tells or queues a stand-in; the decision names who really
 * acted. One level up only. A super admin may act on anything, as before.
 */
export async function deciderFor(
  request: ApprovalRequest & { workflow?: { standIns: boolean } | null },
  step: ApprovalStep,
  userId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ may: boolean; onBehalfOfId: string | null; reason?: 'own' }> {
  if (request.requesterId === userId) return { may: false, onBehalfOfId: null, reason: 'own' };
  const eligible = (await approversForStep(step, request.requesterId, tx, ctxOf(request))).filter((id) => id !== request.requesterId);
  if (eligible.includes(userId)) return { may: true, onBehalfOfId: null };
  if (request.workflow?.standIns && eligible.length) {
    const report = await tx.user.findFirst({
      where: { id: { in: eligible }, supervisorId: userId },
      select: { id: true },
      orderBy: { name: 'asc' },
    });
    if (report) {
      const actor = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
      if (actor?.isActive) return { may: true, onBehalfOfId: report.id };
    }
  }
  const actor = await tx.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
  return { may: !!actor?.isSuperAdmin, onBehalfOfId: null };
}

/**
 * Whether the user may decide an open approval request on any of these
 * documents (`deciderFor`) — the one way a stand-in with no right to the
 * module opens the record they are deciding (`requireAnyOrDecider`).
 */
export async function mayDecide(userId: string, documentType: string, documentIds: string[]): Promise<boolean> {
  if (!documentIds.length) return false;
  const open = await prisma.approvalRequest.findMany({
    where: { documentType, documentId: { in: documentIds }, status: 'PENDING' },
    include: { workflow: { include: { steps: true } } },
  });
  for (const request of open) {
    const step = request.workflow?.steps.find((st) => st.sequence === request.currentSequence);
    if (step && (await deciderFor(request, step, userId)).may) return true;
  }
  return false;
}

/**
 * The instant "Prepared by" prints when the preparer also signed a step at
 * submit: that step's own time, so the two print ONE timestamp on every paper
 * (the owner's call, 2026-10-12). Undefined otherwise — the document's own
 * date stands. A draft's preview never carries a self-signed slot.
 */
export function preparedAt(slots: ApprovalSlot[]): Date | undefined {
  return slots.find((s) => s.selfSigned && s.at)?.at;
}

/** A person who decides a step: enough to name them on a page or a PDF. */
export interface StepPerson {
  id: string;
  name: string;
  position?: string;
  phone?: string;
  email: string;
}

/**
 * Who may decide a step, by name. The requester is left out: act() never lets
 * them approve their own document, so naming them would promise a signature
 * that cannot happen. Empty means nobody can — a role no one else holds — and
 * the document would stall there.
 */
export async function namedApprovers(
  step: ApprovalStep,
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: ApprovalContext = {},
): Promise<StepPerson[]> {
  const ids = [...new Set(await approversForStep(step, requesterId, tx, ctx))].filter((id) => id !== requesterId);
  if (!ids.length) return [];
  const users = await tx.user.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, name: true, position: true, email: true, phone: true, employee: { select: { mobile: true } } },
    orderBy: { name: 'asc' },
  });
  return users.map((u) => ({ id: u.id, name: u.name, position: u.position ?? undefined, phone: contactPhone(u), email: u.email }));
}

/**
 * The route a document WOULD take if it were submitted now — each step and
 * who would decide it — so a form can say where "Submit for approval" goes
 * before anybody presses it. `optionId` previews an optional route ("Add the
 * CEO as approver"); null when no active workflow covers the document.
 */
export async function routePreview(
  documentType: string,
  amount: number | null,
  requesterId: string,
  optionId?: string | null,
  ctx: ApprovalContext = {},
): Promise<{ workflowId: string; name: string; steps: { sequence: number; name: string; roleId: string | null; held: boolean; approvers: StepPerson[] }[] } | null> {
  const workflow = await pickWorkflow(documentType, amount, { option: optionId ?? null, requesterId });
  if (!workflow) return null;
  // A step the preparer holds on a route that lets them sign is THEIRS: it is
  // signed at submit, so it names them alone (`held`).
  const held = await heldSequences(workflow, requesterId, prisma, ctx);
  const self = held.size
    ? await prisma.user.findUnique({
        where: { id: requesterId },
        select: { id: true, name: true, position: true, email: true, phone: true, employee: { select: { mobile: true } } },
      })
    : null;
  const selfPerson: StepPerson[] = self
    ? [{ id: self.id, name: self.name, position: self.position ?? undefined, phone: contactPhone(self), email: self.email }]
    : [];
  return {
    workflowId: workflow.id,
    name: workflow.name,
    steps: await Promise.all(
      workflow.steps.map(async (st) =>
        held.has(st.sequence)
          ? { sequence: st.sequence, name: st.name, roleId: st.roleId, held: true, approvers: selfPerson }
          : { sequence: st.sequence, name: st.name, roleId: st.roleId, held: false, approvers: await namedApprovers(st, requesterId, prisma, ctx) },
      ),
    ),
  };
}

/** A route as a page names it before anybody presses Submit: names only, never contact lines. */
export interface RouteBrief {
  name: string;
  /** `held`: the preparer signs this step themselves, at submit. */
  steps: { name: string; held: boolean; approvers: { id: string; name: string }[] }[];
}

/**
 * `routePreview` for a page — "Submit for approval sends it to …" — the
 * workflow's name and, step by step, who would decide it, by name only (a
 * page's JSON never carries a mobile). Null when no active workflow covers
 * the document; an option it is out of band for is null too.
 */
export async function routeBrief(
  documentType: string,
  amount: number | null,
  requesterId: string,
  optionId?: string | null,
  ctx: ApprovalContext = {},
): Promise<RouteBrief | null> {
  const route = await routePreview(documentType, amount, requesterId, optionId, ctx);
  return (
    route && {
      name: route.name,
      steps: route.steps.map((st) => ({ name: st.name, held: st.held, approvers: st.approvers.map((p) => ({ id: p.id, name: p.name })) })),
    }
  );
}

/** Active users holding a role, by key. HR fallbacks and the clearance sweep read it. */
export async function usersInRole(
  roleKey: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  const role = await tx.role.findUnique({
    where: { key: roleKey },
    include: { users: { where: { user: { isActive: true } }, select: { userId: true } } },
  });
  return role?.users.map((u) => u.userId) ?? [];
}

// ── Submitting ───────────────────────────────────────────────────────────────

export interface SubmitInput {
  documentType: string;
  documentId: string;
  documentNumber?: string | null;
  subject: string;
  amount?: number | null;
  link?: string | null;
  requesterId: string;
  /** An optional route the submitter chose (see `approvalOptions`); the standard pick otherwise. */
  optionId?: string | null;
  /** The project the document is about, for a PROJECT_MANAGER step. */
  jobId?: string | null;
  /** The manager the document names itself (a job order's), for a PROJECT_MANAGER step before any project exists. */
  projectManagerId?: string | null;
  /** An importation (no VAT): a Purchasing Manager step goes to the Importation manager. */
  importation?: boolean;
  /** The team the document is for, in place of the requester's own (`ApprovalContext.teamId`). */
  teamId?: string | null;
}

export async function submitForApproval(input: SubmitInput): Promise<ApprovalRequest> {
  const existing = await prisma.approvalRequest.findFirst({
    where: {
      documentType: input.documentType,
      documentId: input.documentId,
      status: 'PENDING',
    },
  });
  if (existing) throw badRequest('This document is already awaiting approval');

  const workflow = await pickWorkflow(input.documentType, input.amount, { option: input.optionId, requesterId: input.requesterId });
  if (input.optionId && !workflow) {
    throw badRequest('That approval option does not apply to this document — the amount is outside its band, or it was switched off');
  }
  // A route with no steps is the preparer's role needing nobody's approval
  // (a CEO's quotation): the request is written APPROVED, audited and
  // settled at once, through the same subscribers a last signature reaches.
  if (workflow && workflow.steps.length === 0 && workflow.requesterRoleId) {
    const approved = await prisma.approvalRequest.create({
      data: {
        documentType: input.documentType,
        documentId: input.documentId,
        documentNumber: input.documentNumber ?? null,
        subject: input.subject,
        amount: input.amount != null ? new Prisma.Decimal(input.amount) : null,
        link: input.link ?? null,
        requesterId: input.requesterId,
        jobId: input.jobId ?? null,
        projectManagerId: input.projectManagerId ?? null,
        importation: input.importation ?? false,
        teamId: input.teamId ?? null,
        workflowId: workflow.id,
        currentSequence: 1,
        status: 'APPROVED',
        closedAt: new Date(),
      },
    });
    await audit({
      entityType: input.documentType,
      entityId: input.documentId,
      action: 'APPROVED',
      summary: `Approved on submit — ${workflow.name} needs no approval`,
      actorId: input.requesterId,
    });
    await emitSettled(approved, 'APPROVED');
    return approved;
  }
  if (!workflow || workflow.steps.length === 0) {
    throw badRequest(
      `No approval workflow is configured for "${input.documentType}". Set one up in Admin › Approval Workflows.`,
    );
  }

  // The steps the preparer holds, on a route that lets them sign
  // (`preparerSigns`): signed at submit, dated the request's own instant, so
  // "Prepared by" and those steps print one timestamp. The document waits
  // only on the steps other people hold.
  const submitCtx: ApprovalContext = { jobId: input.jobId ?? null, projectManagerId: input.projectManagerId ?? null, importation: input.importation ?? false, teamId: input.teamId ?? null };
  const held = await heldSequences(workflow, input.requesterId, prisma, submitCtx);
  const open = workflow.steps.filter((st) => !held.has(st.sequence));

  // A step whose only eligible approver is the requester can never be acted on:
  // segregation of duties refuses self-approval, so the document would sit
  // pending forever with no error anywhere. This is the subtler cousin of "no
  // one holds this role" — there IS an approver set, it just contains only the
  // person who raised it. Caught here, at submission, while it can still be
  // fixed by changing the workflow rather than by wondering why nothing moved.
  // (A step the preparer signs themselves is not waiting on anybody.)
  const firstStep = open[0];
  if (firstStep) {
    const firstApprovers = await approversForStep(firstStep, input.requesterId, prisma, submitCtx);
    if (firstApprovers.length && firstApprovers.every((id) => id === input.requesterId)) {
      throw badRequest(
        `"${workflow.name}" routes step ${firstStep.sequence} ("${firstStep.name}") only to you, and nobody may approve a document they raised. ` +
          `Add another approver to that step in Admin › Approval Workflows.`,
      );
    }
    if (!firstApprovers.length) {
      throw badRequest(
        `"${workflow.name}" routes step ${firstStep.sequence} ("${firstStep.name}") to nobody. ` +
          `Check that someone holds that role in Admin › Approval Workflows.`,
      );
    }
  }

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.approvalRequest.create({
      data: {
        documentType: input.documentType,
        documentId: input.documentId,
        documentNumber: input.documentNumber ?? null,
        subject: input.subject,
        amount: input.amount != null ? new Prisma.Decimal(input.amount) : null,
        link: input.link ?? null,
        requesterId: input.requesterId,
        jobId: input.jobId ?? null,
        projectManagerId: input.projectManagerId ?? null,
        importation: input.importation ?? false,
        teamId: input.teamId ?? null,
        workflowId: workflow.id,
        currentSequence: (firstStep ?? workflow.steps[workflow.steps.length - 1]).sequence,
        status: firstStep ? 'PENDING' : 'APPROVED',
      },
    });
    if (!held.size) return created;
    await tx.approvalAction.createMany({
      data: workflow.steps
        .filter((st) => held.has(st.sequence))
        .map((st) => ({
          requestId: created.id,
          stepId: st.id,
          sequence: st.sequence,
          approverId: input.requesterId,
          action: 'APPROVED' as const,
          selfSigned: true,
          actedAt: created.createdAt,
        })),
    });
    // Every step the preparer's own: approved on submit, closed at that instant.
    return firstStep ? created : tx.approvalRequest.update({ where: { id: created.id }, data: { closedAt: created.createdAt } });
  });

  await audit({
    entityType: input.documentType,
    entityId: input.documentId,
    action: 'SUBMITTED',
    summary: `Submitted for approval — ${workflow.name}`,
    actorId: input.requesterId,
  });
  if (held.size) {
    const preparer = await prisma.user.findUnique({ where: { id: input.requesterId }, select: { name: true } });
    for (const st of workflow.steps.filter((x) => held.has(x.sequence))) {
      await audit({
        entityType: input.documentType,
        entityId: input.documentId,
        action: 'APPROVED',
        summary: `${st.name} — ${preparer?.name ?? 'the preparer'}, signed at submit (holds the step)`,
        actorId: input.requesterId,
      });
    }
  }

  if (!firstStep) {
    await audit({
      entityType: input.documentType,
      entityId: input.documentId,
      action: 'APPROVED',
      summary: `Approved on submit — every step of ${workflow.name} is the preparer's own`,
      actorId: input.requesterId,
    });
    await emitSettled(request, 'APPROVED');
    return request;
  }

  await notifyCurrentStep(request);
  return request;
}

async function notifyCurrentStep(request: ApprovalRequest): Promise<void> {
  if (!request.workflowId) return;
  const step = await prisma.approvalStep.findFirst({
    where: { workflowId: request.workflowId, sequence: request.currentSequence },
  });
  if (!step) return;

  const approverIds = await approversForStep(step, request.requesterId, prisma, ctxOf(request));
  if (!approverIds.length) {
    console.warn(
      `Approval request ${request.id} reached step "${step.name}" with no eligible approver.`,
    );
    return;
  }

  await notify(
    approverIds.map((userId) => ({
      userId,
      type: 'approval.required' as const,
      title: `${step.name}: ${request.subject}`,
      body: request.documentNumber ?? undefined,
      link: request.link ?? undefined,
    })),
  );
}

// ── Acting ───────────────────────────────────────────────────────────────────

export interface ActInput {
  requestId: string;
  userId: string;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  comment?: string;
}

export async function act(input: ActInput): Promise<ApprovalRequest> {
  const request = await prisma.approvalRequest.findUnique({
    where: { id: input.requestId },
    include: { workflow: { include: { steps: { orderBy: { sequence: 'asc' } } } } },
  });
  if (!request) throw notFound('Approval request not found');
  // CANCELLED is a request withdrawn (see cancelOpenRequest) or returned:
  // either way, nothing is waiting on it now.
  if (request.status === 'CANCELLED') throw badRequest('This request is no longer open — nothing is waiting on it');
  if (request.status !== 'PENDING') throw badRequest('This request has already been decided');

  const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
  if (!step) throw badRequest('This request has no current step — its workflow may have changed');

  // Segregation of duties (model §6.2): requester ≠ approver. Enforced even for
  // super admins, because self-approval is the failure this rule exists to stop.
  //
  // Checked BEFORE eligibility, and that order matters. A project manager who
  // raises a purchase request that routes to the project_manager role IS an
  // eligible approver — they are exactly who this rule has to stop, and only
  // this ordering gives them the accurate reason.
  if (request.requesterId === input.userId) {
    throw forbidden('You cannot approve a document you raised yourself');
  }

  // An eligible approver, a stand-in (their manager, on a route that allows
  // one) or a super admin — `deciderFor`, the panel's own test.
  const decider = await deciderFor(request, step, input.userId);
  if (!decider.may) throw forbidden('This approval is not yours to act on');
  const actor = await prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } });
  const stoodInFor = decider.onBehalfOfId
    ? await prisma.user.findUnique({ where: { id: decider.onBehalfOfId }, select: { name: true } })
    : null;

  // The next step nobody has signed: a step the preparer signed at submit is
  // passed over, so the CEO's own sales order settles on the Cost
  // Controller's signature.
  const signed = new Set(
    (await prisma.approvalAction.findMany({ where: { requestId: request.id, action: 'APPROVED' }, select: { sequence: true } })).map(
      (a) => a.sequence,
    ),
  );
  const steps = request.workflow!.steps;
  const later = steps.slice(steps.findIndex((s) => s.sequence === step.sequence) + 1).filter((s) => !signed.has(s.sequence));

  // One signature per person (2026-10-13, the owner's call: "the time stamp
  // of the same employee with multiple roles … make it uniform"). On a route
  // where the preparer signs the steps they hold, an approver's Approve also
  // signs every LATER unsigned step they may decide in their own right —
  // never as a stand-in, never the requester — at the same instant, so one
  // person is asked once and prints one timestamp. A stand-in signs only the
  // step they stood in for.
  const coSigned: ApprovalStep[] = [];
  if (input.action === 'APPROVED' && request.workflow?.preparerSigns && !decider.onBehalfOfId) {
    for (const st of later) {
      const eligible = await approversForStep(st, request.requesterId, prisma, ctxOf(request));
      if (eligible.includes(input.userId)) coSigned.push(st);
    }
  }
  const coSignedSeqs = new Set(coSigned.map((s) => s.sequence));
  const next = later.find((s) => !coSignedSeqs.has(s.sequence));
  const at = new Date();

  const settled = await prisma.$transaction(async (tx) => {
    // Claimed, never simply written: the request must still be open at this
    // step. One withdrawn (cancelOpenRequest) or decided by somebody else since
    // it was read above is refused here — written over, a withdrawn request
    // would come back decided, and two approvers on one step would both count.
    const claimed = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING', currentSequence: step.sequence },
      data:
        input.action !== 'APPROVED'
          ? { status: input.action === 'REJECTED' ? 'REJECTED' : 'CANCELLED', closedAt: at }
          : next
            ? { currentSequence: next.sequence }
            : { status: 'APPROVED', closedAt: at },
    });
    if (!claimed.count) {
      throw badRequest('This request was decided or withdrawn a moment ago — reload to see where it stands');
    }

    await tx.approvalAction.create({
      data: {
        requestId: request.id,
        stepId: step.id,
        sequence: step.sequence,
        approverId: input.userId,
        onBehalfOfId: decider.onBehalfOfId,
        action: input.action,
        comment: input.comment ?? null,
        actedAt: at,
      },
    });
    if (coSigned.length) {
      await tx.approvalAction.createMany({
        data: coSigned.map((st) => ({
          requestId: request.id,
          stepId: st.id,
          sequence: st.sequence,
          approverId: input.userId,
          action: 'APPROVED' as const,
          coSignedWith: step.sequence,
          actedAt: at,
        })),
      });
    }
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
  });

  await audit({
    entityType: request.documentType,
    entityId: request.documentId,
    action: input.action,
    summary: `${step.name} — ${actor?.name ?? 'unknown'}${stoodInFor ? ` (standing in for ${stoodInFor.name})` : ''}${input.comment ? `: ${input.comment}` : ''}`,
    actorId: input.userId,
  });
  for (const st of coSigned) {
    await audit({
      entityType: request.documentType,
      entityId: request.documentId,
      action: 'APPROVED',
      summary: `${st.name} — ${actor?.name ?? 'unknown'}, signed with ${step.name} (holds both)`,
      actorId: input.userId,
    });
  }

  if (settled.status === 'PENDING') {
    await notifyCurrentStep(settled);
  } else {
    const approved = settled.status === 'APPROVED';
    await notify({
      userId: settled.requesterId,
      type: approved ? 'approval.approved' : 'approval.rejected',
      title: `${approved ? 'Approved' : input.action === 'RETURNED' ? 'Returned' : 'Rejected'}: ${settled.subject}`,
      body: input.comment ?? settled.documentNumber ?? undefined,
      link: settled.link ?? undefined,
    });
    await emitSettled(settled, approved ? 'APPROVED' : 'REJECTED');
  }

  return settled;
}

// ── Withdrawing ──────────────────────────────────────────────────────────────

/**
 * Withdraws a document's open approval request, in the caller's transaction,
 * because the document moved on before anybody decided — a quotation revision
 * superseded by the next. Left open, the request would sit in its approvers'
 * queues for good, and a decision on it would land on a document that no
 * longer waits for one.
 *
 * It closes CANCELLED, as a returned request does in act(), and is audited and
 * told like any other step: the approvers it was waiting on hear it was
 * withdrawn, and so does the requester when somebody else withdrew it. It is
 * not an outcome, so no onApprovalSettled subscriber hears of it — the module
 * withdrawing it already knows why.
 *
 * Claimed with a conditional update: a decision that landed first stands and
 * nothing is withdrawn; one arriving after is refused by act(). Returns what
 * it withdrew — nothing when nothing was open, so calling it twice is safe.
 */
export async function cancelOpenRequest(
  documentType: string,
  documentId: string,
  tx: Prisma.TransactionClient,
  reason: string,
  actorId: string | null = null,
): Promise<ApprovalRequest[]> {
  // One open request per document is the engine's rule (submitForApproval),
  // but every open one goes: a request left behind is the fault this fixes.
  const open = await tx.approvalRequest.findMany({
    where: { documentType, documentId, status: 'PENDING' },
    select: { id: true },
  });
  const withdrawn: ApprovalRequest[] = [];
  for (const { id } of open) {
    const claimed = await tx.approvalRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', closedAt: new Date() },
    });
    if (!claimed.count) continue; // decided while this ran: the decision stands

    const { workflow, ...request } = await tx.approvalRequest.findUniqueOrThrow({
      where: { id },
      include: { workflow: { include: { steps: true } } },
    });
    const step = workflow?.steps.find((s) => s.sequence === request.currentSequence);
    await audit(
      {
        entityType: documentType,
        entityId: documentId,
        action: 'CANCELLED',
        summary: `Withdrawn from approval${step ? ` at ${step.name}` : ''} — ${reason}`,
        actorId,
      },
      undefined,
      tx,
    );

    // Whoever it was waiting on, and whoever raised it — never the person who
    // withdrew it, who knows.
    const told = new Set([
      ...(step ? await approversForStep(step, request.requesterId, tx, ctxOf(request)) : []),
      request.requesterId,
    ]);
    if (actorId) told.delete(actorId);
    await notify(
      [...told].map((userId) => ({
        userId,
        type: 'approval.withdrawn' as const,
        title: `Withdrawn: ${request.subject}`,
        body: [request.documentNumber, reason].filter(Boolean).join(' — '),
        link: request.link ?? undefined,
      })),
      tx,
    );
    withdrawn.push(request);
  }
  return withdrawn;
}

// ── Pulling back an approved document ────────────────────────────────────────

/**
 * Every approved document can be pulled back to draft (2026-10-16, the
 * owner's call) — by whoever prepared it, or whoever may edit them all. The
 * module that owns the document registers how: `may` says whether this user
 * may (the button), `reopen` undoes what the approval did and puts the
 * document back to its draft state inside the engine's transaction — or
 * throws a 400 naming what stands on it (an order with goods received, an
 * invoice with a collection), and then nothing changes. The engine closes
 * the approved request CANCELLED with `reopenedAt`, `reopenedById` and the
 * reason (its signatures stay in the history), audits it and tells whoever
 * signed and whoever raised it. Not an outcome: no onApprovalSettled
 * subscriber hears of it. One path, like every other decision (rule 2).
 */
export interface ReopenContext {
  documentId: string;
  tx: Prisma.TransactionClient;
  actor: ResolvedUser;
  reason: string;
}
interface Reopener {
  may: (actor: ResolvedUser, documentId: string) => Promise<boolean>;
  reopen: (ctx: ReopenContext) => Promise<void>;
}
const reopeners = new Map<string, Reopener>();

export function onApprovalReopened(documentType: string, reopener: Reopener): void {
  reopeners.set(documentType, reopener);
}

/** The latest request of a document, when it stands APPROVED. */
async function standingApproval(documentType: string, documentId: string, tx: Prisma.TransactionClient = prisma) {
  const latest = await tx.approvalRequest.findFirst({ where: { documentType, documentId }, orderBy: { createdAt: 'desc' } });
  return latest?.status === 'APPROVED' ? latest : null;
}

/** Whether the viewer may pull this approved document back (the button). */
export async function mayReopen(documentType: string, documentId: string, actor: ResolvedUser): Promise<boolean> {
  const reopener = reopeners.get(documentType);
  if (!reopener) return false;
  if (!(await standingApproval(documentType, documentId))) return false;
  return reopener.may(actor, documentId);
}

export async function reopenApproved(documentType: string, documentId: string, actor: ResolvedUser, reason: string): Promise<ApprovalRequest> {
  const reopener = reopeners.get(documentType);
  if (!reopener) throw badRequest('This document cannot be pulled back once approved');
  const approved = await standingApproval(documentType, documentId);
  if (!approved) throw badRequest('It is not approved — nothing to pull back');
  if (!(await reopener.may(actor, documentId))) throw forbidden('Only whoever prepared it, or whoever may edit them all, can pull it back');
  const why = reason.trim();
  if (!why) throw badRequest('Say why it is being pulled back');

  const request = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: approved.id, status: 'APPROVED' },
        data: { status: 'CANCELLED', reopenedAt: new Date(), reopenedById: actor.id, reopenReason: why },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      await reopener.reopen({ documentId, tx, actor, reason: why });
      await audit(
        {
          entityType: documentType,
          entityId: documentId,
          action: 'CANCELLED',
          summary: `Pulled back to draft after approval by ${actor.name} — ${why}`,
          actorId: actor.id,
        },
        undefined,
        tx,
      );
      const signers = await tx.approvalAction.findMany({ where: { requestId: approved.id }, select: { approverId: true } });
      const told = new Set([...signers.map((a) => a.approverId), approved.requesterId]);
      told.delete(actor.id);
      await notify(
        [...told].map((userId) => ({
          userId,
          type: 'approval.withdrawn' as const,
          title: `Pulled back after approval: ${approved.subject}`,
          body: [approved.documentNumber, `${actor.name}: ${why}`].filter(Boolean).join(' — '),
          link: approved.link ?? undefined,
        })),
        tx,
      );
      return tx.approvalRequest.findUniqueOrThrow({ where: { id: approved.id } });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
  return request;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Everything currently sitting in one user's approval queue — with who raised
 * it, because an approver deciding on subject and amount alone is deciding
 * blind.
 */
export async function pendingFor(
  userId: string,
): Promise<(ApprovalRequest & { requester: { name: string }; followedUpBy?: string })[]> {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    include: { workflow: { include: { steps: true } }, requester: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const mine: (ApprovalRequest & { requester: { name: string }; followedUpBy?: string })[] = [];
  // A stand-in is never queued — until the requester follows up to them
  // (2026-10-17): then the request sits in their queue too, saying so.
  const followed = await prisma.approvalFollowUp.findMany({
    where: { toIds: { has: userId }, request: { status: 'PENDING' } },
    select: { requestId: true, sequence: true, by: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const request of pending) {
    if (request.requesterId === userId) continue; // never your own
    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (!step) continue;
    const eligible = await approversForStep(step, request.requesterId, prisma, ctxOf(request));
    if (eligible.includes(userId)) {
      mine.push(request);
      continue;
    }
    const asked = followed.find((f) => f.requestId === request.id && f.sequence === request.currentSequence);
    if (asked) mine.push({ ...request, followedUpBy: asked.by.name });
  }
  return mine;
}

/**
 * The requester's follow-up (2026-10-17, the owner's call: "the manager
 * should not appear … if the purchasing officer is absent, the purchasing
 * manager can approve, but don't show them initially; the requestor can
 * raise a follow-up to the purchasing manager"). On a route with
 * `standIns`, the managers ("Reports to") of the open step's approvers are
 * told and from then on see the request in their queue; the approvers are
 * told too. The request itself does not move — whoever acts first claims it.
 * Only the requester (a super admin too), only while PENDING, once per step
 * a day; a 400 names the approver when nobody stands above them.
 */
export const FOLLOW_UP_EVERY_MS = 24 * 60 * 60 * 1000;

export async function followUp(requestId: string, userId: string, note?: string | null) {
  const request = await prisma.approvalRequest.findUnique({
    where: { id: requestId },
    include: { workflow: { include: { steps: true } }, requester: { select: { name: true } } },
  });
  if (!request) throw notFound('Approval request not found');
  if (request.status !== 'PENDING') throw badRequest('This request is no longer waiting on anybody');
  if (request.requesterId !== userId) {
    const actor = await prisma.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true } });
    if (!actor?.isSuperAdmin) throw forbidden('Only the person who raised it may follow up');
  }
  if (!request.workflow?.standIns) throw badRequest('This route lets nobody stand in for its approvers — the approver has to decide it');
  const step = request.workflow.steps.find((s) => s.sequence === request.currentSequence);
  if (!step) throw badRequest('The request is at a step its route no longer has');
  const eligible = (await approversForStep(step, request.requesterId, prisma, ctxOf(request))).filter((id) => id !== request.requesterId);
  if (!eligible.length) throw badRequest(`Nobody can decide "${step.name}" — ask an administrator to check the route`);
  const approvers = await prisma.user.findMany({ where: { id: { in: eligible } }, select: { id: true, name: true, supervisorId: true } });
  const managerIds = [...new Set(approvers.map((a) => a.supervisorId).filter((id): id is string => !!id && id !== request.requesterId))];
  const managers = managerIds.length
    ? await prisma.user.findMany({ where: { id: { in: managerIds }, isActive: true }, select: { id: true, name: true } })
    : [];
  if (!managers.length) {
    throw badRequest(`${approvers.map((a) => a.name).join(' and ')} report${approvers.length === 1 ? 's' : ''} to nobody in G-CORE — set "Reports to" on Admin › Users, or ask an administrator to decide it`);
  }
  const last = await prisma.approvalFollowUp.findFirst({
    where: { requestId, sequence: step.sequence },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (last && Date.now() - last.createdAt.getTime() < FOLLOW_UP_EVERY_MS) {
    const again = new Date(last.createdAt.getTime() + FOLLOW_UP_EVERY_MS);
    throw conflict(`Already followed up on ${step.name} today — it may be sent again after ${again.toISOString()}`, { again: again.toISOString() });
  }
  const row = await prisma.approvalFollowUp.create({
    data: { requestId, sequence: step.sequence, byId: userId, toIds: managers.map((m) => m.id), note: note?.trim() || null },
  });
  const by = userId === request.requesterId ? request.requester.name : ((await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? 'an administrator');
  const names = approvers.map((a) => a.name).join(' or ');
  await audit({
    entityType: request.documentType,
    entityId: request.documentId,
    action: 'SUBMITTED',
    summary: `Followed up on ${step.name} to ${managers.map((m) => m.name).join(' and ')} — ${names} has not acted${row.note ? `: ${row.note}` : ''}`,
    actorId: userId,
  });
  const link = request.link ?? undefined;
  await notify([
    ...managers.map((m) => ({
      userId: m.id,
      type: 'approval.follow_up' as const,
      title: `Follow-up: ${request.subject}`,
      body: `${names} has not acted on ${step.name}${request.documentNumber ? ` of ${request.documentNumber}` : ''} — you may decide it in their place.${row.note ? ` ${by} says: ${row.note}` : ''}`,
      link,
    })),
    ...approvers.map((a) => ({
      userId: a.id,
      type: 'approval.follow_up' as const,
      title: `Followed up: ${request.subject}`,
      body: `${by} followed up ${step.name} to ${managers.map((m) => m.name).join(' and ')}.`,
      link,
    })),
  ]);
  // An email where SMTP is set, never allowed to fail the follow-up.
  const cfg = mailConfig();
  if (cfg) {
    const people = await prisma.user.findMany({ where: { id: { in: managers.map((m) => m.id) } }, select: { email: true, name: true } });
    const url = `${env.appUrl.replace(/\/+$/, '')}${request.link ?? ''}`;
    for (const p of people) {
      try {
        await sendMail({ to: p.email, toName: p.name, subject: `Follow-up: ${request.subject}`, text: `${names} has not acted on ${step.name}${request.documentNumber ? ` of ${request.documentNumber}` : ''} — you may decide it in their place.${row.note ? `\n\n${by} says: ${row.note}` : ''}\n\n${url}` }, cfg);
      } catch (err) {
        console.error(`Follow-up email to ${p.email} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { ...row, to: managers, step: step.name };
}

/**
 * The full decision history of one document, for its Activity tab. On a
 * request still open, each step nobody has taken carries `approvers` — who
 * may decide it, by name — so a page says who a document waits on, not only
 * that it waits.
 */
export async function historyFor(documentType: string, documentId: string) {
  const rows = await prisma.approvalRequest.findMany({
    where: { documentType, documentId },
    include: {
      requester: { select: { id: true, name: true } },
      workflow: { select: { name: true, steps: { orderBy: { sequence: 'asc' } } } },
      actions: {
        include: { approver: { select: { id: true, name: true } }, onBehalfOf: { select: { id: true, name: true } } },
        orderBy: [{ actedAt: 'asc' }, { sequence: 'asc' }],
      },
      followUps: { include: { by: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  // The managers a follow-up went to, by name.
  const toIds = [...new Set(rows.flatMap((r) => r.followUps.flatMap((f) => f.toIds)))];
  const toNames = new Map(
    toIds.length ? (await prisma.user.findMany({ where: { id: { in: toIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]) : [],
  );
  const named = rows.map((r) => ({
    ...r,
    followUps: r.followUps.map((f) => ({ ...f, to: f.toIds.map((id) => ({ id, name: toNames.get(id) ?? 'a manager' })) })),
  }));
  return Promise.all(
    named.map(async (r) => {
      if (r.status !== 'PENDING' || !r.workflow) return r;
      const taken = new Set(r.actions.map((a) => a.sequence));
      const steps = await Promise.all(
        r.workflow.steps.map(async (st) =>
          taken.has(st.sequence)
            ? st
            : { ...st, approvers: (await namedApprovers(st, r.requesterId, prisma, ctxOf(r))).map((p) => ({ id: p.id, name: p.name })) },
        ),
      );
      return { ...r, workflow: { ...r.workflow, steps } };
    }),
  );
}

/**
 * Who signed off at each step of a document's approval, and when.
 *
 * Feeds the signature block on a PDF: the approval engine already records the
 * approver and the moment they acted, so a printed document can carry a real
 * name and a real timestamp under "Checked by" and "Approved by" instead of an
 * empty rule.
 *
 * In step order, approvals only. A rejection is not a sign-off, and a document
 * that was rejected and resubmitted should print the approvals that stand — so
 * the latest request wins, not the accumulated history of every attempt.
 */
export async function approvalSignoffs(
  documentType: string,
  documentId: string,
): Promise<{ name: string; position?: string; at: Date }[]> {
  const request = await prisma.approvalRequest.findFirst({
    where: { documentType, documentId },
    orderBy: { createdAt: 'desc' },
    include: {
      actions: {
        where: { action: 'APPROVED' },
        orderBy: { sequence: 'asc' },
        include: { approver: { select: { name: true, position: true } } },
      },
    },
  });

  return (request?.actions ?? []).map((a) => ({
    name: a.approver.name,
    position: a.approver.position ?? undefined,
    at: a.actedAt,
  }));
}

/**
 * The sign-off block of a routed document, one slot per step, as the PDF
 * engine prints it (rule 6): the step's name is the role, who signed it with
 * their contact lines and the date — or who is assigned to it, so "Pending"
 * prints under a name (one person with their lines; several as "A or B",
 * with none) — and a step nobody can sign as the role alone. Every routed
 * document's PDF maps its slots through this and nothing else; a document's
 * own first slot (Prepared by / Requested by, the author, dated) goes before
 * them, and "Approved by" alone only where no route exists.
 */
export function slotSignatories(slots: ApprovalSlot[]): Signatory[] {
  // The position travels too: the house dress never prints one, but a
  // designed layout (the quotation's, the sales order's) may tick
  // `showPosition`, and a slot is the same slot on either.
  return slots.map((s) => {
    if (s.name) return { role: s.step, name: s.name, position: s.position, phone: s.phone, email: s.email, at: s.at };
    const who = s.assigned ?? [];
    if (who.length === 1) return { role: s.step, name: who[0].name, position: who[0].position, phone: who[0].phone, email: who[0].email };
    return { role: s.step, name: who.length ? who.map((p) => p.name).join(' or ') : undefined };
  });
}

/**
 * One name per person on paper (2026-10-13, the owner's call for the
 * quotation: "any name with multiple roles … is one name only"). The slots
 * to print after the document's own "Prepared by" (`preparerId`): a step
 * signed by somebody already on the paper is left out — the preparer's own
 * steps (signed at submit, or named on a draft's preview) are their
 * Prepared by, an approver's co-signed steps their first signature — and so
 * is an open step that somebody already on it may sign. Only what
 * is PRINTED changes: the request keeps every signature, and the Approval
 * panel still shows each step.
 */
export function onePerPerson(slots: ApprovalSlot[], preparerId: string): ApprovalSlot[] {
  const seen = new Set<string>([preparerId]);
  const kept: ApprovalSlot[] = [];
  for (const slot of slots) {
    if (slot.name) {
      if (slot.userId && seen.has(slot.userId)) continue;
      if (slot.userId) seen.add(slot.userId);
    } else {
      // Somebody already on the paper who may sign this step will sign it
      // with their own earlier signature (`act()` co-signs every later step
      // the decider holds), so it is not printed again.
      const who = slot.assigned ?? [];
      if (who.some((p) => seen.has(p.id))) continue;
      if (who.length === 1) seen.add(who[0].id);
    }
    kept.push(slot);
  }
  return kept;
}

/**
 * A signer printed under their HIGHEST role (2026-10-21, the owner's call on
 * the purchase order: "always the highest level of position (CEO), even if
 * he also holds the level-2 Purchasing Manager for imports"). A slot signed
 * — or, still open, to be signed by one person — by somebody at the TOP
 * level (`Role.rank` 1) on a step naming a lower-level role takes their
 * title as its heading ("CEO / President"); everyone else keeps the step's
 * name. Only the heading changes. Pair it with
 * `onePerPerson`, so one person who signed two steps prints once.
 */
export async function byHighestRole(slots: ApprovalSlot[]): Promise<ApprovalSlot[]> {
  const people = new Set<string>();
  const stepRoles = new Set<string>();
  for (const s of slots) {
    const who = s.name ? s.userId : s.assigned?.length === 1 ? s.assigned[0].id : undefined;
    if (who) people.add(who);
    if (s.stepRoleId) stepRoles.add(s.stepRoleId);
  }
  if (!people.size) return slots;
  const [holders, roles] = await Promise.all([
    prisma.userRole.findMany({
      where: { userId: { in: [...people] }, role: { rank: { not: null } } },
      select: { userId: true, role: { select: { name: true, rank: true, sortOrder: true } } },
    }),
    prisma.role.findMany({ where: { id: { in: [...stepRoles] } }, select: { id: true, rank: true } }),
  ]);
  const stepRank = new Map(roles.map((r) => [r.id, r.rank]));
  const top = new Map<string, { rank: number; title: string }>();
  for (const id of people) {
    const mine = holders.filter((h) => h.userId === id).map((h) => h.role);
    if (!mine.length) continue;
    mine.sort((a, b) => a.rank! - b.rank! || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const best = mine[0].rank!;
    top.set(id, { rank: best, title: [...new Set(mine.filter((r) => r.rank === best).map((r) => r.name))].join(' / ') });
  }
  return slots.map((s) => {
    const who = s.name ? s.userId : s.assigned?.length === 1 ? s.assigned[0].id : undefined;
    const mine = who ? top.get(who) : undefined;
    const rank = s.stepRoleId ? stepRank.get(s.stepRoleId) : null;
    // A step naming no ranked role (a supervisor's "Reports to") keeps its name,
    // and so does any step signed below the top level: only the head of the
    // company (level 1) signs as such whatever the step — a Back Support who
    // also holds another role is still asked, and printed, as Back Support.
    if (!mine || rank == null || mine.rank !== 1 || mine.rank >= rank) return s;
    return { ...s, step: mine.title };
  });
}

/**
 * A step co-signed with an earlier Approve by somebody already printed is
 * left off the paper (2026-10-21): one person, one signature. Open steps and
 * the preparer's own signed steps are untouched — the narrower half of
 * `onePerPerson`, for the papers that keep both.
 */
export function withoutCoSignedRepeats(slots: ApprovalSlot[]): ApprovalSlot[] {
  const seen = new Set<string>();
  return slots.filter((s) => {
    if (!s.name || !s.userId) return true;
    if (s.coSigned && seen.has(s.userId)) return false;
    seen.add(s.userId);
    return true;
  });
}

/** One step of a document's sign-off block. */
export interface ApprovalSlot {
  step: string;
  /** Who signed it, and when — set only once the step has approved. */
  name?: string;
  position?: string;
  phone?: string;
  email?: string;
  at?: Date;
  /** A step still open: who may yet sign it (never the requester). */
  assigned?: StepPerson[];
  /** Who signed it — set with `name`. */
  userId?: string;
  /** Signed by the preparer at submit (`preparerSigns`), at the submit instant. */
  selfSigned?: boolean;
  /** Signed with the same approver's Approve on an earlier step, at that instant. */
  coSigned?: boolean;
  /** The role the step names (a ROLE step, or a SUPERVISOR step's fallback) — what `byHighestRole` compares with. */
  stepRoleId?: string | null;
}

/**
 * What a draft's route is previewed on: exactly what the document's own
 * submit passes to `submitForApproval` — the amount that picks the band, the
 * person the submit files it for, the option ticked ("Add the CEO as
 * approver"), and the project and manager a PROJECT_MANAGER step reads.
 */
export interface DraftRoute {
  amount: number | null;
  requesterId: string;
  optionId?: string | null;
  jobId?: string | null;
  projectManagerId?: string | null;
  /** An importation: a Purchasing Manager step previews as the Importation manager's. */
  importation?: boolean;
  /** The team the document is for (`ApprovalContext.teamId`). */
  teamId?: string | null;
}

/**
 * Every sign-off slot of a document, in step order — the ONE reading every
 * routed document's paper (and a page that says where Submit goes) takes.
 *
 * - **`draft` given** — the caller says the document is a draft now: never
 *   submitted, pulled back, returned, or reopened after its approval. Unless
 *   a request is still PENDING, the slots are the route a (re)submission
 *   WOULD take (`routePreview`, with the submit's own context), every step
 *   open under who may sign it; an option the document no longer qualifies
 *   for falls back to the standard route. Whatever its last request closed
 *   as — withdrawn, returned, or approved before a reopen — it is not this
 *   draft's approval, and its dated steps would sign for a version nobody
 *   now decides on.
 * - **An open request** (PENDING): each step signed and dated, or — still to
 *   act — no `name` and no time, so the paper says "Pending" rather than
 *   borrowing anybody's signature, with `assigned`: who may yet sign it.
 * - **A closed request** (APPROVED — every step signed — REJECTED, or
 *   CANCELLED): only the steps somebody signed, each dated. Nobody will ever
 *   sign the rest, the step that refused it included, and "Pending" there
 *   would not be the truth (rule 6).
 * - **No request** and no `draft`: none.
 *
 * A document's own rule about which request still stands behind it (a FINAL
 * costing reopened since — `approvalStands`; a cancelled job order) is the
 * caller's, applied before it asks.
 */
export async function approvalSlots(documentType: string, documentId: string, draft?: DraftRoute): Promise<ApprovalSlot[]> {
  const request = await prisma.approvalRequest.findFirst({
    where: { documentType, documentId },
    orderBy: { createdAt: 'desc' },
    include: {
      workflow: { select: { steps: { orderBy: { sequence: 'asc' } } } },
      actions: {
        where: { action: 'APPROVED' },
        include: {
          approver: { select: { name: true, position: true, email: true, phone: true, employee: { select: { mobile: true } } } },
        },
      },
    },
  });
  const open = request?.status === 'PENDING';
  if (draft && !open) {
    // An option the document no longer qualifies for falls back to the standard route.
    const ctx: ApprovalContext = { jobId: draft.jobId, projectManagerId: draft.projectManagerId, importation: draft.importation ?? false, teamId: draft.teamId ?? null };
    const route =
      (draft.optionId ? await routePreview(documentType, draft.amount, draft.requesterId, draft.optionId, ctx) : null) ??
      (await routePreview(documentType, draft.amount, draft.requesterId, null, ctx));
    return route ? route.steps.map((st) => ({ step: st.name, stepRoleId: st.roleId, assigned: st.approvers })) : [];
  }
  if (!request) return [];
  const bySeq = new Map(request.actions.map((a) => [a.sequence, a]));
  const slots = await Promise.all(
    (request.workflow?.steps ?? []).map(async (st): Promise<ApprovalSlot | null> => {
      const a = bySeq.get(st.sequence);
      if (a) {
        return {
          step: st.name,
          stepRoleId: st.roleId,
          userId: a.approverId,
          name: a.approver.name,
          position: a.approver.position ?? undefined,
          phone: contactPhone(a.approver),
          email: a.approver.email,
          at: a.actedAt,
          ...(a.selfSigned ? { selfSigned: true } : {}),
          ...(a.coSignedWith != null ? { coSigned: true } : {}),
        };
      }
      return open ? { step: st.name, stepRoleId: st.roleId, assigned: await namedApprovers(st, request.requesterId, prisma, ctxOf(request)) } : null;
    }),
  );
  return slots.filter((s): s is ApprovalSlot => s !== null);
}

/**
 * Whether a document's latest request is still its approval: that request
 * APPROVED it, and the document was not reopened after the decision — a row
 * on its own trail whose summary starts `reopened` ("Reopened costing",
 * "Reopened sales order"), which the reopen routes write. A costing returned
 * and then made final by a project built on the draft, or an order reopened
 * and issued again with no route active, would otherwise print the steps of
 * a decision that no longer stands — dated signatures, or a route nobody
 * will ever sign.
 */
export async function approvalStands(documentType: string, documentId: string, reopened: string): Promise<boolean> {
  const request = await prisma.approvalRequest.findFirst({
    where: { documentType, documentId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, closedAt: true },
  });
  if (request?.status !== 'APPROVED' || !request.closedAt) return false;
  const since = await prisma.auditLog.count({
    where: { entityType: documentType, entityId: documentId, at: { gt: request.closedAt }, summary: { startsWith: reopened } },
  });
  return since === 0;
}

/**
 * The number a document prints for a person: their login's own phone — the
 * one Admin › Users keeps for exactly this — else the mobile they keep on My
 * Account. Nothing, rather than an empty line, when neither is set.
 */
export function contactPhone(user: { phone?: string | null; employee?: { mobile?: string | null } | null }): string | undefined {
  return user.phone?.trim() || user.employee?.mobile?.trim() || undefined;
}

/** The contact lines a sign-off prints under a person's name. */
export interface Contact {
  phone?: string;
  email?: string;
}

const CONTACT_SELECT = { id: true, name: true, email: true, phone: true, employee: { select: { mobile: true } } } as const;

/**
 * How to reach a person, as a sign-off prints it under their name — read for
 * the PAPER only, never sent with a record (the quotation's rule: a record's
 * JSON carries no mobile). Nothing for nobody, or a login no longer on file.
 * Spread it into a `Signatory` beside the name the document already holds.
 */
export async function contactOf(userId: string | null | undefined): Promise<Contact> {
  if (!userId) return {};
  const user = await prisma.user.findUnique({ where: { id: userId }, select: CONTACT_SELECT });
  return user ? { phone: contactPhone(user), email: user.email } : {};
}

/**
 * `contactOf` for several people in one read, by login id, each with the name
 * on file — for a document that names people off its trail (whoever raised
 * it, whoever issued it), where the trail may hold only the id.
 */
export async function contactsOf(ids: (string | null | undefined)[]): Promise<Map<string, Contact & { name: string }>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  const users = wanted.length ? await prisma.user.findMany({ where: { id: { in: wanted } }, select: CONTACT_SELECT }) : [];
  return new Map(users.map((u) => [u.id, { name: u.name, phone: contactPhone(u), email: u.email }]));
}

/**
 * The step each document's OPEN request waits on, by document id — the
 * money-out registers' status words (2026-10-15, the owner's sample:
 * "TL Approval / Back Support / Checking / FM Approved / For Release /
 * Paid"). One query for a page of rows; a document with no open request is
 * absent from the map.
 */
export async function openSteps(documentType: string, documentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!documentIds.length) return out;
  const open = await prisma.approvalRequest.findMany({
    where: { documentType, documentId: { in: documentIds }, status: 'PENDING' },
    select: { documentId: true, currentSequence: true, workflow: { select: { steps: { select: { sequence: true, name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  for (const r of open) {
    if (out.has(r.documentId)) continue;
    const step = r.workflow?.steps.find((s) => s.sequence === r.currentSequence);
    if (step) out.set(r.documentId, step.name);
  }
  return out;
}

/**
 * A money-out document's stage in the owner's words: the open step's short
 * name while it is with an approver ("TL Approval", "Back Support",
 * "Checking", "FM Approval", "CEO Approval"), "For Release" once approved
 * and nothing paid, then the document's own status.
 */
export function stageWords(status: string, openStep: string | undefined, owed: boolean): string {
  if (status === 'PENDING_APPROVAL' && openStep) {
    // A document still on a retired route reads in the same words.
    if (/team leader|supervisor/i.test(openStep)) return 'TL Approval';
    if (/checking|finance staff|^finance approval/i.test(openStep)) return 'Checking';
    if (/finance manager/i.test(openStep)) return 'FM Approval';
    if (/ceo|president/i.test(openStep)) return 'CEO Approval';
    if (/back support/i.test(openStep)) return 'Back Support';
    if (/technical manager/i.test(openStep)) return 'TM Approval';
    return openStep;
  }
  if (status === 'APPROVED') return owed ? 'For Release' : 'Approved';
  if (status === 'REIMBURSED') return 'Paid';
  return status
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
