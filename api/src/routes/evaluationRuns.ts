import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authenticate, currentUser, requireAny } from '../auth/middleware';
import { handler, parseBody, notFound, badRequest, conflict, forbidden } from '../http/kit';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { toCsv } from '../shared/csv';
import { renderDocument, formatDate } from '../shared/pdf';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { manilaDate } from '../shared/day';

/**
 * Evaluation runs (2026-11-13, the owner's call: "we can run an evaluation for
 * certain people, particularly trainees; HR can add evaluation questions for
 * them; after all have answered there should be a report"). His answer: the
 * EVALUATORS rate the people — the superior, the trainer, peers.
 *
 * HR (Evaluation Runs › Create / Edit All) writes a run: its questions (a
 * rating from 1 to 5 with a weight, or a written comment), the people
 * evaluated, and who evaluates each. Opened, every evaluator is told (bell,
 * My Work) and answers on a simple page — only their own assignment, with no
 * right needed. HR sees who has not answered and reminds them (once a day).
 * The REPORT, any time: per person each question's average rating, the
 * weighted overall (1–5), how many answered, and the comments; the batch
 * ranked by the overall; as CSV and on paper. The person evaluated reads their
 * own result only once HR releases it, and never who wrote what. The ratings
 * never reach the audit trail. Apart from the regularisation evaluation, which
 * changes a person's employment: this changes nothing on their record.
 */

export const evaluationRunRoutes = Router();
evaluationRunRoutes.use(authenticate);

const DOC = 'evaluation_run';
const PATH = '/g-hr/evaluation-runs';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const todayKey = () => manilaDate(new Date()).toISOString().slice(0, 10);

const isHr = (me: ResolvedUser) => me.isSuperAdmin || can(me, 'ghr.evaluation_runs.view_all');
const mayEdit = (me: ResolvedUser, run: { createdById: string }) => me.isSuperAdmin || can(me, 'ghr.evaluation_runs.edit_all') || (can(me, 'ghr.evaluation_runs.create') && run.createdById === me.id);

const personSelect = { id: true, firstName: true, lastName: true, employeeNo: true, position: true, employmentType: true, industry: { select: { code: true } } } satisfies Prisma.EmployeeSelect;
const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

const runInclude = {
  createdBy: { select: { id: true, name: true } },
  questions: { orderBy: { sequence: 'asc' } },
  targets: {
    include: {
      employee: { select: personSelect },
      assignments: { include: { evaluator: { select: { id: true, name: true } }, answers: true }, orderBy: { evaluator: { name: 'asc' } } },
    },
    orderBy: { employee: { lastName: 'asc' } },
  },
} satisfies Prisma.EvaluationRunInclude;
type RunRow = Prisma.EvaluationRunGetPayload<{ include: typeof runInclude }>;

async function loadRun(id: string): Promise<RunRow> {
  const run = await prisma.evaluationRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw notFound('Evaluation run not found');
  return run;
}

function progressOf(run: RunRow) {
  const all = run.targets.flatMap((t) => t.assignments);
  return { answered: all.filter((a) => a.submittedAt).length, asked: all.length };
}

/**
 * The report — the one arithmetic for the screen, the CSV and the paper. Only
 * SUBMITTED answers count. A question's average is the mean of its ratings;
 * a person's overall is the weighted mean of the question averages that have
 * a rating, by each question's weight.
 */
export function runReport(run: RunRow, opts: { names: boolean }) {
  const ratingQs = run.questions.filter((q) => q.kind === 'RATING');
  const commentQs = run.questions.filter((q) => q.kind === 'COMMENT');
  const people = run.targets.map((t) => {
    const done = t.assignments.filter((a) => a.submittedAt);
    const perQuestion = ratingQs.map((q) => {
      const ratings = done.map((a) => a.answers.find((x) => x.questionId === q.id)?.rating).filter((r): r is number => r != null);
      return { questionId: q.id, prompt: q.prompt, weight: num(q.weight), average: ratings.length ? round2(ratings.reduce((s, r) => s + r, 0) / ratings.length) : null, count: ratings.length };
    });
    const rated = perQuestion.filter((p) => p.average != null);
    const weights = rated.reduce((s, p) => s + p.weight, 0);
    const overall = weights > 0 ? round2(rated.reduce((s, p) => s + (p.average as number) * p.weight, 0) / weights) : null;
    const comments = commentQs.map((q) => ({
      prompt: q.prompt,
      answers: done
        .map((a) => ({ by: opts.names ? `${a.evaluator.name}${a.role ? ` (${a.role})` : ''}` : a.role ?? 'Evaluator', text: a.answers.find((x) => x.questionId === q.id)?.comment?.trim() ?? '' }))
        .filter((c) => c.text),
    }));
    return {
      targetId: t.id,
      employeeId: t.employee.id,
      name: nameOf(t.employee),
      employeeNo: t.employee.employeeNo,
      position: t.employee.position,
      team: t.employee.industry?.code ?? null,
      answered: done.length,
      asked: t.assignments.length,
      overall,
      perQuestion,
      comments,
      ...(opts.names ? { pending: t.assignments.filter((a) => !a.submittedAt).map((a) => a.evaluator.name) } : {}),
    };
  });
  const ranked = [...people].sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || a.name.localeCompare(b.name));
  return { people, ranked, questions: run.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt, weight: num(q.weight) })), progress: progressOf(run) };
}

function presentRun(me: ResolvedUser, run: RunRow) {
  return {
    id: run.id,
    number: run.number,
    title: run.title,
    description: run.description,
    dueOn: run.dueOn,
    status: run.status,
    createdBy: run.createdBy,
    openedAt: run.openedAt,
    closedAt: run.closedAt,
    releasedAt: run.releasedAt,
    remindedAt: run.remindedAt,
    progress: progressOf(run),
    questions: run.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt, weight: num(q.weight) })),
    targets: run.targets.map((t) => ({
      id: t.id,
      employee: { id: t.employee.id, name: nameOf(t.employee), employeeNo: t.employee.employeeNo, position: t.employee.position, team: t.employee.industry?.code ?? null, employmentType: t.employee.employmentType },
      evaluators: t.assignments.map((a) => ({ assignmentId: a.id, userId: a.evaluator.id, name: a.evaluator.name, role: a.role, submittedAt: a.submittedAt })),
    })),
    canEdit: mayEdit(me, run) && run.status === 'DRAFT',
    canOpen: mayEdit(me, run) && run.status === 'DRAFT',
    canRemind: mayEdit(me, run) && run.status === 'OPEN',
    canClose: mayEdit(me, run) && run.status === 'OPEN',
    canReopen: mayEdit(me, run) && run.status === 'CLOSED' && !run.releasedAt,
    canRelease: mayEdit(me, run) && run.status === 'CLOSED' && !run.releasedAt,
    canDelete: mayEdit(me, run) && run.status === 'DRAFT',
  };
}

// ── HR: the runs ─────────────────────────────────────────────────────────────

evaluationRunRoutes.get(
  '/',
  requireAny('ghr.evaluation_runs.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.evaluationRun.findMany({ include: runInclude, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ rows: rows.map((r) => ({ ...presentRun(me, r), targets: undefined, questions: undefined, people: r.targets.length })) });
  }),
);

/** The caller's own: assignments to answer in open runs, and their released results. Declared above `/:id`. */
evaluationRunRoutes.get(
  '/mine',
  handler(async (req, res) => {
    const me = currentUser(req);
    const [assignments, results] = await Promise.all([
      prisma.evaluationRunAssignment.findMany({
        where: { evaluatorId: me.id, target: { run: { status: { in: ['OPEN', 'CLOSED'] } } } },
        include: { target: { include: { employee: { select: personSelect }, run: { select: { id: true, number: true, title: true, status: true, dueOn: true } } } } },
        orderBy: [{ submittedAt: { sort: 'asc', nulls: 'first' } }],
        take: 100,
      }),
      prisma.evaluationRunTarget.findMany({
        where: { employee: { userId: me.id }, run: { releasedAt: { not: null } } },
        include: { run: { select: { id: true, number: true, title: true, releasedAt: true } } },
        orderBy: { run: { releasedAt: 'desc' } },
      }),
    ]);
    res.json({
      toAnswer: assignments.map((a) => ({
        id: a.id,
        run: a.target.run,
        person: nameOf(a.target.employee),
        position: a.target.employee.position,
        role: a.role,
        submittedAt: a.submittedAt,
        open: a.target.run.status === 'OPEN',
      })),
      results: results.map((t) => ({ runId: t.run.id, number: t.run.number, title: t.run.title, releasedAt: t.run.releasedAt })),
    });
  }),
);

const runSchema = z.object({
  title: z.string().trim().min(3, 'Name the evaluation').max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  dueOn: z.string().regex(DAY).optional().nullable(),
});

evaluationRunRoutes.post(
  '/',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(runSchema, req.body);
    const run = await prisma.$transaction(async (tx) =>
      tx.evaluationRun.create({
        data: { number: await nextNumber('evaluation_run', tx), title: body.title, description: body.description || null, dueOn: body.dueOn ? new Date(`${body.dueOn}T00:00:00Z`) : null, createdById: me.id },
      }),
    );
    await audit({ entityType: DOC, entityId: run.id, action: 'CREATED', summary: `${run.number} — ${run.title}` }, req);
    res.status(201).json(presentRun(me, await loadRun(run.id)));
  }),
);

evaluationRunRoutes.get(
  '/:id',
  requireAny('ghr.evaluation_runs.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(presentRun(me, await loadRun(req.params.id)));
  }),
);

const sheetSchema = runSchema.extend({
  questions: z
    .array(z.object({ kind: z.enum(['RATING', 'COMMENT']), prompt: z.string().trim().min(3, 'Write the question').max(1000), weight: z.number().positive().max(100).default(1) }))
    .max(60),
  targets: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        evaluators: z.array(z.object({ userId: z.string().min(1), role: z.string().trim().max(60).optional().nullable() })).max(20),
      }),
    )
    .max(200),
});

/** A draft, saved whole: its words, questions, people and their evaluators. */
evaluationRunRoutes.put(
  '/:id',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(sheetSchema, req.body);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    if (run.status !== 'DRAFT') throw badRequest('Only a draft is changed — the questions and people are fixed once it is open');
    const employeeIds = [...new Set(body.targets.map((t) => t.employeeId))];
    if (employeeIds.length !== body.targets.length) throw badRequest('A person is listed twice');
    const employees = await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, userId: true, firstName: true, lastName: true, isActive: true } });
    if (employees.length !== employeeIds.length) throw badRequest('One of the people is not on the register');
    const userIds = [...new Set(body.targets.flatMap((t) => t.evaluators.map((e) => e.userId)))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, isActive: true, name: true } });
    if (users.length !== userIds.length) throw badRequest('One of the evaluators has no login');
    for (const t of body.targets) {
      const emp = employees.find((e) => e.id === t.employeeId)!;
      const seen = new Set<string>();
      for (const e of t.evaluators) {
        if (seen.has(e.userId)) throw badRequest(`An evaluator is listed twice for ${nameOf(emp)}`);
        seen.add(e.userId);
        if (emp.userId && e.userId === emp.userId) throw badRequest(`${nameOf(emp)} cannot evaluate themself`);
        if (!users.find((u) => u.id === e.userId)?.isActive) throw badRequest('One of the evaluators is no longer active');
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.evaluationRunQuestion.deleteMany({ where: { runId: run.id } });
      await tx.evaluationRunTarget.deleteMany({ where: { runId: run.id } });
      await tx.evaluationRun.update({ where: { id: run.id }, data: { title: body.title, description: body.description || null, dueOn: body.dueOn ? new Date(`${body.dueOn}T00:00:00Z`) : null } });
      for (const [i, q] of body.questions.entries()) await tx.evaluationRunQuestion.create({ data: { runId: run.id, sequence: i + 1, kind: q.kind, prompt: q.prompt, weight: q.weight } });
      for (const t of body.targets) {
        await tx.evaluationRunTarget.create({
          data: { runId: run.id, employeeId: t.employeeId, assignments: { create: t.evaluators.map((e) => ({ evaluatorId: e.userId, role: e.role?.trim() || null })) } },
        });
      }
    });
    await audit({ entityType: DOC, entityId: run.id, action: 'UPDATED', summary: `${run.number}: ${body.questions.length} question(s), ${body.targets.length} people` }, req);
    res.json(presentRun(me, await loadRun(run.id)));
  }),
);

evaluationRunRoutes.post(
  '/:id/open',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    if (!run.questions.some((q) => q.kind === 'RATING')) throw badRequest('Add at least one rating question first');
    if (!run.targets.length) throw badRequest('Add the people to evaluate first');
    const lonely = run.targets.find((t) => !t.assignments.length);
    if (lonely) throw badRequest(`${nameOf(lonely.employee)} has no evaluator`);
    const claimed = await prisma.evaluationRun.updateMany({ where: { id: run.id, status: 'DRAFT' }, data: { status: 'OPEN', openedAt: new Date() } });
    if (!claimed.count) throw conflict('It is open already');
    for (const t of run.targets) {
      for (const a of t.assignments) {
        await notify({ userId: a.evaluator.id, type: 'system', title: `Evaluate ${nameOf(t.employee)} — ${run.title}`, body: `${run.number}${run.dueOn ? ` · by ${formatDate(run.dueOn)}` : ''}`, link: `${PATH}/answer/${a.id}` });
      }
    }
    await audit({ entityType: DOC, entityId: run.id, action: 'SUBMITTED', summary: `${run.number} opened — ${progressOf(run).asked} evaluator assignment(s) told` }, req);
    res.json(presentRun(me, await loadRun(run.id)));
  }),
);

evaluationRunRoutes.post(
  '/:id/remind',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    if (run.status !== 'OPEN') throw badRequest('Only an open evaluation is reminded');
    if (run.remindedAt && Date.now() - run.remindedAt.getTime() < 20 * 3600_000) throw conflict('Reminded already today');
    let told = 0;
    for (const t of run.targets) {
      for (const a of t.assignments.filter((x) => !x.submittedAt)) {
        await notify({ userId: a.evaluator.id, type: 'system', title: `Reminder: evaluate ${nameOf(t.employee)} — ${run.title}`, body: run.number, link: `${PATH}/answer/${a.id}` });
        told++;
      }
    }
    await prisma.evaluationRun.update({ where: { id: run.id }, data: { remindedAt: new Date() } });
    await audit({ entityType: DOC, entityId: run.id, action: 'UPDATED', summary: `${run.number}: reminded ${told} evaluator assignment(s)` }, req);
    res.json({ told });
  }),
);

const statusMove = (from: 'OPEN' | 'CLOSED', to: 'OPEN' | 'CLOSED', words: string) =>
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    if (to === 'OPEN' && run.releasedAt) throw badRequest('Its results are released — it stays closed');
    const done = await prisma.evaluationRun.updateMany({ where: { id: run.id, status: from }, data: { status: to, ...(to === 'CLOSED' ? { closedAt: new Date() } : { closedAt: null }) } });
    if (!done.count) throw conflict(`Only ${from === 'OPEN' ? 'an open' : 'a closed'} evaluation is ${words}`);
    await audit({ entityType: DOC, entityId: run.id, action: 'UPDATED', summary: `${run.number} ${words}` }, req);
    res.json(presentRun(me, await loadRun(run.id)));
  });

evaluationRunRoutes.post('/:id/close', requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'), statusMove('OPEN', 'CLOSED', 'closed'));
evaluationRunRoutes.post('/:id/reopen', requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'), statusMove('CLOSED', 'OPEN', 'reopened'));

/** The people evaluated may read their own result from now on — never who wrote what. */
evaluationRunRoutes.post(
  '/:id/release',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    const done = await prisma.evaluationRun.updateMany({ where: { id: run.id, status: 'CLOSED', releasedAt: null }, data: { releasedAt: new Date() } });
    if (!done.count) throw conflict('Only a closed evaluation is released, once');
    const people = await prisma.employee.findMany({ where: { id: { in: run.targets.map((t) => t.employee.id) }, userId: { not: null } }, select: { userId: true } });
    for (const p of people) await notify({ userId: p.userId!, type: 'system', title: `Your evaluation result — ${run.title}`, body: run.number, link: `${PATH}/result/${run.id}` });
    await audit({ entityType: DOC, entityId: run.id, action: 'UPDATED', summary: `${run.number}: results released to the people evaluated` }, req);
    res.json(presentRun(me, await loadRun(run.id)));
  }),
);

evaluationRunRoutes.delete(
  '/:id',
  requireAny('ghr.evaluation_runs.create', 'ghr.evaluation_runs.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    if (!mayEdit(me, run)) throw forbidden('That evaluation is someone else’s');
    if (run.status !== 'DRAFT') throw badRequest('Only a draft is deleted — an opened evaluation is a record');
    await prisma.evaluationRun.delete({ where: { id: run.id } });
    await audit({ entityType: DOC, entityId: run.id, action: 'DELETED', summary: `Deleted the draft ${run.number}` }, req);
    res.json({ ok: true });
  }),
);

// ── The report ───────────────────────────────────────────────────────────────

evaluationRunRoutes.get(
  '/:id/report',
  requireAny('ghr.evaluation_runs.view_all'),
  handler(async (req, res) => {
    const run = await loadRun(req.params.id);
    res.json({ run: { id: run.id, number: run.number, title: run.title, status: run.status }, ...runReport(run, { names: true }) });
  }),
);

evaluationRunRoutes.get(
  '/:id/report.csv',
  requireAny('ghr.evaluation_runs.view_all'),
  handler(async (req, res) => {
    const run = await loadRun(req.params.id);
    const r = runReport(run, { names: true });
    const ratingQs = r.questions.filter((q) => q.kind === 'RATING');
    const rows: (string | number | null)[][] = [
      ['Rank', 'Name', 'Employee no.', 'Position', 'Team', 'Answered', 'Asked', 'Overall (1-5)', ...ratingQs.map((q) => q.prompt)],
      ...r.ranked.map((p, i) => [i + 1, p.name, p.employeeNo, p.position, p.team, p.answered, p.asked, p.overall, ...p.perQuestion.map((x) => x.average)]),
    ];
    await audit({ entityType: DOC, entityId: run.id, action: 'EXPORTED', summary: `${run.number} report exported (CSV)` }, req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${run.number} report.csv"`);
    res.send(toCsv(rows));
  }),
);

evaluationRunRoutes.get(
  '/:id/report.pdf',
  requireAny('ghr.evaluation_runs.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    const r = runReport(run, { names: true });
    const ratingQs = r.questions.filter((q) => q.kind === 'RATING');
    const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));
    const pdf = await renderDocument({
      title: 'Evaluation Report',
      documentNumber: run.number,
      date: new Date(),
      reference: run.title,
      landscape: ratingQs.length > 4,
      sections: [
        {
          kind: 'fields',
          columns: 2,
          fields: [
            { label: 'Evaluation', value: run.title },
            { label: 'Status', value: run.status === 'OPEN' ? 'Open — answers still coming' : run.status === 'CLOSED' ? 'Closed' : 'Draft' },
            { label: 'Answered', value: `${r.progress.answered} of ${r.progress.asked} evaluator assignments` },
            { label: 'Scale', value: '1 (poor) to 5 (excellent); overall is weighted by each question' },
          ],
        },
        {
          kind: 'table',
          title: 'Ranking',
          head: ['Rank', 'Name', 'Position', 'Answered', 'Overall', ...ratingQs.map((_, i) => `Q${i + 1}`)],
          rows: r.ranked.map((p, i) => [String(i + 1), p.name, p.position ?? '—', `${p.answered}/${p.asked}`, fmt(p.overall), ...p.perQuestion.map((x) => fmt(x.average))]),
        },
        { kind: 'table', title: 'Questions', head: ['No.', 'Question', 'Weight'], rows: ratingQs.map((q, i) => [`Q${i + 1}`, q.prompt, String(q.weight)]) },
        ...r.people
          .filter((p) => p.comments.some((c) => c.answers.length))
          .map((p) => ({
            kind: 'text' as const,
            title: `Comments — ${p.name}`,
            body: p.comments
              .filter((c) => c.answers.length)
              .map((c) => `${c.prompt}\n${c.answers.map((a) => `• ${a.by}: ${a.text}`).join('\n')}`)
              .join('\n\n'),
          })),
      ],
      signatories: [{ role: 'Prepared by', name: me.name, at: new Date() }],
    });
    await audit({ entityType: DOC, entityId: run.id, action: 'EXPORTED', summary: `${run.number} report printed` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Evaluation Report', number: run.number, author: me.name, date: new Date() })));
    res.send(pdf);
  }),
);

/** The person evaluated reads their own result, once released — the averages and comments, never names. */
evaluationRunRoutes.get(
  '/:id/my-result',
  handler(async (req, res) => {
    const me = currentUser(req);
    const run = await loadRun(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { userId: me.id }, select: { id: true } });
    const target = employee ? run.targets.find((t) => t.employee.id === employee.id) : undefined;
    if (!target || !run.releasedAt) throw notFound('No released result for you in this evaluation');
    const r = runReport({ ...run, targets: [target] }, { names: false });
    res.json({ run: { id: run.id, number: run.number, title: run.title, releasedAt: run.releasedAt }, questions: r.questions, person: r.people[0] });
  }),
);

// ── The evaluator's own assignment ───────────────────────────────────────────

async function loadAssignment(me: ResolvedUser, id: string) {
  const a = await prisma.evaluationRunAssignment.findUnique({
    where: { id },
    include: {
      answers: true,
      target: { include: { employee: { select: personSelect }, run: { include: { questions: { orderBy: { sequence: 'asc' } } } } } },
    },
  });
  // Only the evaluator opens it (HR reads the report instead).
  if (!a || a.evaluatorId !== me.id) throw notFound('Evaluation not found');
  return a;
}

evaluationRunRoutes.get(
  '/assignments/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const a = await loadAssignment(me, req.params.id);
    const run = a.target.run;
    res.json({
      id: a.id,
      run: { id: run.id, number: run.number, title: run.title, description: run.description, dueOn: run.dueOn, status: run.status },
      person: { name: nameOf(a.target.employee), employeeNo: a.target.employee.employeeNo, position: a.target.employee.position, team: a.target.employee.industry?.code ?? null },
      role: a.role,
      submittedAt: a.submittedAt,
      canAnswer: run.status === 'OPEN' && !a.submittedAt,
      questions: run.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt })),
      answers: a.answers.map((x) => ({ questionId: x.questionId, rating: x.rating, comment: x.comment })),
    });
  }),
);

evaluationRunRoutes.put(
  '/assignments/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        answers: z.array(z.object({ questionId: z.string().min(1), rating: z.number().int().min(1).max(5).nullable().optional(), comment: z.string().max(4000).nullable().optional() })).max(60),
        submit: z.boolean().optional(),
      }),
      req.body,
    );
    const a = await loadAssignment(me, req.params.id);
    if (a.target.run.status !== 'OPEN') throw badRequest('This evaluation is closed');
    if (a.submittedAt) throw conflict('You submitted this evaluation already');
    const qs = new Map(a.target.run.questions.map((q) => [q.id, q]));
    for (const x of body.answers) if (!qs.has(x.questionId)) throw badRequest('That question is not in this evaluation');
    await prisma.$transaction(async (tx) => {
      for (const x of body.answers) {
        const q = qs.get(x.questionId)!;
        const data = q.kind === 'RATING' ? { rating: x.rating ?? null, comment: null } : { rating: null, comment: x.comment?.trim() || null };
        await tx.evaluationRunAnswer.upsert({ where: { assignmentId_questionId: { assignmentId: a.id, questionId: q.id } }, create: { assignmentId: a.id, questionId: q.id, ...data }, update: data });
      }
    });
    if (body.submit) {
      const answers = await prisma.evaluationRunAnswer.findMany({ where: { assignmentId: a.id } });
      const missing = a.target.run.questions.filter((q) => q.kind === 'RATING' && answers.find((x) => x.questionId === q.id)?.rating == null);
      if (missing.length) throw badRequest(`Rate every question first — ${missing.length} left`);
      const done = await prisma.evaluationRunAssignment.updateMany({ where: { id: a.id, submittedAt: null }, data: { submittedAt: new Date() } });
      if (!done.count) throw conflict('You submitted this evaluation already');
      // The ratings stay between the evaluator and HR: the trail says it was answered, never how.
      await audit({ entityType: DOC, entityId: a.target.run.id, action: 'UPDATED', summary: `${a.target.run.number}: an evaluation of ${nameOf(a.target.employee)} was submitted` }, req);
    }
    res.json({ ok: true, submitted: !!body.submit });
  }),
);

/** My Work: the evaluations the caller still has to answer. */
export async function evaluationRunWork(me: ResolvedUser) {
  const rows = await prisma.evaluationRunAssignment.findMany({
    where: { evaluatorId: me.id, submittedAt: null, target: { run: { status: 'OPEN' } } },
    include: { target: { include: { employee: { select: { firstName: true, lastName: true } }, run: { select: { number: true, title: true, dueOn: true, openedAt: true } } } } },
    take: 20,
  });
  const today = todayKey();
  return rows.map((a) => ({
    id: a.id,
    kind: DOC,
    title: `Evaluate ${nameOf(a.target.employee)}`,
    subtitle: `${a.target.run.number} · ${a.target.run.title}${a.target.run.dueOn ? ` — by ${formatDate(a.target.run.dueOn)}` : ''}`,
    when: a.target.run.openedAt ?? undefined,
    overdue: !!a.target.run.dueOn && a.target.run.dueOn.toISOString().slice(0, 10) < today,
    link: `${PATH}/answer/${a.id}`,
  }));
}
