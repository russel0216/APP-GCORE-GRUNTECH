import { Prisma, type ApprovalRequest, type ApprovalStep } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, forbidden, notFound } from '../http/kit';
import { notify } from './notifications';
import { audit } from './audit';
import type { Signatory } from './pdf';

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
}

/** The context a stored request carries. */
export const ctxOf = (r: { jobId: string | null; projectManagerId?: string | null }): ApprovalContext => ({
  jobId: r.jobId,
  projectManagerId: r.projectManagerId ?? null,
});

/** The role a PROJECT_MANAGER step falls back to when it names none. */
export const PROJECT_MANAGER_FALLBACK_ROLE = 'executive';

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
 * request's), and falls back to the step's role — Executive unless the step
 * names another — when the project has no manager, the document names no
 * project, or the manager IS the requester (2026-10-07, the owner's call: a
 * PM's own request goes up to management, never to nobody).
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
          select: { userId: true },
        });
        return rows.map((r) => r.userId);
      }
      return usersInRole(PROJECT_MANAGER_FALLBACK_ROLE, tx);
    }

    case 'USER':
      return step.userId ? [step.userId] : [];

    case 'ROLE': {
      if (!step.roleId) return [];
      const rows = await tx.userRole.findMany({
        where: { roleId: step.roleId, user: { isActive: true } },
        select: { userId: true, role: { select: { key: true } } },
      });
      const holders = rows.map((r) => r.userId);
      if (!rows.length || !TEAM_SCOPED_ROLES.includes(rows[0].role.key)) return holders;
      return supportersFor(holders, requesterId, tx);
    }

    case 'SUPERVISOR': {
      const requester = await tx.user.findUnique({
        where: { id: requesterId },
        select: { supervisorId: true },
      });
      if (requester?.supervisorId) return [requester.supervisorId];
      if (step.roleId) {
        const rows = await tx.userRole.findMany({
          where: { roleId: step.roleId, user: { isActive: true } },
          select: { userId: true },
        });
        return leadersFor(rows.map((r) => r.userId), requesterId, tx);
      }
      return usersInRole('hr', tx);
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
 * The holders of a team-scoped role who decide for this requester: those
 * supporting the requester's team (`Employee.industryId`), else those who
 * name no team (they support every team), else every holder — a document
 * never stalls because nobody was set for its team. A requester with no team
 * goes to the holders who name none, else every holder.
 */
export async function supportersFor(holders: string[], requesterId: string, tx: Prisma.TransactionClient = prisma): Promise<string[]> {
  if (!holders.length) return holders;
  const [requester, links] = await Promise.all([
    tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } }),
    tx.userSupportTeam.findMany({ where: { userId: { in: holders } }, select: { userId: true, industryId: true } }),
  ]);
  const team = requester?.industryId ?? null;
  const onTeam = team ? holders.filter((h) => links.some((l) => l.userId === h && l.industryId === team)) : [];
  if (onTeam.length) return onTeam;
  const everyTeam = holders.filter((h) => !links.some((l) => l.userId === h));
  return everyTeam.length ? everyTeam : holders;
}

/**
 * The holders of a SUPERVISOR step's fallback role who decide for a requester
 * with no "Reports to": those on the requester's own team
 * (`Employee.industryId`) — the CEO on SIT goes to SIT's Team Leader, not to
 * every Team Leader (2026-10-12) — else every holder, so a document never
 * stalls because the team has no leader. The requester is never the reason a
 * team counts as led: a Team Leader alone on their team falls back to all.
 */
export async function leadersFor(holders: string[], requesterId: string, tx: Prisma.TransactionClient = prisma): Promise<string[]> {
  if (!holders.length) return holders;
  const requester = await tx.employee.findUnique({ where: { userId: requesterId }, select: { industryId: true } });
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
 * Whether the requester HOLDS a step — the role it names (a ROLE step's, or a
 * SUPERVISOR step's fallback: "Team Leader" on the quotation is the
 * `team_leader` role), or the person a USER step names. On a route that lets
 * the preparer sign (`ApprovalWorkflow.preparerSigns`) such a step is signed
 * at submit, dated the submit instant (the owner's call, 2026-10-12: a Team
 * Leader's own quotation, the CEO's own sales order, a Technical Manager's
 * own costing). A PROJECT_MANAGER or HR step is never held: a PM's own
 * request goes up (2026-10-07), and HR never signs its own filing.
 */
export async function holdsStep(step: ApprovalStep, requesterId: string, tx: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (step.approverType === 'USER') return step.userId === requesterId;
  if ((step.approverType === 'ROLE' || step.approverType === 'SUPERVISOR') && step.roleId) {
    return !!(await tx.userRole.findFirst({
      where: { userId: requesterId, roleId: step.roleId, user: { isActive: true } },
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
): Promise<Set<number>> {
  const held = new Set<number>();
  if (!workflow.preparerSigns) return held;
  for (const step of workflow.steps) if (await holdsStep(step, requesterId, tx)) held.add(step.sequence);
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
): Promise<{ workflowId: string; name: string; steps: { sequence: number; name: string; held: boolean; approvers: StepPerson[] }[] } | null> {
  const workflow = await pickWorkflow(documentType, amount, { option: optionId ?? null, requesterId });
  if (!workflow) return null;
  // A step the preparer holds on a route that lets them sign is THEIRS: it is
  // signed at submit, so it names them alone (`held`).
  const held = await heldSequences(workflow, requesterId);
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
          ? { sequence: st.sequence, name: st.name, held: true, approvers: selfPerson }
          : { sequence: st.sequence, name: st.name, held: false, approvers: await namedApprovers(st, requesterId, prisma, ctx) },
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
  const held = await heldSequences(workflow, input.requesterId);
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
    const firstApprovers = await approversForStep(firstStep, input.requesterId, prisma, {
      jobId: input.jobId,
      projectManagerId: input.projectManagerId,
    });
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
  const next = steps.slice(steps.findIndex((s) => s.sequence === step.sequence) + 1).find((s) => !signed.has(s.sequence));

  const settled = await prisma.$transaction(async (tx) => {
    // Claimed, never simply written: the request must still be open at this
    // step. One withdrawn (cancelOpenRequest) or decided by somebody else since
    // it was read above is refused here — written over, a withdrawn request
    // would come back decided, and two approvers on one step would both count.
    const claimed = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING', currentSequence: step.sequence },
      data:
        input.action !== 'APPROVED'
          ? { status: input.action === 'REJECTED' ? 'REJECTED' : 'CANCELLED', closedAt: new Date() }
          : next
            ? { currentSequence: next.sequence }
            : { status: 'APPROVED', closedAt: new Date() },
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
      },
    });
    return tx.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
  });

  await audit({
    entityType: request.documentType,
    entityId: request.documentId,
    action: input.action,
    summary: `${step.name} — ${actor?.name ?? 'unknown'}${stoodInFor ? ` (standing in for ${stoodInFor.name})` : ''}${input.comment ? `: ${input.comment}` : ''}`,
    actorId: input.userId,
  });

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

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Everything currently sitting in one user's approval queue — with who raised
 * it, because an approver deciding on subject and amount alone is deciding
 * blind.
 */
export async function pendingFor(
  userId: string,
): Promise<(ApprovalRequest & { requester: { name: string } })[]> {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    include: { workflow: { include: { steps: true } }, requester: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const mine: (ApprovalRequest & { requester: { name: string } })[] = [];
  for (const request of pending) {
    if (request.requesterId === userId) continue; // never your own
    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (!step) continue;
    const eligible = await approversForStep(step, request.requesterId, prisma, ctxOf(request));
    if (eligible.includes(userId)) mine.push(request);
  }
  return mine;
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
    },
    orderBy: { createdAt: 'desc' },
  });
  return Promise.all(
    rows.map(async (r) => {
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
  /** Signed by the preparer at submit (`preparerSigns`), at the submit instant. */
  selfSigned?: boolean;
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
    const ctx: ApprovalContext = { jobId: draft.jobId, projectManagerId: draft.projectManagerId };
    const route =
      (draft.optionId ? await routePreview(documentType, draft.amount, draft.requesterId, draft.optionId, ctx) : null) ??
      (await routePreview(documentType, draft.amount, draft.requesterId, null, ctx));
    return route ? route.steps.map((st) => ({ step: st.name, assigned: st.approvers })) : [];
  }
  if (!request) return [];
  const bySeq = new Map(request.actions.map((a) => [a.sequence, a]));
  const slots = await Promise.all(
    (request.workflow?.steps ?? []).map(async (st): Promise<ApprovalSlot | null> => {
      const a = bySeq.get(st.sequence);
      if (a) {
        return {
          step: st.name,
          name: a.approver.name,
          position: a.approver.position ?? undefined,
          phone: contactPhone(a.approver),
          email: a.approver.email,
          at: a.actedAt,
          ...(a.selfSigned ? { selfSigned: true } : {}),
        };
      }
      return open ? { step: st.name, assigned: await namedApprovers(st, request.requesterId, prisma, ctxOf(request)) } : null;
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
