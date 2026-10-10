import { Router } from 'express';
import { z } from 'zod';
import { Prisma, EvaluationStatus, EvaluationKind, EvaluationRecommendation } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  idsFilter,
  notFound,
  badRequest,
  forbidden,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { registerAttachmentGuard } from '../shared/attachments';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  pickWorkflow,
  approversForStep,
  approvalSlots,
  slotSignatories,
  historyFor,
  contactOf,
  usersInRole,
  cancelOpenRequest,
} from '../shared/approvals';
import { renderDocument, formatDate, formatDateTime, formatShortDate, statusLabel, type PdfSection, type Signatory } from '../shared/pdf';
import { hrSettings } from '../shared/hr';
import { addMonths } from '../shared/aftermarket';
import { manilaDate } from '../shared/day';
import {
  allowedRecommendations,
  dueEvaluations,
  evaluationCriteria,
  evaluationMilestones,
  evaluationScore,
  kindFor,
  milestoneLabel,
  milestonesFor,
  periodAnchor,
  probationEnd,
  snapshotLines,
  visibleTo,
  RECOMMENDATION_LABEL,
} from '../shared/evaluations';
import { LIST_CAP, listReference, choice, sendListPdf } from '../shared/listPaper';

/**
 * Employee evaluations — probation and trainee reviews (model §4.7).
 *
 * The supervisor writes and submits; HR reviews; management approves; the
 * person evaluated reads it once approved and acknowledges it. Approval is
 * what changes the employee record — REGULARIZE, EXTEND, ABSORB — through the
 * settled-approval subscriber at the bottom of this file and nowhere else.
 *
 * What is deliberately NOT here: a `/criteria` route (criteria are an HR
 * Settings list, `hr.evaluationCriteria`), a search provider (a rating is not
 * something the command palette should surface), and any before/after in the
 * audit trail (the summary says a rating changed; it never says from what).
 */

export const evaluationRoutes = Router();

// The attached form or memo is read by exactly who may read the evaluation.
registerAttachmentGuard('evaluation', async (user, id) => {
  const ev = await prisma.employeeEvaluation.findUnique({
    where: { id },
    select: { status: true, evaluatorId: true, scheduledById: true, employee: { select: { userId: true } } },
  });
  return !!ev && visibleTo(user, ev);
});
evaluationRoutes.use(authenticate);

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

function asDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const date = new Date(v);
  if (Number.isNaN(date.getTime())) throw badRequest(`"${v}" is not a valid date`);
  return date;
}

const OPEN: EvaluationStatus[] = ['SCHEDULED', 'DRAFT', 'PENDING_APPROVAL'];

const employeeSelect = {
  id: true,
  employeeNo: true,
  firstName: true,
  lastName: true,
  position: true,
  employmentType: true,
  dateHired: true,
  dateRegularized: true,
  periodEndDate: true,
  userId: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

const personSelect = { id: true, name: true, position: true } satisfies Prisma.UserSelect;

const fullInclude = {
  employee: { select: employeeSelect },
  evaluator: { select: personSelect },
  scheduledBy: { select: personSelect },
  lines: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.EmployeeEvaluationInclude;

type Full = Prisma.EmployeeEvaluationGetPayload<{ include: typeof fullInclude }>;

/** Decimals become numbers at the boundary; the subject's login id never leaves. */
function present(ev: Full) {
  const { employee, lines, ...rest } = ev;
  const { userId, ...safeEmployee } = employee;
  return {
    ...rest,
    score: num(ev.score),
    employee: { ...safeEmployee, hasUser: userId !== null },
    lines: lines.map((l) => ({ ...l, weight: Number(l.weight) })),
    milestoneLabel: milestoneLabel(ev.milestone),
    allowedRecommendations: allowedRecommendations(ev.kind),
  };
}

async function loadFull(id: string) {
  const ev = await prisma.employeeEvaluation.findUnique({ where: { id }, include: fullInclude });
  if (!ev) throw notFound('Evaluation not found');
  return ev;
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

// ── Due, derived on read ─────────────────────────────────────────────────────

/**
 * Who is due an evaluation, and how soon. Nothing is stored: this is the
 * milestone arithmetic run against the employee records every time it is
 * asked. Reading it also tells HR — once per milestone, deduplicated on the
 * notification's link — so an evaluation that nobody schedules is at least
 * an evaluation somebody was told about.
 */
evaluationRoutes.get(
  '/due',
  require_('ghr.evaluations.view_all'),
  handler(async (req, res) => {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId : undefined;
    const rows = await dueEvaluations({ employeeId, includeCovered: req.query.all === '1' });

    // Only the uncovered ones want a nudge; a milestone with an evaluation
    // already open is on somebody's desk.
    const uncovered = rows.filter((r) => !r.evaluation);
    if (uncovered.length && !employeeId) {
      const hrUsers = await usersInRole('hr');
      if (hrUsers.length) {
        const links = uncovered.map(
          (r) => `/g-hr/evaluations?employeeId=${r.employee.id}&milestone=${r.milestone}&due=${r.dueDate.toISOString().slice(0, 10)}`,
        );
        const already = await prisma.notification.findMany({
          where: { type: 'evaluation.due', userId: { in: hrUsers }, link: { in: links } },
          select: { userId: true, link: true },
        });
        const seen = new Set(already.map((n) => `${n.userId}|${n.link}`));
        const fresh = [];
        for (const [i, r] of uncovered.entries()) {
          for (const userId of hrUsers) {
            if (seen.has(`${userId}|${links[i]}`)) continue;
            fresh.push({
              userId,
              type: 'evaluation.due' as const,
              title: `${fullName(r.employee)} — ${milestoneLabel(r.milestone)} evaluation ${r.overdue ? 'overdue' : 'due'}`,
              body: `Due ${formatDate(r.dueDate)}${r.overdue ? `, ${-r.daysLeft} day(s) ago` : ''}`,
              link: links[i],
            });
          }
        }
        if (fresh.length) await notify(fresh);
      }
    }

    res.json({
      asOf: new Date(),
      due: rows.length,
      overdue: rows.filter((r) => r.overdue).length,
      uncovered: uncovered.length,
      rows: rows.map((r) => ({ ...r, milestoneLabel: milestoneLabel(r.milestone) })),
    });
  }),
);

/** The whole milestone picture for one employee — the record's Evaluations tab. */
evaluationRoutes.get(
  '/milestones/:employeeId',
  require_('ghr.evaluations.view_all'),
  handler(async (req, res) => {
    const picture = await milestonesFor(req.params.employeeId);
    if (!picture) throw notFound('Employee not found');
    res.json(picture);
  }),
);

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * The evaluation list's where-builder — the screen's rows and the printed
 * list read the same set. "Mine" is two things: the ones I am writing, and
 * the ones written about me — the latter only once approved, the same rule
 * as the record (`visibleTo`). `?ids=` narrows to the rows ticked, ANDed
 * with that rule, so naming an id never prints an evaluation the caller
 * could not open.
 */
function evaluationListWhere(me: ReturnType<typeof currentUser>, q: ListQuery): Prisma.EmployeeEvaluationWhereInput {
  const and: Prisma.EmployeeEvaluationWhereInput[] = [];
  const onlyOwn = !can(me, 'ghr.evaluations.view_all');
  if (onlyOwn || q.scope === 'mine') {
    and.push({
      OR: [{ evaluatorId: me.id }, { scheduledById: me.id }, { employee: { userId: me.id }, status: 'APPROVED' }],
    });
  }
  const f = q.filters;
  const status = choice(f.status, EvaluationStatus, 'Status');
  if (status) and.push({ status });
  const kind = choice(f.kind, EvaluationKind, 'Kind');
  if (kind) and.push({ kind });
  if (f.employeeId) and.push({ employeeId: f.employeeId });
  if (f.evaluatorId) and.push({ evaluatorId: f.evaluatorId });
  if (f.milestone) and.push({ milestone: f.milestone });
  if (f.open === '1') and.push({ status: { in: OPEN } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
        { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
        { employee: { employeeNo: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(f.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

const EVALUATION_SORTS = ['number', 'dueDate', 'status', 'createdAt', 'submittedAt'];

evaluationRoutes.get(
  '/',
  requireAny('ghr.evaluations.view_all', 'ghr.evaluations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = evaluationListWhere(me, q);

    const [rows, total] = await Promise.all([
      prisma.employeeEvaluation.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeNo: true,
              firstName: true,
              lastName: true,
              position: true,
              employmentType: true,
              department: { select: { id: true, name: true } },
            },
          },
          evaluator: { select: { id: true, name: true } },
        },
        orderBy: orderBy(q, EVALUATION_SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.employeeEvaluation.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({ ...r, score: num(r.score), milestoneLabel: milestoneLabel(r.milestone) })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The evaluation list on paper — the list as filtered (or the rows ticked),
 * through `evaluationListWhere`, so the paper is the screen it was printed
 * off and carries what the screen does: who, which milestone, when due, by
 * whom, the score and the recommendation. Nothing more — the ratings line by
 * line are the evaluation's own paper — and the audit row says only how many
 * were printed (ratings never reach the audit log). Declared above `/:id`,
 * or that route swallows it.
 */
evaluationRoutes.get(
  '/pdf',
  requireAny('ghr.evaluations.view_all', 'ghr.evaluations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = evaluationListWhere(me, q);
    const f = q.filters;
    const [rows, count, employee, evaluator] = await Promise.all([
      prisma.employeeEvaluation.findMany({
        where,
        include: {
          employee: { select: { employeeNo: true, firstName: true, lastName: true, position: true, department: { select: { name: true } } } },
          evaluator: { select: { name: true } },
        },
        orderBy: orderBy(q, EVALUATION_SORTS, { createdAt: 'desc' }),
        take: LIST_CAP,
      }),
      prisma.employeeEvaluation.count({ where }),
      f.employeeId ? prisma.employee.findUnique({ where: { id: f.employeeId }, select: { firstName: true, lastName: true } }) : null,
      f.evaluatorId ? prisma.user.findUnique({ where: { id: f.evaluatorId }, select: { name: true } }) : null,
    ]);

    const status = choice(f.status, EvaluationStatus, 'Status');
    const kind = choice(f.kind, EvaluationKind, 'Kind');
    const reference = listReference(count, rows.length, ['evaluation', 'evaluations'], [
      q.search && `search "${q.search}"`,
      f.open === '1' ? 'open only' : status && `status ${statusLabel(status)}`,
      kind && `${statusLabel(kind).toLowerCase()} evaluations`,
      f.milestone && `milestone ${milestoneLabel(f.milestone)}`,
      f.employeeId && `employee ${employee ? fullName(employee) : 'not found'}`,
      f.evaluatorId && `evaluator ${evaluator?.name ?? 'not found'}`,
      (q.scope === 'mine' || !can(me, 'ghr.evaluations.view_all')) && 'mine only',
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6).
    const pdf = await renderDocument({
      title: 'Evaluations',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee', 'Evaluation', 'Due', 'Evaluator', 'Score', 'Recommendation', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            {
              title: `${r.employee.lastName}, ${r.employee.firstName}`,
              body: [r.employee.employeeNo, r.employee.position, r.employee.department?.name].filter(Boolean).join(' · '),
            },
            { title: milestoneLabel(r.milestone), body: `${statusLabel(r.kind)} evaluation` },
            r.dueDate ? formatShortDate(r.dueDate) : '—',
            r.evaluator.name,
            r.score == null ? '—' : Number(r.score).toFixed(2),
            r.recommendation ? RECOMMENDATION_LABEL[r.recommendation] : '—',
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'evaluation', entityId: 'list', action: 'EXPORTED', summary: `Exported the evaluation list as PDF (${rows.length} evaluation(s))` },
      req,
    );
    sendListPdf(res, pdf, 'evaluations.pdf');
  }),
);

// ── Create ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  employeeId: z.string().min(1, 'Who is being evaluated?'),
  milestone: z
    .string()
    .trim()
    .regex(/^(MONTH_\d{1,2}|END|ADHOC)$/, 'Milestone must be MONTH_<n>, END or ADHOC'),
  evaluatorId: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  periodFrom: z.string().optional().nullable(),
  periodTo: z.string().optional().nullable(),
});

/**
 * Opens an evaluation for an employee at a milestone, with the criteria
 * snapshotted onto it. The evaluator OWNS the record; when that is the
 * caller it starts as a DRAFT they can fill in, and when it is somebody else
 * it starts SCHEDULED and that person is told.
 */
async function openEvaluation(
  me: { id: string; name: string },
  body: z.infer<typeof createSchema>,
  status: 'DRAFT' | 'SCHEDULED',
) {
  const employee = await prisma.employee.findUnique({
    where: { id: body.employeeId },
    select: { ...employeeSelect, isActive: true },
  });
  if (!employee) throw notFound('Employee not found');
  if (!employee.isActive) throw badRequest(`${fullName(employee)} is no longer active`);

  const kind = kindFor(employee.employmentType);
  if (!kind) {
    throw badRequest(
      `${fullName(employee)} is ${employee.employmentType.toLowerCase().replace(/_/g, ' ')} — an evaluation is for probationary or trainee staff`,
    );
  }

  const evaluatorId = body.evaluatorId || me.id;
  if (employee.userId && employee.userId === evaluatorId) {
    throw badRequest('Nobody evaluates themselves — name the supervisor who does');
  }
  const evaluator = await prisma.user.findUnique({
    where: { id: evaluatorId },
    select: { id: true, name: true, isActive: true },
  });
  if (!evaluator || !evaluator.isActive) throw notFound('Evaluator not found');

  const clash = await prisma.employeeEvaluation.findFirst({
    where: { employeeId: employee.id, milestone: body.milestone, kind, status: { in: OPEN } },
    select: { number: true },
  });
  if (clash) {
    throw badRequest(`${clash.number} is already open for ${fullName(employee)} at ${milestoneLabel(body.milestone)}`);
  }

  // The due date defaults to the milestone's own date for this employee, so
  // the derived "who is due" list recognises the evaluation as covering it.
  const settings = await hrSettings();
  const anchor = await periodAnchor(employee);
  const computed = evaluationMilestones(employee, settings, anchor).find((m) => m.milestone === body.milestone);
  const dueDate = asDate(body.dueDate) ?? computed?.dueDate ?? (body.milestone === 'ADHOC' ? manilaDate(new Date()) : null);
  if (!dueDate) {
    throw badRequest(
      `${milestoneLabel(body.milestone)} has no date for ${fullName(employee)} — set the period end on the employee record, or give a due date`,
    );
  }

  const criteria = await evaluationCriteria();
  const lines = snapshotLines(criteria, kind);
  if (!lines.length) {
    throw badRequest('No evaluation criteria apply — add them under HR Settings first');
  }

  const created = await prisma.$transaction(async (tx) => {
    const number = await nextNumber('evaluation', tx);
    return tx.employeeEvaluation.create({
      data: {
        number,
        kind,
        status,
        milestone: body.milestone,
        employeeId: employee.id,
        evaluatorId,
        scheduledById: me.id,
        dueDate,
        periodFrom: asDate(body.periodFrom) ?? anchor,
        periodTo: asDate(body.periodTo) ?? probationEnd(employee, settings, anchor),
        lines: { create: lines },
      },
      include: fullInclude,
    });
  });

  await audit({
    entityType: 'evaluation',
    entityId: created.id,
    action: 'CREATED',
    summary: `${created.number} — ${milestoneLabel(body.milestone)} ${kind.toLowerCase()} evaluation of ${fullName(employee)}${
      status === 'SCHEDULED' ? `, assigned to ${evaluator.name}` : ''
    }`,
    actorId: me.id,
    actorName: me.name,
  });

  if (status === 'SCHEDULED') {
    await notify({
      userId: evaluatorId,
      type: 'evaluation.due',
      title: `Evaluate ${fullName(employee)} — ${milestoneLabel(body.milestone)}`,
      body: `Due ${formatDate(dueDate)} · ${created.number}`,
      link: `/g-hr/evaluations/${created.id}`,
    });
  }
  return created;
}

evaluationRoutes.post(
  '/',
  require_('ghr.evaluations.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body);
    if (body.evaluatorId && body.evaluatorId !== me.id) {
      throw badRequest('To open an evaluation for another evaluator, schedule it');
    }
    const created = await openEvaluation(me, { ...body, evaluatorId: me.id }, 'DRAFT');
    res.status(201).json(present(created));
  }),
);

/** Assigns the evaluation to somebody else — HR scheduling a supervisor. */
evaluationRoutes.post(
  '/schedule',
  require_('ghr.evaluations.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body);
    const evaluatorId = body.evaluatorId || me.id;
    const created = await openEvaluation(me, { ...body, evaluatorId }, evaluatorId === me.id ? 'DRAFT' : 'SCHEDULED');
    res.status(201).json(present(created));
  }),
);

// ── Read ─────────────────────────────────────────────────────────────────────

evaluationRoutes.get(
  '/:id',
  requireAny('ghr.evaluations.view_all', 'ghr.evaluations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const ev = await loadFull(req.params.id);
    if (!visibleTo(me, ev)) throw notFound('Evaluation not found');

    const settings = await hrSettings();
    const editable = canEditRecord(me, 'ghr', 'evaluations', ev.evaluatorId) && (ev.status === 'DRAFT' || ev.status === 'SCHEDULED');
    res.json({
      ...present(ev),
      canEdit: editable,
      canCancel:
        (canEditRecord(me, 'ghr', 'evaluations', ev.evaluatorId) || me.isSuperAdmin) &&
        ev.status !== 'APPROVED' &&
        ev.status !== 'CANCELLED' &&
        ev.status !== 'REJECTED',
      isSubject: ev.employee.userId === me.id,
      ratingScale: settings.ratingScale,
      ratingLabels: settings.ratingLabels,
    });
  }),
);

// ── Edit ─────────────────────────────────────────────────────────────────────

const lineSchema = z.object({
  id: z.string().min(1),
  rating: z.number().int().nullable().optional(),
  remarks: z.string().trim().max(2000).nullable().optional(),
});

const patchSchema = z.object({
  periodFrom: z.string().nullable().optional(),
  periodTo: z.string().nullable().optional(),
  strengths: z.string().trim().max(4000).nullable().optional(),
  improvements: z.string().trim().max(4000).nullable().optional(),
  comments: z.string().trim().max(4000).nullable().optional(),
  recommendation: z.nativeEnum(EvaluationRecommendation).nullable().optional(),
  effectiveDate: z.string().nullable().optional(),
  extendedTo: z.string().nullable().optional(),
  lines: z.array(lineSchema).optional(),
});

async function editable(me: ReturnType<typeof currentUser>, id: string) {
  const ev = await loadFull(id);
  if (!visibleTo(me, ev)) throw notFound('Evaluation not found');
  if (!canEditRecord(me, 'ghr', 'evaluations', ev.evaluatorId)) {
    throw forbidden('Only the evaluator can write this evaluation');
  }
  if (ev.status !== 'DRAFT' && ev.status !== 'SCHEDULED') {
    throw badRequest(`This evaluation is ${ev.status.toLowerCase().replace(/_/g, ' ')} and can no longer be edited`);
  }
  return ev;
}

evaluationRoutes.patch(
  '/:id',
  requireAny('ghr.evaluations.edit_own', 'ghr.evaluations.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(patchSchema, req.body);
    const ev = await editable(me, req.params.id);
    const settings = await hrSettings();

    if (body.recommendation && !allowedRecommendations(ev.kind).includes(body.recommendation)) {
      throw badRequest(
        `${RECOMMENDATION_LABEL[body.recommendation]} is not a ${ev.kind.toLowerCase()} outcome — choose from ${allowedRecommendations(ev.kind)
          .map((r) => RECOMMENDATION_LABEL[r])
          .join(', ')}`,
      );
    }

    const byId = new Map(ev.lines.map((l) => [l.id, l]));
    for (const line of body.lines ?? []) {
      if (!byId.has(line.id)) throw badRequest('That criterion is not on this form');
      if (line.rating != null && (line.rating < 1 || line.rating > settings.ratingScale)) {
        throw badRequest(`A rating runs from 1 to ${settings.ratingScale}`);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const line of body.lines ?? []) {
        await tx.employeeEvaluationLine.update({
          where: { id: line.id },
          data: {
            ...(line.rating !== undefined ? { rating: line.rating } : {}),
            ...(line.remarks !== undefined ? { remarks: line.remarks || null } : {}),
          },
        });
      }
      const lines = await tx.employeeEvaluationLine.findMany({ where: { evaluationId: ev.id } });
      const score = evaluationScore(lines);
      return tx.employeeEvaluation.update({
        where: { id: ev.id },
        data: {
          // The first save turns a scheduled evaluation into the evaluator's draft.
          status: 'DRAFT',
          ...(body.periodFrom !== undefined ? { periodFrom: asDate(body.periodFrom) } : {}),
          ...(body.periodTo !== undefined ? { periodTo: asDate(body.periodTo) } : {}),
          ...(body.strengths !== undefined ? { strengths: body.strengths || null } : {}),
          ...(body.improvements !== undefined ? { improvements: body.improvements || null } : {}),
          ...(body.comments !== undefined ? { comments: body.comments || null } : {}),
          ...(body.recommendation !== undefined ? { recommendation: body.recommendation } : {}),
          ...(body.effectiveDate !== undefined ? { effectiveDate: asDate(body.effectiveDate) } : {}),
          ...(body.extendedTo !== undefined ? { extendedTo: asDate(body.extendedTo) } : {}),
          score: score == null ? null : new Prisma.Decimal(score),
        },
        include: fullInclude,
      });
    });

    // Summary only. A rating is between the evaluator and the approvers; the
    // audit log is read by administrators, and "3 → 2 on Teamwork" is not
    // theirs to see.
    const rated = updated.lines.filter((l) => l.rating != null).length;
    await audit(
      {
        entityType: 'evaluation',
        entityId: ev.id,
        action: 'UPDATED',
        summary: `${ev.number} edited — ${rated} of ${updated.lines.length} criteria rated${
          updated.recommendation ? `, recommendation ${RECOMMENDATION_LABEL[updated.recommendation].toLowerCase()}` : ''
        }`,
      },
      req,
    );
    res.json(present(updated));
  }),
);

// ── Submit ───────────────────────────────────────────────────────────────────

evaluationRoutes.post(
  '/:id/submit',
  requireAny('ghr.evaluations.edit_own', 'ghr.evaluations.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const ev = await editable(me, req.params.id);

    const unrated = ev.lines.filter((l) => l.rating == null);
    if (unrated.length) {
      throw badRequest(`Rate every criterion before submitting — ${unrated.map((l) => l.name).join(', ')} still unrated`);
    }
    if (!ev.recommendation) throw badRequest('Choose a recommendation before submitting');
    if (!allowedRecommendations(ev.kind).includes(ev.recommendation)) {
      throw badRequest(`${RECOMMENDATION_LABEL[ev.recommendation]} is not a ${ev.kind.toLowerCase()} outcome`);
    }
    if (ev.recommendation === 'EXTEND') {
      const settings = await hrSettings();
      const currentEnd = probationEnd(ev.employee, settings, await periodAnchor(ev.employee));
      if (!ev.extendedTo) throw badRequest('An extension needs the date the period now ends');
      if (currentEnd && ev.extendedTo.getTime() <= currentEnd.getTime()) {
        throw badRequest(`The extended date must fall after the current period end (${formatDate(currentEnd)})`);
      }
    }

    // The person being evaluated must not sit anywhere on the approval chain.
    // The engine stops the REQUESTER approving; this stops the SUBJECT, who is
    // somebody else — an HR officer's own probation review must not route
    // back to HR, and a manager's to the management step.
    const workflow = await pickWorkflow('evaluation');
    if (!workflow || !workflow.steps.length) {
      throw badRequest('No approval workflow is configured for "evaluation". Set one up in Admin › Approval Workflows.');
    }
    for (const step of workflow.steps) {
      const approvers = await approversForStep(step, me.id);
      if (ev.employee.userId && approvers.includes(ev.employee.userId)) {
        throw badRequest(
          `"${workflow.name}" routes "${step.name}" to ${fullName(ev.employee)}, the person being evaluated. ` +
            `An evaluation cannot be approved by its subject — change the step or the approver in Admin › Approval Workflows.`,
        );
      }
      // The engine will not let the submitter approve their own step, so a step
      // only they hold would sit in a queue nobody can clear.
      if (!approvers.some((id) => id !== me.id)) {
        throw badRequest(
          `Nobody but you can approve "${step.name}" — assign that role to a second person before submitting.`,
        );
      }
    }

    const submittedAt = new Date();
    await prisma.employeeEvaluation.update({
      where: { id: ev.id },
      data: { status: 'PENDING_APPROVAL', submittedAt },
    });
    try {
      await submitForApproval({
        documentType: 'evaluation',
        documentId: ev.id,
        documentNumber: ev.number,
        subject: `${fullName(ev.employee)} — ${milestoneLabel(ev.milestone)} ${ev.kind.toLowerCase()} evaluation, ${RECOMMENDATION_LABEL[ev.recommendation].toLowerCase()}`,
        link: `/g-hr/evaluations/${ev.id}`,
        requesterId: me.id,
      });
    } catch (err) {
      await prisma.employeeEvaluation.update({
        where: { id: ev.id },
        data: { status: 'DRAFT', submittedAt: null },
      });
      throw err;
    }

    res.json(present(await loadFull(ev.id)));
  }),
);

// ── The outcome ──────────────────────────────────────────────────────────────

/**
 * Regularisation is an approved document, not a field edit: this is the one
 * place the employee record changes because of an evaluation, and it runs
 * only when every step has approved.
 *
 * One more guard, past the engine's own: if any approver on the chain was the
 * person evaluated, nothing is applied. The submit route refuses that routing,
 * but roles change between submission and decision, and an evaluation the
 * subject signed off is not one the company decided.
 */
onApprovalSettled('evaluation', async (approval, outcome) => {
  const ev = await prisma.employeeEvaluation.findUnique({
    where: { id: approval.documentId },
    include: { employee: true, evaluator: { select: { id: true, name: true } } },
  });
  if (!ev || ev.status !== 'PENDING_APPROVAL') return;

  if (outcome !== 'APPROVED') {
    // The engine reports RETURNED as a rejection. A returned evaluation goes
    // back to the evaluator as a draft to correct and resubmit — a rejected one
    // is closed, and its milestone falls due again for a fresh evaluation.
    const last = await prisma.approvalAction.findFirst({
      where: { requestId: approval.id },
      orderBy: { actedAt: 'desc' },
      select: { action: true },
    });
    if (last?.action === 'RETURNED') {
      await prisma.employeeEvaluation.update({
        where: { id: ev.id },
        data: { status: 'DRAFT', submittedAt: null },
      });
      await audit({
        entityType: 'evaluation',
        entityId: ev.id,
        action: 'RETURNED',
        summary: `${ev.number} returned to ${ev.evaluator.name} for correction`,
      });
      return;
    }
    await prisma.employeeEvaluation.update({ where: { id: ev.id }, data: { status: 'REJECTED' } });
    await audit({
      entityType: 'evaluation',
      entityId: ev.id,
      action: 'REJECTED',
      summary: `${ev.number} rejected — nothing changes on ${fullName(ev.employee)}'s record`,
    });
    return;
  }

  if (ev.employee.userId) {
    const selfSigned = await prisma.approvalAction.findFirst({
      where: { requestId: approval.id, approverId: ev.employee.userId },
      select: { id: true },
    });
    if (selfSigned) {
      console.error(
        `Evaluation ${ev.number} was approved by its own subject (${fullName(ev.employee)}) — the decision is recorded but NOT applied. ` +
          `Check the "evaluation" workflow's approvers.`,
      );
      await prisma.employeeEvaluation.update({ where: { id: ev.id }, data: { status: 'REJECTED' } });
      await audit({
        entityType: 'evaluation',
        entityId: ev.id,
        action: 'REJECTED',
        summary: `${ev.number} refused — ${fullName(ev.employee)} approved their own evaluation; nothing applied. Raise it again once the workflow no longer routes to them.`,
      });
      await notify({
        userId: ev.evaluatorId,
        type: 'system',
        title: `${ev.number} not applied`,
        body: `${fullName(ev.employee)} was on the approval chain of their own evaluation`,
        link: `/g-hr/evaluations/${ev.id}`,
      });
      return;
    }
  }

  const settings = await hrSettings();
  const approvedAt = new Date();
  // With no effective date typed, the day it was approved: the Manila date,
  // because `approvedAt` itself would be stored as its UTC date, which is
  // yesterday's until 08:00.
  const effective = ev.effectiveDate ?? manilaDate(approvedAt);
  const rec = ev.recommendation;

  let change = 'no change to the employee record';
  await prisma.$transaction(async (tx) => {
    await tx.employeeEvaluation.update({
      where: { id: ev.id },
      data: { status: 'APPROVED', approvedAt, effectiveDate: rec === 'END' ? ev.effectiveDate : effective },
    });
    if (rec === 'REGULARIZE' && ev.kind === 'PROBATIONARY') {
      await tx.employee.update({
        where: { id: ev.employeeId },
        data: { employmentType: 'REGULAR', dateRegularized: effective, periodEndDate: null },
      });
      change = `regularised effective ${formatDate(effective)}`;
    } else if (rec === 'EXTEND' && ev.extendedTo) {
      await tx.employee.update({
        where: { id: ev.employeeId },
        data: { periodEndDate: ev.extendedTo },
      });
      change = `period extended to ${formatDate(ev.extendedTo)}`;
    } else if (rec === 'ABSORB' && ev.kind === 'TRAINEE') {
      // A fresh probation from the effective date; the hire date stays what
      // it was, because that is when they joined.
      const periodEndDate = addMonths(effective, settings.probationMonths);
      await tx.employee.update({
        where: { id: ev.employeeId },
        data: { employmentType: 'PROBATIONARY', periodEndDate },
      });
      change = `absorbed into probation from ${formatDate(effective)}, ending ${formatDate(periodEndDate)}`;
    } else if (rec === 'END') {
      change = 'engagement to end — HR to process the separation through a clearance';
    }
  });

  await audit({
    entityType: 'evaluation',
    entityId: ev.id,
    action: 'APPROVED',
    summary: `${ev.number} approved — ${change}`,
  });

  const recipients = [
    {
      userId: ev.evaluatorId,
      type: 'approval.approved' as const,
      title: `${ev.number} approved`,
      body: `${fullName(ev.employee)} — ${change}`,
      link: `/g-hr/evaluations/${ev.id}`,
    },
  ];
  if (ev.employee.userId) {
    recipients.push({
      userId: ev.employee.userId,
      type: 'approval.approved' as const,
      title: `Your ${milestoneLabel(ev.milestone).toLowerCase()} evaluation is ready`,
      body: 'Read it and acknowledge it',
      link: `/g-hr/evaluations/${ev.id}`,
    });
  }
  if (rec === 'END') {
    for (const userId of await usersInRole('hr')) {
      recipients.push({
        userId,
        type: 'approval.approved' as const,
        title: `${fullName(ev.employee)} — engagement to end`,
        body: `${ev.number} approved with END. Process the separation through a clearance.`,
        link: `/g-hr/evaluations/${ev.id}`,
      });
    }
  }
  await notify(recipients);
});

// ── Cancel ───────────────────────────────────────────────────────────────────

evaluationRoutes.post(
  '/:id/cancel',
  requireAny('ghr.evaluations.edit_own', 'ghr.evaluations.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const ev = await loadFull(req.params.id);
    if (!visibleTo(me, ev)) throw notFound('Evaluation not found');
    if (!canEditRecord(me, 'ghr', 'evaluations', ev.evaluatorId) && !me.isSuperAdmin) {
      throw forbidden('Only the evaluator can cancel this evaluation');
    }
    if (ev.status === 'APPROVED') throw badRequest('An approved evaluation is a record — it cannot be cancelled');
    if (ev.status === 'CANCELLED' || ev.status === 'REJECTED') throw badRequest('This evaluation is already closed');

    await prisma.$transaction(async (tx) => {
      await tx.employeeEvaluation.update({ where: { id: ev.id }, data: { status: 'CANCELLED' } });
      // Still with HR or management: withdrawn through the engine, so it leaves
      // their queue and they are told. That is the chain and the requester
      // only — the person evaluated, whom submit keeps off the chain, is not.
      await cancelOpenRequest('evaluation', ev.id, tx, `cancelled by ${me.name}`, me.id);
    });
    await audit({ entityType: 'evaluation', entityId: ev.id, action: 'CANCELLED', summary: `${ev.number} cancelled` }, req);
    res.json(present(await loadFull(ev.id)));
  }),
);

// ── Acknowledge ──────────────────────────────────────────────────────────────

/** The person evaluated says they have read it. Not agreement — receipt. */
evaluationRoutes.post(
  '/:id/acknowledge',
  requireAny('ghr.evaluations.view_own', 'ghr.evaluations.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ note: z.string().trim().max(2000).optional().nullable() }), req.body ?? {});
    const ev = await loadFull(req.params.id);
    if (!visibleTo(me, ev)) throw notFound('Evaluation not found');
    if (ev.employee.userId !== me.id) throw forbidden('Only the person evaluated can acknowledge it');
    if (ev.status !== 'APPROVED') throw badRequest('An evaluation is acknowledged once it is approved');
    if (ev.employeeAcknowledgedAt) throw badRequest('Already acknowledged');

    const updated = await prisma.employeeEvaluation.update({
      where: { id: ev.id },
      data: { employeeAcknowledgedAt: new Date(), employeeAcknowledgementNote: body.note || null },
      include: fullInclude,
    });
    await audit(
      { entityType: 'evaluation', entityId: ev.id, action: 'COMPLETED', summary: `${ev.number} acknowledged by ${fullName(ev.employee)}` },
      req,
    );
    await notify({
      userId: ev.evaluatorId,
      type: 'system',
      title: `${fullName(ev.employee)} acknowledged ${ev.number}`,
      body: body.note || undefined,
      link: `/g-hr/evaluations/${ev.id}`,
    });
    res.json(present(updated));
  }),
);

// ── Print ────────────────────────────────────────────────────────────────────

/**
 * The approval half of the sign-offs (rule 6): every step of the route
 * through the engine's one mapping. An evaluation not yet submitted —
 * scheduled, or a draft (a returned one included) — prints the route
 * submitting it would take, in the evaluator's name, every step open (the
 * request that sent it back signs nothing now). A rejected or a cancelled
 * one is closed for good, so it prints only the steps that really signed
 * (`approvalSlots` of a closed request — a cancel withdraws it): the step
 * that rejected it and any after it acted or never will, and "Pending"
 * there would promise a signature nobody is going to give; the Decision
 * line says who rejected it. One open "Approved by" only where no workflow
 * covers evaluations at all, and never on a closed one.
 */
async function routeSignoffs(ev: Full): Promise<Signatory[]> {
  const unsubmitted = ev.status === 'SCHEDULED' || ev.status === 'DRAFT';
  const closed = ev.status === 'REJECTED' || ev.status === 'CANCELLED';
  const slots = await approvalSlots('evaluation', ev.id, unsubmitted ? { amount: null, requesterId: ev.evaluatorId } : undefined);
  return slots.length ? slotSignatories(slots) : closed ? [] : [{ role: 'Approved by' }];
}

/**
 * Why a rejected evaluation is closed, as one line on its paper: who
 * rejected it, at which step, when, and what they wrote — read off the
 * engine's history of the latest request. A rejected evaluation with no
 * rejection on that request is the one the subscriber refused to apply
 * because the person evaluated signed it themself.
 */
async function rejectionNote(ev: Full): Promise<string> {
  const [latest] = await historyFor('evaluation', ev.id);
  const no = latest?.actions.filter((a) => a.action === 'REJECTED').pop();
  if (latest && no) {
    const step = latest.workflow?.steps.find((s) => s.sequence === no.sequence)?.name;
    return `Rejected${step ? ` at ${step}` : ''} by ${no.approver.name}, ${formatDateTime(no.actedAt)}${no.comment ? `: ${no.comment}` : '.'}`;
  }
  return `Not applied: ${fullName(ev.employee)} signed their own evaluation, so nothing changes on their record. Raise it again once the route no longer reaches them.`;
}

evaluationRoutes.get(
  '/:id/pdf',
  requireAny('ghr.evaluations.view_all', 'ghr.evaluations.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const ev = await loadFull(req.params.id);
    if (!visibleTo(me, ev)) throw notFound('Evaluation not found');
    const settings = await hrSettings();
    const label = (rating: number | null) =>
      rating == null ? '' : `${rating} — ${settings.ratingLabels[rating - 1] ?? ''}`.trim();

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Employee', value: fullName(ev.employee) },
          { label: 'Employee number', value: ev.employee.employeeNo },
          { label: 'Position', value: ev.employee.position ?? '—' },
          { label: 'Department', value: ev.employee.department?.name ?? '—' },
          { label: 'Kind', value: ev.kind === 'TRAINEE' ? 'Trainee evaluation' : 'Probationary evaluation' },
          { label: 'Milestone', value: milestoneLabel(ev.milestone) },
          { label: 'Date hired', value: ev.employee.dateHired ? formatDate(ev.employee.dateHired) : '—' },
          {
            label: 'Period covered',
            value: `${ev.periodFrom ? formatDate(ev.periodFrom) : '—'} to ${ev.periodTo ? formatDate(ev.periodTo) : '—'}`,
          },
          { label: 'Evaluator', value: ev.evaluator.name },
          { label: 'Status', value: statusLabel(ev.status) },
        ],
      },
      {
        kind: 'table',
        title: `Ratings (1–${settings.ratingScale})`,
        // No widths: each column from what it holds, so a head never breaks
        // mid-word ("WEIGH / T" did in fixed shares).
        head: ['No.', 'Criterion', 'Weight', 'Rating', 'Remarks'],
        align: ['right', 'left', 'right', 'left', 'left'],
        rows: ev.lines.map((l) => [String(l.sortOrder), l.name, Number(l.weight).toFixed(2), label(l.rating), l.remarks ?? '']),
      },
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Weighted score', value: ev.score == null ? '—' : `${Number(ev.score).toFixed(2)} of ${settings.ratingScale}` },
          { label: 'Recommendation', value: ev.recommendation ? RECOMMENDATION_LABEL[ev.recommendation] : '—' },
          {
            label: ev.recommendation === 'EXTEND' ? 'Period extended to' : 'Effective',
            value:
              ev.recommendation === 'EXTEND'
                ? ev.extendedTo
                  ? formatDate(ev.extendedTo)
                  : '—'
                : ev.effectiveDate
                  ? formatDate(ev.effectiveDate)
                  : '—',
          },
        ],
      },
    ];
    if (ev.strengths) sections.push({ kind: 'text', title: 'Strengths', body: ev.strengths });
    if (ev.improvements) sections.push({ kind: 'text', title: 'Areas for improvement', body: ev.improvements });
    if (ev.comments) sections.push({ kind: 'text', title: 'Comments', body: ev.comments });
    if (ev.employeeAcknowledgementNote) {
      sections.push({ kind: 'text', title: "Employee's note", body: ev.employeeAcknowledgementNote });
    }
    if (ev.status === 'REJECTED') sections.push({ kind: 'text', title: 'Decision', body: await rejectionNote(ev) });

    // Evaluated by the evaluator, dated by the submission that signs it; then
    // every step of the route in the engine's one mapping — the step's name
    // as the role, who signed and when, else who may sign over "Pending".
    // The subject's acknowledgement is the last signature, dated by the
    // acknowledgement itself — and only where one can still come: they need
    // a login to give it, and a rejected or cancelled evaluation asks none.
    // Their name and the date only: nobody calls the person evaluated off
    // their own evaluation, and an evaluator need not read their number.
    const evaluator = await contactOf(ev.evaluatorId);
    const acknowledges =
      !!ev.employeeAcknowledgedAt || (!!ev.employee.userId && ev.status !== 'REJECTED' && ev.status !== 'CANCELLED');
    const signatories: Signatory[] = [
      { role: 'Evaluated by', name: ev.evaluator.name, ...evaluator, at: ev.submittedAt },
      ...(await routeSignoffs(ev)),
      ...(acknowledges
        ? [{ role: 'Acknowledged by', name: fullName(ev.employee), at: ev.employeeAcknowledgedAt }]
        : []),
    ];
    const pdf = await renderDocument({
      title: 'Employee Evaluation',
      documentNumber: ev.number,
      date: ev.submittedAt ?? ev.createdAt,
      reference: `${fullName(ev.employee)} · ${milestoneLabel(ev.milestone)}`,
      sections,
      signatories,
    });

    await audit({ entityType: 'evaluation', entityId: ev.id, action: 'EXPORTED', summary: `Printed ${ev.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${ev.number}.pdf"`);
    res.send(pdf);
  }),
);
