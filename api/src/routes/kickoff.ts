import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, notFound, badRequest, forbidden } from '../http/kit';
import { authenticate, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import {
  approvalSlots,
  cancelOpenRequest,
  mayDecide,
  onApprovalReopened,
  onApprovalSettled,
  preparedAt,
  routeBrief,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import { renderSchedule, formatDate, formatDateTime, type PdfScheduleGroup } from '../shared/pdf';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { dayKey, workingDaysBetween } from '../shared/day';
import { CUSTOMER_DECISIONS, CUSTOMER_DECISION_LABEL } from './planApprovals';

/**
 * THE KICK-OFF GANTT CHART (2026-10-22, the owner's call, with his WESCO UPS
 * chart as the sample: "I want this as standard template when printing the
 * Gantt chart … Prepared By (Project Engineer), Checked By (Technical
 * Manager), Approved By (Customer). This will be used on customer kick-off
 * meeting approval").
 *
 * The chart is the project's Scope of Work tab on A3 (`renderSchedule`): the
 * phases and tasks on WORKING days from the project's Start Date (Day 1),
 * the Target Date as the planned finish, milestones (tasks ticked
 * "Milestone") as dashed lines with their notes. Its own state lives on the
 * project (`Job.schedule*`): DRAFT → PENDING_APPROVAL → APPROVED through the
 * one engine as `gantt_chart`, the job's id the document — submitted in the
 * Project Engineer's name, checked by the project's Technical Manager — then
 * the customer's answer recorded at the kick-off meeting, the record being
 * the signature (the Request for Approval's rule). Pulling it back to draft
 * clears the customer's answer: what they approved has changed.
 */

export const kickoffRoutes = Router();
kickoffRoutes.use(authenticate);

const DOC = 'gantt_chart';
const VIEW = ['gops.projects.view_all', 'gops.projects.view_own'];
const LINK = (jobId: string) => `/g-ops/projects/${jobId}?tab=scope`;
const decisionLabel = (d: string | null) => (d ? (CUSTOMER_DECISION_LABEL[d as keyof typeof CUSTOMER_DECISION_LABEL] ?? d) : null);

const jobInclude = {
  customer: { select: { name: true } },
  site: { select: { name: true, address: true, city: true } },
  projectManager: { select: { id: true, name: true } },
  projectEngineer: { select: { id: true, name: true } },
  scopeItems: { orderBy: { sortOrder: 'asc' as const } },
  tasks: { orderBy: [{ startDate: 'asc' as const }, { sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
} satisfies Prisma.JobInclude;
type KickoffJob = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

async function loadJob(me: ResolvedUser, id: string, deciderOnly: boolean): Promise<KickoffJob> {
  const job = await prisma.job.findUnique({ where: { id }, include: jobInclude });
  // A holder of a projects view key reads any project's page (GET /jobs/:id);
  // anyone else only while the chart waits on them.
  if (!job || (deciderOnly && !(await mayDecide(me.id, DOC, [job.id])))) throw notFound('Project not found');
  return job;
}

/** The project's engineer, its Technical Manager, or whoever may edit every project. */
const mayPrepare = (me: ResolvedUser, job: { projectEngineerId: string | null; projectManagerId: string | null }) =>
  me.isSuperAdmin || job.projectEngineerId === me.id || job.projectManagerId === me.id || can(me, 'gops.projects.edit_all');

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The chart as `renderSchedule` draws it, on working days from the start —
 * and, when it cannot be drawn or sent, what is missing, in words.
 */
export function kickoffChart(job: KickoffJob) {
  const problems: string[] = [];
  if (!job.projectEngineerId) problems.push('Name the Project Engineer on the project — they prepare the chart');
  if (!job.startDate) problems.push('Set the project’s Start Date — it is Day 1 of the chart');
  if (!job.targetEndDate) problems.push('Set the project’s Target Date — it is the planned finish');
  if (job.startDate && job.targetEndDate && job.targetEndDate < job.startDate) problems.push('The Target Date is before the Start Date');
  const start = job.startDate;
  const dayOf = (d: Date) => Math.max(1, workingDaysBetween(start!, d));
  const span = (from: Date | null, to: Date | null) => {
    if (!start || (!from && !to)) return null;
    const a = dayOf(from ?? to!);
    const b = Math.max(a, dayOf(to ?? from!));
    return { start: a, days: b - a + 1 };
  };
  let undated = 0;
  const taskBars = (tasks: KickoffJob['tasks']) =>
    tasks.flatMap((t) => {
      const s = span(t.startDate, t.dueDate);
      if (!s) {
        undated++;
        return [];
      }
      return [{ name: t.name, start: s.start, days: t.isMilestone ? 1 : s.days, milestone: t.isMilestone }];
    });
  const groups: PdfScheduleGroup[] = job.scopeItems.map((item) => {
    const own = span(item.plannedStart, item.plannedEnd);
    return { name: item.name, ...(own ? { start: own.start, days: own.days } : {}), tasks: taskBars(job.tasks.filter((t) => t.scopeItemId === item.id)) };
  });
  const loose = job.tasks.filter((t) => !t.scopeItemId || !job.scopeItems.some((s) => s.id === t.scopeItemId));
  if (loose.length) groups.push({ name: 'Other tasks', tasks: taskBars(loose) });
  const planned = groups.filter((g) => g.start || g.tasks.length);
  if (start && !planned.length) problems.push('Plan the phases and tasks on the Scope of Work tab first');
  const milestones = start
    ? job.tasks.filter((t) => t.isMilestone && (t.startDate || t.dueDate)).map((t) => ({ day: dayOf(t.startDate ?? t.dueDate!), note: t.name }))
    : [];
  const finishDay = start && job.targetEndDate && job.targetEndDate >= start ? workingDaysBetween(start, job.targetEndDate) : null;
  return {
    groups: groups.filter((g) => g.start || g.tasks.length || job.scopeItems.length),
    milestones,
    finishDay,
    undated,
    phases: job.scopeItems.length,
    tasks: job.tasks.length - undated,
    problems,
  };
}

async function present(me: ResolvedUser, job: KickoffJob) {
  const chart = kickoffChart(job);
  const preparer = mayPrepare(me, job);
  const draft = job.scheduleStatus === 'DRAFT';
  const recorder = job.scheduleCustomerRecordedById
    ? await prisma.user.findUnique({ where: { id: job.scheduleCustomerRecordedById }, select: { id: true, name: true } })
    : null;
  return {
    jobId: job.id,
    number: job.number,
    status: job.scheduleStatus,
    submittedAt: job.scheduleSubmittedAt,
    approvedAt: job.scheduleApprovedAt,
    engineer: job.projectEngineer,
    technicalManager: job.projectManager,
    startDate: job.startDate,
    targetEndDate: job.targetEndDate,
    finishDay: chart.finishDay,
    phases: chart.phases,
    tasks: chart.tasks,
    undatedTasks: chart.undated,
    milestones: chart.milestones.length,
    problems: chart.problems,
    canSubmit: draft && preparer && !chart.problems.length,
    canWithdraw: job.scheduleStatus === 'PENDING_APPROVAL' && preparer,
    canRecordCustomer: job.scheduleStatus === 'APPROVED' && preparer,
    // Where Submit sends it, by name — in the engineer's name, as the submit files it.
    approvalRoute: draft && job.projectEngineerId ? await routeBrief(DOC, null, job.projectEngineerId, null, { jobId: job.id }) : null,
    customer: {
      decision: job.scheduleCustomerDecision,
      decisionLabel: decisionLabel(job.scheduleCustomerDecision),
      name: job.scheduleCustomerName,
      position: job.scheduleCustomerPosition,
      decidedOn: job.scheduleCustomerDecidedOn,
      remarks: job.scheduleCustomerRemarks,
      recordedAt: job.scheduleCustomerRecordedAt,
      recordedBy: recorder,
    },
  };
}

kickoffRoutes.get(
  '/:id/kickoff',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await present(me, await loadJob(me, req.params.id, res.locals.deciderOnly === true)));
  }),
);

/**
 * Submitting: claimed on DRAFT, the request filed in the Project Engineer's
 * name whoever presses the button, back to DRAFT if the engine refuses.
 */
kickoffRoutes.post(
  '/:id/kickoff/submit',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const job = await loadJob(me, req.params.id, false);
    if (!mayPrepare(me, job)) throw forbidden('Only the project’s engineer or Technical Manager sends its Gantt chart for checking');
    if (job.scheduleStatus !== 'DRAFT') throw badRequest('The Gantt chart has already been sent');
    const { problems } = kickoffChart(job);
    if (problems.length) throw badRequest(problems[0]);
    const claimed = await prisma.job.updateMany({ where: { id: job.id, scheduleStatus: 'DRAFT' }, data: { scheduleStatus: 'PENDING_APPROVAL', scheduleSubmittedAt: new Date() } });
    if (!claimed.count) throw badRequest('It was sent a moment ago — reload');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: job.id,
        documentNumber: job.number,
        subject: `${job.number} — ${job.name}: kick-off Gantt chart`,
        link: LINK(job.id),
        requesterId: job.projectEngineerId!,
        jobId: job.id,
      });
    } catch (err) {
      await prisma.job.updateMany({ where: { id: job.id, scheduleStatus: 'PENDING_APPROVAL' }, data: { scheduleStatus: 'DRAFT', scheduleSubmittedAt: null } });
      throw err;
    }
    await audit({ entityType: 'job', entityId: job.id, action: 'SUBMITTED', summary: `${job.number}: kick-off Gantt chart sent for checking` }, req);
    res.json(await present(me, await loadJob(me, job.id, false)));
  }),
);

/** Pulled back to DRAFT before the Technical Manager decides — the request withdrawn in the same transaction. */
kickoffRoutes.post(
  '/:id/kickoff/withdraw',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const job = await loadJob(me, req.params.id, false);
    if (!mayPrepare(me, job)) throw forbidden('Only the project’s engineer or Technical Manager pulls its Gantt chart back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.job.updateMany({ where: { id: job.id, scheduleStatus: 'PENDING_APPROVAL' }, data: { scheduleStatus: 'DRAFT', scheduleSubmittedAt: null } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, job.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'job', entityId: job.id, action: 'UPDATED', summary: `${job.number}: kick-off Gantt chart pulled back to draft` }, req);
    res.json(await present(me, await loadJob(me, job.id, false)));
  }),
);

/**
 * The customer's approval at the kick-off meeting, once the Technical
 * Manager has checked the chart: the decision, who decided, their position,
 * the day and their remarks — recorded again if they change it, cleared with
 * `decision: null`. The record, stamped with who entered it, is the proof.
 */
kickoffRoutes.post(
  '/:id/kickoff/customer',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        decision: z.enum(CUSTOMER_DECISIONS).nullable(),
        name: z.string().trim().max(200).optional().nullable(),
        position: z.string().trim().max(200).optional().nullable(),
        decidedOn: z.string().optional().nullable(),
        remarks: z.string().trim().max(4000).optional().nullable(),
      }),
      req.body ?? {},
    );
    const job = await loadJob(me, req.params.id, false);
    if (!mayPrepare(me, job)) throw forbidden('Only the project’s engineer or Technical Manager records the customer’s answer');
    if (job.scheduleStatus !== 'APPROVED') throw badRequest('The customer’s answer is recorded once the Technical Manager has checked the chart');
    let decidedOn: Date | null = null;
    if (body.decision) {
      if (!body.name?.trim()) throw badRequest('Say who at the customer decided');
      decidedOn = body.decidedOn ? new Date(body.decidedOn) : dayKey(new Date());
      if (Number.isNaN(decidedOn.getTime())) throw badRequest('The day decided is not a valid date');
      decidedOn = dayKey(decidedOn);
      if (decidedOn > dayKey(new Date())) throw badRequest('The customer cannot have decided on a day still to come');
      if (body.decision === 'REVISE' && !body.remarks?.trim()) throw badRequest('Say what the customer asked to revise');
    }
    const data = body.decision
      ? {
          scheduleCustomerDecision: body.decision,
          scheduleCustomerName: body.name!.trim(),
          scheduleCustomerPosition: body.position?.trim() || null,
          scheduleCustomerDecidedOn: decidedOn,
          scheduleCustomerRemarks: body.remarks?.trim() || null,
          scheduleCustomerRecordedAt: new Date(),
          scheduleCustomerRecordedById: me.id,
        }
      : CLEARED_CUSTOMER;
    const claimed = await prisma.job.updateMany({ where: { id: job.id, scheduleStatus: 'APPROVED' }, data });
    if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
    await audit(
      {
        entityType: 'job',
        entityId: job.id,
        action: 'UPDATED',
        summary: body.decision
          ? `${job.number}: customer's answer on the kick-off Gantt chart — ${decisionLabel(body.decision)} by ${body.name!.trim()}`
          : `${job.number}: customer's answer on the kick-off Gantt chart cleared`,
        before: job.scheduleCustomerDecision ? { decision: job.scheduleCustomerDecision, name: job.scheduleCustomerName } : null,
        after: body.decision ? { decision: body.decision, name: body.name!.trim(), decidedOn } : null,
      },
      req,
    );
    res.json(await present(me, await loadJob(me, job.id, false)));
  }),
);

const CLEARED_CUSTOMER = {
  scheduleCustomerDecision: null,
  scheduleCustomerName: null,
  scheduleCustomerPosition: null,
  scheduleCustomerDecidedOn: null,
  scheduleCustomerRemarks: null,
  scheduleCustomerRecordedAt: null,
  scheduleCustomerRecordedById: null,
};

// ── Settle and reopen ────────────────────────────────────────────────────────

/** Applied only while still PENDING_APPROVAL; a decision after a pull-back changes nothing and says so. Exported for the verify script. */
export async function settleKickoff(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const job = await prisma.job.findUnique({ where: { id: approval.documentId }, select: { id: true, number: true, scheduleStatus: true } });
  if (!job) return;
  const claimed = await prisma.job.updateMany({
    where: { id: job.id, scheduleStatus: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { scheduleStatus: 'APPROVED', scheduleApprovedAt: new Date() } : { scheduleStatus: 'DRAFT' },
  });
  await audit({
    entityType: 'job',
    entityId: job.id,
    action: outcome,
    summary: !claimed.count
      ? `${job.number}: kick-off Gantt chart ${outcome.toLowerCase()} after it was pulled back — not applied`
      : outcome === 'APPROVED'
        ? `${job.number}: kick-off Gantt chart checked by the Technical Manager — ready for the customer`
        : `${job.number}: kick-off Gantt chart returned to draft`,
  });
}
onApprovalSettled(DOC, settleKickoff);

onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const job = await prisma.job.findUnique({ where: { id }, select: { projectEngineerId: true, projectManagerId: true } });
    return !!job && mayPrepare(actor, job);
  },
  reopen: async ({ documentId, tx }) => {
    // The customer answered what was checked; changed, it goes to them again.
    const claimed = await tx.job.updateMany({
      where: { id: documentId, scheduleStatus: 'APPROVED' },
      data: { scheduleStatus: 'DRAFT', scheduleSubmittedAt: null, scheduleApprovedAt: null, ...CLEARED_CUSTOMER },
    });
    if (!claimed.count) throw badRequest('The Gantt chart changed a moment ago — reload to see where it stands');
  },
});

// ── The paper ────────────────────────────────────────────────────────────────

kickoffRoutes.get(
  '/:id/kickoff/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const job = await loadJob(me, req.params.id, res.locals.deciderOnly === true);
    if (!job.startDate) throw badRequest('Set the project’s Start Date first — it is Day 1 of the chart');
    const chart = kickoffChart(job);
    const draft = job.scheduleStatus === 'DRAFT';
    const slots = draft
      ? job.projectEngineerId
        ? await approvalSlots(DOC, job.id, { amount: null, requesterId: job.projectEngineerId, jobId: job.id })
        : []
      : await approvalSlots(DOC, job.id);
    const checked = slots[0];
    const pending = 'Pending';
    const site = [job.site?.name, job.site?.address, job.site?.city].filter((v) => v?.trim()).join(', ');
    const customerSigned = job.scheduleCustomerDecision && job.scheduleCustomerName;
    const notes = [
      `Working days run Monday to Saturday; Sundays and the holidays on Company Settings are not counted. Day 1 is the project's Start Date, ${formatDate(job.startDate)}${
        job.targetEndDate && chart.finishDay ? `; the planned finish is its Target Date, ${formatDate(job.targetEndDate)} (Day ${chart.finishDay})` : ''
      }.`,
      chart.undated ? `${chart.undated} task${chart.undated === 1 ? ' has' : 's have'} no dates yet and ${chart.undated === 1 ? 'is' : 'are'} not on the chart.` : '',
      job.scheduleCustomerRemarks && customerSigned ? `Customer's remarks: ${job.scheduleCustomerRemarks}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const pdf = await renderSchedule({
      title: 'Scope of Work - Gantt Chart',
      documentNumber: job.number,
      projectName: job.name,
      projectLine: [job.customer.name, site].filter(Boolean).join(' — '),
      startDate: dateKey(job.startDate),
      finishDay: chart.finishDay ?? undefined,
      groups: chart.groups,
      milestones: chart.milestones,
      notes,
      signoffNote: 'The name, date and time are considered a digital signature of approval.',
      band: [
        { label: 'Project', value: job.name, sub: `${job.number} · ${job.customer.name}`, wide: true },
        { label: 'Planned start date (Day 1)', value: formatDate(job.startDate) },
        {
          label: `Planned finish date${chart.finishDay ? ` (Day ${chart.finishDay})` : ''}`,
          value: job.targetEndDate ? formatDate(job.targetEndDate) : '—',
        },
        {
          label: 'Prepared by (Project Engineer)',
          value: job.projectEngineer?.name ?? '',
          sub: draft ? pending : formatDateTime(preparedAt(slots) ?? job.scheduleSubmittedAt ?? job.updatedAt),
        },
        {
          label: 'Checked by (Technical Manager)',
          value: checked?.name ?? checked?.assigned?.map((p) => p.name).join(' or ') ?? job.projectManager?.name ?? '',
          sub: checked?.name && checked.at ? formatDateTime(checked.at) : pending,
        },
        {
          label: 'Approved by (Customer)',
          value: customerSigned ? [job.scheduleCustomerName, job.scheduleCustomerPosition].filter(Boolean).join(', ') : '',
          sub: customerSigned
            ? `${decisionLabel(job.scheduleCustomerDecision)}${job.scheduleCustomerDecidedOn ? `, ${formatDate(job.scheduleCustomerDecidedOn)}` : ''}`
            : pending,
        },
      ],
    });
    await audit({ entityType: 'job', entityId: job.id, action: 'EXPORTED', summary: `Printed the kick-off Gantt chart of ${job.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(paperFileName({ kind: 'Gantt Chart', number: job.number, author: job.projectEngineer?.name ?? me.name, date: job.scheduleSubmittedAt ?? new Date() })),
    );
    res.send(pdf);
  }),
);
