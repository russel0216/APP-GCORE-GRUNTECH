import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Prisma, type ExamSittingStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { authenticate, currentUser, requireAny } from '../auth/middleware';
import { handler, parseBody, notFound, badRequest, conflict, forbidden, HttpError } from '../http/kit';
import { can, type ResolvedUser } from '../permissions/resolve';
import { requireEdit } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { throttled } from '../shared/throttle';
import { manilaDate } from '../shared/day';
import { env } from '../env';
import { loadCandidate, mayEditCandidate } from './hiring';

/**
 * The Employment Examination online (2026-11-13, the owner's call: "rename
 * entrance exam to Employment Examination; HR can add or modify questions; an
 * applicant can be issued a link or QR to answer on their phone or another
 * device — they have no access to G-CORE, so an outside link or QR fits best").
 * His answers: multiple choice (scored at once) and written answers (scored
 * by HR); timed, one sitting; one link covers every exam HR ticks, taken one
 * after another.
 *
 *   HR      /api/hiring/exams/:id/questions          the questions, replaced whole
 *           /api/hiring/candidates/:id/exam-link     issue a link for ticked exams
 *           /api/hiring/candidates/:id/sittings      the sittings and answers
 *           /api/hiring/sittings/:id/score           HR's points for written answers
 *           /api/hiring/sittings/:id/cancel
 *   public  POST /api/public/exam/{view,start,answers,submit} { token }   no login; the token is the key
 *
 * The token is 32 random bytes, sent once in the link's #fragment (never sent
 * to a server, never in a log — the account links' rule) and posted in the
 * request body; only its SHA-256 is kept. A sitting opens until `expiresAt` (7 days), runs one countdown — the
 * ticked exams' minutes together — from Start, and is submitted by the
 * applicant or, when the time is up, with what was saved (`sweep`). The
 * correct answers never leave the server. Once every answer is scored the
 * exam scores are written to the candidate (`ExamResult`), each out of the
 * exam's own maximum, the same scores HR types by hand.
 */

export const examQuestionRoutes = Router();
examQuestionRoutes.use(authenticate);
export const publicExamRoutes = Router();

const LINK_DAYS = 7;
/** A submission arriving this long after the deadline still counts (the phone's clock, the network). */
const GRACE_MS = 30_000;

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const dayKey = () => manilaDate(new Date()).toISOString().slice(0, 10);

// ── HR: the questions ────────────────────────────────────────────────────────

const EXAM_READERS = ['ghr.entrance_exams.view_all', 'ghr.entrance_exams.view_team', 'ghr.entrance_exams.view_own', 'ghr.candidates.view_all', 'ghr.candidates.view_team', 'ghr.candidates.view_own'] as const;

function presentQuestion(q: { id: string; sequence: number; kind: string; prompt: string; choices: string[]; correctIndex: number | null; points: Prisma.Decimal; isActive: boolean }) {
  return { id: q.id, sequence: q.sequence, kind: q.kind, prompt: q.prompt, choices: q.choices, correctIndex: q.correctIndex, points: num(q.points), isActive: q.isActive };
}

examQuestionRoutes.get(
  '/exams/:id/questions',
  requireAny(...EXAM_READERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const exam = await prisma.examCatalog.findUnique({
      where: { id: req.params.id },
      include: { questions: { orderBy: [{ isActive: 'desc' }, { sequence: 'asc' }], include: { _count: { select: { answers: true } } } } },
    });
    if (!exam) throw notFound('Exam not found');
    const active = exam.questions.filter((q) => q.isActive);
    res.json({
      id: exam.id,
      name: exam.name,
      description: exam.description,
      maxScore: exam.maxScore,
      timeLimitMinutes: exam.timeLimitMinutes,
      isActive: exam.isActive,
      totalPoints: active.reduce((s, q) => s + num(q.points), 0),
      canEdit: !!(can(me, 'ghr.entrance_exams.edit_all') || can(me, 'ghr.entrance_exams.edit_own') || can(me, 'ghr.entrance_exams.edit_team')),
      questions: exam.questions.map((q) => ({ ...presentQuestion(q), answered: q._count.answers })),
    });
  }),
);

const questionSchema = z
  .object({
    id: z.string().optional(),
    kind: z.enum(['CHOICE', 'WRITTEN']),
    prompt: z.string().trim().min(3, 'Write the question').max(4000),
    choices: z.array(z.string().trim().min(1, 'A choice cannot be empty').max(500)).max(10).default([]),
    correctIndex: z.number().int().min(0).nullable().optional(),
    points: z.number().positive().max(1000).default(1),
  })
  .superRefine((q, ctx) => {
    if (q.kind === 'CHOICE') {
      if (q.choices.length < 2) ctx.addIssue({ code: 'custom', path: ['choices'], message: 'A multiple-choice question needs at least two choices' });
      if (q.correctIndex == null || q.correctIndex >= q.choices.length) ctx.addIssue({ code: 'custom', path: ['correctIndex'], message: 'Mark the correct choice' });
    }
  });

/**
 * The exam's questions, replaced whole, in the order sent, and its time limit.
 * A question sent with its id is changed in place; one left out is deleted —
 * or, once anyone answered it, switched off so the answers keep their question.
 */
examQuestionRoutes.put(
  '/exams/:id/questions',
  requireEdit('ghr', 'entrance_exams'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ timeLimitMinutes: z.number().int().min(1).max(600).optional(), questions: z.array(questionSchema).max(200) }), req.body);
    const exam = await prisma.examCatalog.findUnique({ where: { id: req.params.id }, include: { questions: { include: { _count: { select: { answers: true } } } } } });
    if (!exam) throw notFound('Exam not found');
    const mine = new Map(exam.questions.map((q) => [q.id, q]));
    for (const q of body.questions) if (q.id && !mine.has(q.id)) throw badRequest('One of the questions is not on this exam');
    const kept = new Set(body.questions.map((q) => q.id).filter((x): x is string => !!x));
    await prisma.$transaction(async (tx) => {
      for (const q of exam.questions) {
        if (kept.has(q.id)) continue;
        if (q._count.answers) await tx.examQuestion.update({ where: { id: q.id }, data: { isActive: false } });
        else await tx.examQuestion.delete({ where: { id: q.id } });
      }
      for (const [i, q] of body.questions.entries()) {
        const data = {
          sequence: i + 1,
          kind: q.kind,
          prompt: q.prompt,
          choices: q.kind === 'CHOICE' ? q.choices : [],
          correctIndex: q.kind === 'CHOICE' ? q.correctIndex ?? null : null,
          points: q.points,
          isActive: true,
        };
        if (q.id) await tx.examQuestion.update({ where: { id: q.id }, data });
        else await tx.examQuestion.create({ data: { ...data, examId: exam.id } });
      }
      if (body.timeLimitMinutes) await tx.examCatalog.update({ where: { id: exam.id }, data: { timeLimitMinutes: body.timeLimitMinutes } });
    });
    await audit({ entityType: 'entrance_exam', entityId: exam.id, action: 'UPDATED', summary: `Questions of ${exam.name}: ${body.questions.length} in use${body.timeLimitMinutes ? `, ${body.timeLimitMinutes} minutes` : ''}` }, req);
    res.json({ ok: true });
  }),
);

// ── HR: issuing a link, reading and scoring sittings ─────────────────────────

/** The link the applicant opens. */
export const examLink = (token: string) => `${env.appUrl.replace(/\/+$/, '')}/exam#t=${token}`;

examQuestionRoutes.post(
  '/candidates/:id/exam-link',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ examIds: z.array(z.string().min(1)).min(1, 'Tick at least one exam').max(20) }), req.body);
    const candidate = await loadCandidate(me, req.params.id);
    if (!mayEditCandidate(me, candidate)) throw forbidden('That candidate is someone else’s');
    if (['HIRED', 'DECLINED', 'WITHDRAWN', 'INTERVIEW_FAILED'].includes(candidate.status)) throw badRequest('This applicant is no longer in the running');
    const ids = [...new Set(body.examIds)];
    const exams = await prisma.examCatalog.findMany({ where: { id: { in: ids } }, include: { questions: { where: { isActive: true }, select: { id: true } } } });
    if (exams.length !== ids.length) throw badRequest('One of the exams is not on the catalogue');
    for (const e of exams) {
      if (!e.isActive) throw badRequest(`${e.name} is switched off`);
      if (!e.questions.length) throw badRequest(`${e.name} has no questions yet — add them on the exam's page first`);
    }
    const ordered = ids.map((id) => exams.find((e) => e.id === id)!);
    const token = crypto.randomBytes(32).toString('base64url');
    const sitting = await prisma.examSitting.create({
      data: {
        candidateId: candidate.id,
        tokenHash: hashOf(token),
        examIds: ordered.map((e) => e.id),
        minutes: ordered.reduce((s, e) => s + e.timeLimitMinutes, 0),
        issuedById: me.id,
        expiresAt: new Date(Date.now() + LINK_DAYS * 86_400_000),
      },
    });
    await audit({ entityType: 'candidate', entityId: candidate.id, action: 'UPDATED', summary: `Issued an online exam link (${ordered.map((e) => e.name).join(', ')}) — open ${LINK_DAYS} days` }, req);
    // The token is shown this once; only its hash is kept.
    res.status(201).json({ id: sitting.id, url: examLink(token), expiresAt: sitting.expiresAt, minutes: sitting.minutes, exams: ordered.map((e) => e.name) });
  }),
);

/** Closes what time has closed: an unopened link past its day, a started sitting past its deadline. */
async function sweep(where: Prisma.ExamSittingWhereInput) {
  const now = new Date();
  await prisma.examSitting.updateMany({ where: { ...where, status: 'ISSUED', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } });
  const overdue = await prisma.examSitting.findMany({ where: { ...where, status: 'STARTED', deadlineAt: { lt: new Date(now.getTime() - GRACE_MS) } }, select: { id: true } });
  for (const s of overdue) await finalize(s.id);
}

/**
 * The sitting closed: STARTED → SUBMITTED (claimed, once), every choice
 * scored against its correct answer, a question left blank scored 0; with no
 * written answer to wait for it is SCORED at once and the scores written.
 */
async function finalize(sittingId: string) {
  const claimed = await prisma.examSitting.updateMany({ where: { id: sittingId, status: 'STARTED' }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
  if (!claimed.count) return;
  const sitting = await prisma.examSitting.findUniqueOrThrow({ where: { id: sittingId }, include: { answers: true } });
  const questions = await prisma.examQuestion.findMany({ where: { id: { in: sitting.questionIds } } });
  const answerOf = new Map(sitting.answers.map((a) => [a.questionId, a]));
  await prisma.$transaction(async (tx) => {
    for (const q of questions) {
      const a = answerOf.get(q.id);
      const blankAnswer = !a || (q.kind === 'CHOICE' ? a.choiceIndex == null : !(a.text ?? '').trim());
      // A choice is scored now; a blank written answer is 0; a written answer waits for HR.
      const points = q.kind === 'CHOICE' ? (a && a.choiceIndex === q.correctIndex ? num(q.points) : 0) : blankAnswer ? 0 : null;
      await tx.examAnswer.upsert({
        where: { sittingId_questionId: { sittingId, questionId: q.id } },
        create: { sittingId, questionId: q.id, choiceIndex: a?.choiceIndex ?? null, text: a?.text ?? null, points },
        update: { points },
      });
    }
  });
  await audit({ entityType: 'candidate', entityId: sitting.candidateId, action: 'UPDATED', summary: 'Submitted an online employment examination', actorName: 'applicant' });
  await scoreIfDone(sittingId, null);
}

/** Every answer scored: the sitting SCORED, each exam's score written to the candidate, out of its maximum. */
async function scoreIfDone(sittingId: string, actorId: string | null) {
  const sitting = await prisma.examSitting.findUniqueOrThrow({ where: { id: sittingId }, include: { answers: { include: { question: true } } } });
  if (sitting.status !== 'SUBMITTED' || sitting.answers.some((a) => a.points == null)) return false;
  const exams = await prisma.examCatalog.findMany({ where: { id: { in: sitting.examIds } } });
  await prisma.$transaction(async (tx) => {
    const done = await tx.examSitting.updateMany({ where: { id: sitting.id, status: 'SUBMITTED' }, data: { status: 'SCORED', scoredAt: new Date() } });
    if (!done.count) return;
    for (const e of exams) {
      const mine = sitting.answers.filter((a) => a.question.examId === e.id);
      const possible = mine.reduce((s, a) => s + num(a.question.points), 0);
      const earned = mine.reduce((s, a) => s + num(a.points), 0);
      const score = possible > 0 ? Math.round((earned / possible) * e.maxScore * 100) / 100 : 0;
      const data = { score, takenOn: new Date(`${(sitting.submittedAt ?? new Date()).toISOString().slice(0, 10)}T00:00:00Z`), examinerId: actorId ?? sitting.issuedById, notes: `Taken online — ${earned} of ${possible} points` };
      await tx.examResult.upsert({ where: { candidateId_examId: { candidateId: sitting.candidateId, examId: e.id } }, create: { candidateId: sitting.candidateId, examId: e.id, ...data }, update: data });
    }
  });
  return true;
}

const SITTING_WORDS: Record<ExamSittingStatus, string> = {
  ISSUED: 'Link sent — not started',
  STARTED: 'Answering now',
  SUBMITTED: 'Submitted — written answers to score',
  SCORED: 'Scored',
  EXPIRED: 'Link expired unused',
  CANCELLED: 'Cancelled',
};

examQuestionRoutes.get(
  '/candidates/:id/sittings',
  requireAny('ghr.candidates.view_all', 'ghr.candidates.view_team', 'ghr.candidates.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const candidate = await loadCandidate(me, req.params.id);
    await sweep({ candidateId: candidate.id });
    const sittings = await prisma.examSitting.findMany({
      where: { candidateId: candidate.id },
      orderBy: { issuedAt: 'desc' },
      include: { issuedBy: { select: { name: true } }, answers: { include: { question: { include: { exam: { select: { name: true } } } } } } },
    });
    const examNames = new Map((await prisma.examCatalog.findMany({ where: { id: { in: sittings.flatMap((s) => s.examIds) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    const editor = mayEditCandidate(me, candidate);
    res.json({
      canIssue: editor,
      rows: sittings.map((s) => ({
        id: s.id,
        status: s.status,
        statusLabel: SITTING_WORDS[s.status],
        exams: s.examIds.map((id) => examNames.get(id) ?? 'an exam'),
        minutes: s.minutes,
        issuedAt: s.issuedAt,
        issuedBy: s.issuedBy?.name ?? null,
        expiresAt: s.expiresAt,
        startedAt: s.startedAt,
        submittedAt: s.submittedAt,
        scoredAt: s.scoredAt,
        canCancel: editor && (s.status === 'ISSUED' || s.status === 'STARTED'),
        canScore: editor && s.status === 'SUBMITTED',
        // The written answers, for HR to score; a choice shows only whether it was right.
        answers: s.answers
          .sort((a, b) => s.questionIds.indexOf(a.questionId) - s.questionIds.indexOf(b.questionId))
          .map((a) => ({
            id: a.id,
            exam: a.question.exam.name,
            kind: a.question.kind,
            prompt: a.question.prompt,
            maxPoints: num(a.question.points),
            text: a.question.kind === 'WRITTEN' ? a.text : null,
            chosen: a.question.kind === 'CHOICE' && a.choiceIndex != null ? a.question.choices[a.choiceIndex] ?? null : null,
            correct: a.question.kind === 'CHOICE' ? a.question.choices[a.question.correctIndex ?? -1] ?? null : null,
            points: a.points == null ? null : num(a.points),
          })),
      })),
    });
  }),
);

examQuestionRoutes.post(
  '/sittings/:id/score',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ answers: z.array(z.object({ id: z.string().min(1), points: z.number().min(0).max(1000) })).min(1).max(200) }), req.body);
    const sitting = await prisma.examSitting.findUnique({ where: { id: req.params.id }, include: { answers: { include: { question: true } } } });
    if (!sitting) throw notFound('Sitting not found');
    const candidate = await loadCandidate(me, sitting.candidateId);
    if (!mayEditCandidate(me, candidate)) throw forbidden('That candidate is someone else’s');
    if (sitting.status !== 'SUBMITTED') throw badRequest(sitting.status === 'SCORED' ? 'This sitting is scored already' : 'Only a submitted sitting is scored');
    const byId = new Map(sitting.answers.map((a) => [a.id, a]));
    for (const a of body.answers) {
      const row = byId.get(a.id);
      if (!row) throw badRequest('That answer is not in this sitting');
      if (row.question.kind !== 'WRITTEN') throw badRequest('A multiple-choice answer is scored by its key');
      if (a.points > num(row.question.points)) throw badRequest(`That question is worth ${num(row.question.points)} points at most`);
    }
    await prisma.$transaction(async (tx) => {
      for (const a of body.answers) await tx.examAnswer.update({ where: { id: a.id }, data: { points: a.points, scoredById: me.id } });
    });
    const done = await scoreIfDone(sitting.id, me.id);
    // The scores are between HR and the applicant: the trail says what moved, never the figures.
    await audit({ entityType: 'candidate', entityId: sitting.candidateId, action: 'UPDATED', summary: done ? 'Scored the online employment examination — the scores are recorded' : 'Scored written answers of the online employment examination' }, req);
    res.json({ ok: true, scored: done });
  }),
);

examQuestionRoutes.post(
  '/sittings/:id/cancel',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const sitting = await prisma.examSitting.findUnique({ where: { id: req.params.id } });
    if (!sitting) throw notFound('Sitting not found');
    const candidate = await loadCandidate(me, sitting.candidateId);
    if (!mayEditCandidate(me, candidate)) throw forbidden('That candidate is someone else’s');
    const done = await prisma.examSitting.updateMany({ where: { id: sitting.id, status: { in: ['ISSUED', 'STARTED'] } }, data: { status: 'CANCELLED' } });
    if (!done.count) throw conflict('Only a link not yet submitted is cancelled');
    await audit({ entityType: 'candidate', entityId: sitting.candidateId, action: 'UPDATED', summary: 'Cancelled an online exam link' }, req);
    res.json({ ok: true });
  }),
);

// ── Public: the applicant's page (no login) ──────────────────────────────────

/** Sixty requests a minute from one address, and every miss counted: a token cannot be guessed by brute force. */
/**
 * Who is asking: behind the Cloudflare tunnel every request reaches the API
 * from the tunnel itself, so the visitor is Cloudflare's header (else the
 * forwarded-for, else the socket) — the audit trail's own reading.
 */
function visitorOf(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function brake(req: Request) {
  const ip = visitorOf(req);
  if (throttled(`public-exam:${ip}`, 60, 60_000)) throw new HttpError(429, 'Too many requests — wait a minute and try again');
}

async function sittingByToken(req: Request) {
  brake(req);
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token.length < 20 || token.length > 100) throw notFound('This exam link is not valid');
  const where = { tokenHash: hashOf(token) };
  await sweep(where);
  const sitting = await prisma.examSitting.findUnique({ where, include: { candidate: { select: { firstName: true, lastName: true, mpr: { select: { title: true } } } } } });
  if (!sitting) {
    // A wrong token costs more than a right one, so guessing gets nowhere.
    if (throttled(`public-exam-miss:${visitorOf(req)}`, 10, 60 * 60_000)) throw new HttpError(429, 'Too many wrong links — try again later');
    throw notFound('This exam link is not valid');
  }
  return sitting;
}

async function companyName(): Promise<string> {
  const row = await prisma.company.findUnique({ where: { id: 'company' }, select: { name: true, legalName: true } });
  return row?.legalName || row?.name || 'G-CORE';
}

/** The paper: the questions in order, grouped by exam — NEVER the correct answers. */
async function paperOf(sitting: { examIds: string[]; questionIds: string[]; id: string }) {
  const [exams, questions, answers] = await Promise.all([
    prisma.examCatalog.findMany({ where: { id: { in: sitting.examIds } }, select: { id: true, name: true, description: true } }),
    prisma.examQuestion.findMany({ where: { id: { in: sitting.questionIds } }, select: { id: true, examId: true, kind: true, prompt: true, choices: true, points: true } }),
    prisma.examAnswer.findMany({ where: { sittingId: sitting.id }, select: { questionId: true, choiceIndex: true, text: true } }),
  ]);
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    exams: sitting.examIds.map((id) => {
      const e = exams.find((x) => x.id === id);
      return {
        id,
        name: e?.name ?? 'Exam',
        description: e?.description ?? null,
        questions: sitting.questionIds
          .map((qid) => byId.get(qid))
          .filter((q): q is NonNullable<typeof q> => !!q && q.examId === id)
          .map((q) => ({ id: q.id, kind: q.kind, prompt: q.prompt, choices: q.choices, points: num(q.points) })),
      };
    }),
    answers: answers.map((a) => ({ questionId: a.questionId, choiceIndex: a.choiceIndex, text: a.text })),
  };
}

publicExamRoutes.post(
  '/view',
  handler(async (req, res) => {
    const s = await sittingByToken(req);
    const exams = await prisma.examCatalog.findMany({ where: { id: { in: s.examIds } }, select: { id: true, name: true, _count: { select: { questions: { where: { isActive: true } } } } } });
    const live = s.status === 'STARTED' && s.deadlineAt && s.deadlineAt.getTime() > Date.now();
    res.json({
      company: await companyName(),
      name: `${s.candidate.firstName} ${s.candidate.lastName}`.trim(),
      position: s.candidate.mpr.title,
      status: s.status,
      minutes: s.minutes,
      expiresAt: s.expiresAt,
      deadlineAt: s.deadlineAt,
      now: new Date(),
      exams: s.examIds.map((id) => {
        const e = exams.find((x) => x.id === id);
        return { name: e?.name ?? 'Exam', questions: e?._count.questions ?? 0 };
      }),
      // Reloading the page mid-sitting comes back to the paper and what was saved.
      ...(live ? { paper: await paperOf(s) } : {}),
    });
  }),
);

publicExamRoutes.post(
  '/start',
  handler(async (req, res) => {
    const s = await sittingByToken(req);
    if (s.status !== 'ISSUED') throw conflict(s.status === 'STARTED' ? 'This exam is already open' : 'This exam link can no longer be used');
    const questions = await prisma.examQuestion.findMany({ where: { examId: { in: s.examIds }, isActive: true }, orderBy: [{ sequence: 'asc' }], select: { id: true, examId: true } });
    const ordered = s.examIds.flatMap((eid) => questions.filter((q) => q.examId === eid).map((q) => q.id));
    if (!ordered.length) throw badRequest('This exam has no questions — tell HR');
    const now = new Date();
    const claimed = await prisma.examSitting.updateMany({
      where: { id: s.id, status: 'ISSUED' },
      data: { status: 'STARTED', startedAt: now, deadlineAt: new Date(now.getTime() + s.minutes * 60_000), questionIds: ordered },
    });
    if (!claimed.count) throw conflict('This exam was opened a moment ago');
    const started = await prisma.examSitting.findUniqueOrThrow({ where: { id: s.id } });
    res.json({ status: started.status, deadlineAt: started.deadlineAt, now: new Date(), paper: await paperOf(started) });
  }),
);

const answersSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), choiceIndex: z.number().int().min(0).max(20).nullable().optional(), text: z.string().max(10000).nullable().optional() })).max(300),
});

/** Saves answers while the sitting runs — the page saves as the applicant goes, so the time running out loses nothing. */
async function saveAnswers(sittingId: string, questionIds: string[], answers: z.infer<typeof answersSchema>['answers']) {
  const allowed = new Set(questionIds);
  const choicesOf = new Map((await prisma.examQuestion.findMany({ where: { id: { in: questionIds } }, select: { id: true, kind: true, choices: true } })).map((q) => [q.id, q]));
  await prisma.$transaction(async (tx) => {
    for (const a of answers) {
      if (!allowed.has(a.questionId)) continue;
      const q = choicesOf.get(a.questionId)!;
      const choiceIndex = q.kind === 'CHOICE' && a.choiceIndex != null && a.choiceIndex < q.choices.length ? a.choiceIndex : null;
      const text = q.kind === 'WRITTEN' ? (a.text ?? '').slice(0, 10000) : null;
      await tx.examAnswer.upsert({
        where: { sittingId_questionId: { sittingId, questionId: a.questionId } },
        create: { sittingId, questionId: a.questionId, choiceIndex, text },
        update: { choiceIndex, text },
      });
    }
  });
}

function runningOrRefuse(s: { status: string; deadlineAt: Date | null }) {
  if (s.status !== 'STARTED' || !s.deadlineAt) throw conflict('This exam is closed');
  if (Date.now() > s.deadlineAt.getTime() + GRACE_MS) throw conflict('The time is up — your saved answers were submitted');
}

publicExamRoutes.post(
  '/answers',
  handler(async (req, res) => {
    const s = await sittingByToken(req);
    runningOrRefuse(s);
    const body = parseBody(answersSchema, { answers: req.body?.answers ?? [] });
    await saveAnswers(s.id, s.questionIds, body.answers);
    res.json({ ok: true, savedAt: new Date() });
  }),
);

publicExamRoutes.post(
  '/submit',
  handler(async (req, res) => {
    const s = await sittingByToken(req);
    if (s.status === 'SUBMITTED' || s.status === 'SCORED') {
      res.json({ status: s.status });
      return;
    }
    runningOrRefuse(s);
    const body = parseBody(answersSchema, { answers: req.body?.answers ?? [] });
    await saveAnswers(s.id, s.questionIds, body.answers);
    await finalize(s.id);
    const after = await prisma.examSitting.findUniqueOrThrow({ where: { id: s.id }, select: { status: true } });
    res.json({ status: after.status });
  }),
);

/** For a verify script: the link of a fresh sitting is shown once; this is how a script reads its own token's sitting. */
export const __forTests = { hashOf, finalize, sweep, dayKey };
export type { ResolvedUser };
