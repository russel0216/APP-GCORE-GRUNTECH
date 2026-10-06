import { Prisma, type ApprovalRequest, type ApprovalStep } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, forbidden, notFound } from '../http/kit';
import { notify } from './notifications';
import { audit } from './audit';

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
export async function pickWorkflow(documentType: string, amount?: number | null, opts: { option?: string | null } = {}) {
  const candidates = await prisma.approvalWorkflow.findMany({
    where: { documentType, isActive: true },
    include: { steps: { orderBy: { sequence: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
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
    return candidates.find((w) => w.id === opts.option && w.optionLabel && inBand(w)) ?? null;
  }
  const matching = candidates.filter((w) => !w.optionLabel && inBand(w));
  // Prefer the most specific band (the narrowest one that still matches).
  matching.sort((a, b) => {
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
 * The set of user ids allowed to act on one step.
 *
 * SUPERVISOR falls back to HR when the requester has no supervisor set —
 * "Approvers are to whom they are directly reporting … otherwise HR will
 * approve". Without that fallback a new hire's first leave request would
 * silently route to nobody. A SUPERVISOR step that names a role (`roleId`)
 * falls back to that role instead: a quotation from a salesperson with no
 * "Reports to" goes to the sales managers, not to HR. HR stays the fallback
 * for every step that names none (leave, overtime, claims…).
 */
export async function approversForStep(
  step: ApprovalStep,
  requesterId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<string[]> {
  switch (step.approverType) {
    case 'USER':
      return step.userId ? [step.userId] : [];

    case 'ROLE': {
      if (!step.roleId) return [];
      const rows = await tx.userRole.findMany({
        where: { roleId: step.roleId, user: { isActive: true } },
        select: { userId: true },
      });
      return rows.map((r) => r.userId);
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
        return rows.map((r) => r.userId);
      }
      return usersInRole('hr', tx);
    }

    case 'HR':
      return usersInRole('hr', tx);

    default:
      return [];
  }
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
): Promise<StepPerson[]> {
  const ids = [...new Set(await approversForStep(step, requesterId, tx))].filter((id) => id !== requesterId);
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
): Promise<{ workflowId: string; name: string; steps: { sequence: number; name: string; approvers: StepPerson[] }[] } | null> {
  const workflow = await pickWorkflow(documentType, amount, { option: optionId ?? null });
  if (!workflow) return null;
  return {
    workflowId: workflow.id,
    name: workflow.name,
    steps: await Promise.all(
      workflow.steps.map(async (st) => ({ sequence: st.sequence, name: st.name, approvers: await namedApprovers(st, requesterId) })),
    ),
  };
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

  const workflow = await pickWorkflow(input.documentType, input.amount, { option: input.optionId });
  if (input.optionId && !workflow) {
    throw badRequest('That approval option does not apply to this document — the amount is outside its band, or it was switched off');
  }
  if (!workflow || workflow.steps.length === 0) {
    throw badRequest(
      `No approval workflow is configured for "${input.documentType}". Set one up in Admin › Approval Workflows.`,
    );
  }

  // A step whose only eligible approver is the requester can never be acted on:
  // segregation of duties refuses self-approval, so the document would sit
  // pending forever with no error anywhere. This is the subtler cousin of "no
  // one holds this role" — there IS an approver set, it just contains only the
  // person who raised it. Caught here, at submission, while it can still be
  // fixed by changing the workflow rather than by wondering why nothing moved.
  const firstStep = workflow.steps[0];
  const firstApprovers = await approversForStep(firstStep, input.requesterId);
  if (firstApprovers.length && firstApprovers.every((id) => id === input.requesterId)) {
    throw badRequest(
      `"${workflow.name}" routes step 1 ("${firstStep.name}") only to you, and nobody may approve a document they raised. ` +
        `Add another approver to that step in Admin › Approval Workflows.`,
    );
  }
  if (!firstApprovers.length) {
    throw badRequest(
      `"${workflow.name}" routes step 1 ("${firstStep.name}") to nobody. ` +
        `Check that someone holds that role in Admin › Approval Workflows.`,
    );
  }

  const request = await prisma.approvalRequest.create({
    data: {
      documentType: input.documentType,
      documentId: input.documentId,
      documentNumber: input.documentNumber ?? null,
      subject: input.subject,
      amount: input.amount != null ? new Prisma.Decimal(input.amount) : null,
      link: input.link ?? null,
      requesterId: input.requesterId,
      workflowId: workflow.id,
      currentSequence: workflow.steps[0].sequence,
      status: 'PENDING',
    },
  });

  await audit({
    entityType: input.documentType,
    entityId: input.documentId,
    action: 'SUBMITTED',
    summary: `Submitted for approval — ${workflow.name}`,
    actorId: input.requesterId,
  });

  await notifyCurrentStep(request);
  return request;
}

async function notifyCurrentStep(request: ApprovalRequest): Promise<void> {
  if (!request.workflowId) return;
  const step = await prisma.approvalStep.findFirst({
    where: { workflowId: request.workflowId, sequence: request.currentSequence },
  });
  if (!step) return;

  const approverIds = await approversForStep(step, request.requesterId);
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

  const eligible = await approversForStep(step, request.requesterId);
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { isSuperAdmin: true, name: true },
  });

  if (!eligible.includes(input.userId) && !actor?.isSuperAdmin) {
    throw forbidden('This approval is not yours to act on');
  }

  const steps = request.workflow!.steps;
  const next = steps[steps.findIndex((s) => s.sequence === step.sequence) + 1];

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
    summary: `${step.name} — ${actor?.name ?? 'unknown'}${input.comment ? `: ${input.comment}` : ''}`,
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
    const told = new Set([...(step ? await approversForStep(step, request.requesterId, tx) : []), request.requesterId]);
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
    const eligible = await approversForStep(step, request.requesterId);
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
        include: { approver: { select: { id: true, name: true } } },
        orderBy: { actedAt: 'asc' },
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
            : { ...st, approvers: (await namedApprovers(st, r.requesterId)).map((p) => ({ id: p.id, name: p.name })) },
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
}

/**
 * Every sign-off slot of a document's latest approval request, in step order:
 * each step's name, and — once that step has approved — who and when. A step
 * still to act has no `name` and no time, so a printed document says
 * "Pending" there rather than borrowing anybody's signature; while the
 * request is open it carries `assigned`, who may yet sign it.
 *
 * Before submission there is no request. Given `draft`, the slots are the
 * route the document WOULD take (`routePreview`), each step `assigned`; without
 * it, none.
 */
export async function approvalSlots(
  documentType: string,
  documentId: string,
  draft?: { amount: number | null; requesterId: string; optionId?: string | null },
): Promise<ApprovalSlot[]> {
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
  if (!request) {
    if (!draft) return [];
    // An option the document no longer qualifies for falls back to the standard route.
    const route =
      (draft.optionId ? await routePreview(documentType, draft.amount, draft.requesterId, draft.optionId) : null) ??
      (await routePreview(documentType, draft.amount, draft.requesterId));
    return route ? route.steps.map((st) => ({ step: st.name, assigned: st.approvers })) : [];
  }
  const bySeq = new Map(request.actions.map((a) => [a.sequence, a]));
  const steps = request.workflow?.steps ?? [];
  const open = request.status === 'PENDING';
  return Promise.all(
    steps.map(async (st): Promise<ApprovalSlot> => {
      const a = bySeq.get(st.sequence);
      if (a) {
        return {
          step: st.name,
          name: a.approver.name,
          position: a.approver.position ?? undefined,
          phone: contactPhone(a.approver),
          email: a.approver.email,
          at: a.actedAt,
        };
      }
      return open ? { step: st.name, assigned: await namedApprovers(st, request.requesterId) } : { step: st.name };
    }),
  );
}

/**
 * The number a document prints for a person: their login's own phone — the
 * one Admin › Users keeps for exactly this — else the mobile they keep on My
 * Account. Nothing, rather than an empty line, when neither is set.
 */
export function contactPhone(user: { phone?: string | null; employee?: { mobile?: string | null } | null }): string | undefined {
  return user.phone?.trim() || user.employee?.mobile?.trim() || undefined;
}
