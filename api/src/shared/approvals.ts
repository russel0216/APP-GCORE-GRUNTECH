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
  for (const fn of listeners.get(req.documentType) ?? []) {
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
export async function pickWorkflow(documentType: string, amount?: number | null) {
  const candidates = await prisma.approvalWorkflow.findMany({
    where: { documentType, isActive: true },
    include: { steps: { orderBy: { sequence: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  const value = amount ?? 0;
  const matching = candidates.filter((w) => {
    const min = w.minAmount ? Number(w.minAmount) : null;
    const max = w.maxAmount ? Number(w.maxAmount) : null;
    if (min !== null && value < min) return false;
    if (max !== null && value > max) return false;
    return true;
  });
  // Prefer the most specific band (the narrowest one that still matches).
  matching.sort((a, b) => {
    const span = (w: typeof a) =>
      (w.maxAmount ? Number(w.maxAmount) : Number.MAX_SAFE_INTEGER) -
      (w.minAmount ? Number(w.minAmount) : 0);
    return span(a) - span(b);
  });
  return matching[0] ?? null;
}

// ── Resolving who may act on a step ──────────────────────────────────────────

/**
 * The set of user ids allowed to act on one step.
 *
 * SUPERVISOR falls back to HR when the requester has no supervisor set —
 * "Approvers are to whom they are directly reporting … otherwise HR will
 * approve". Without that fallback a new hire's first leave request would
 * silently route to nobody.
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
      return usersInRole('hr', tx);
    }

    case 'HR':
      return usersInRole('hr', tx);

    default:
      return [];
  }
}

async function usersInRole(roleKey: string, tx: Prisma.TransactionClient): Promise<string[]> {
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

  const workflow = await pickWorkflow(input.documentType, input.amount);
  if (!workflow || workflow.steps.length === 0) {
    throw badRequest(
      `No approval workflow is configured for "${input.documentType}". Set one up in Admin › Approval Workflows.`,
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

  const settled = await prisma.$transaction(async (tx) => {
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

    if (input.action !== 'APPROVED') {
      return tx.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: input.action === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
          closedAt: new Date(),
        },
      });
    }

    const steps = request.workflow!.steps;
    const index = steps.findIndex((s) => s.sequence === step.sequence);
    const next = steps[index + 1];

    if (next) {
      return tx.approvalRequest.update({
        where: { id: request.id },
        data: { currentSequence: next.sequence },
      });
    }

    return tx.approvalRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', closedAt: new Date() },
    });
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

// ── Reading ──────────────────────────────────────────────────────────────────

/** Everything currently sitting in one user's approval queue. */
export async function pendingFor(userId: string): Promise<ApprovalRequest[]> {
  const pending = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    include: { workflow: { include: { steps: true } }, requester: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const mine: ApprovalRequest[] = [];
  for (const request of pending) {
    if (request.requesterId === userId) continue; // never your own
    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (!step) continue;
    const eligible = await approversForStep(step, request.requesterId);
    if (eligible.includes(userId)) mine.push(request);
  }
  return mine;
}

/** The full decision history of one document, for its Activity tab. */
export async function historyFor(documentType: string, documentId: string) {
  return prisma.approvalRequest.findMany({
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
}
