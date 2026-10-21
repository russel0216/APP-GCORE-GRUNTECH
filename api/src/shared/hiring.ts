import { prisma } from '../prisma';

/**
 * G-HR › Hiring (2026-10-21, the owner's Hiring module): the rules the
 * routes, the screens and the verify script share.
 */

/** The entrance exams on the owner's sheet, seeded as system rows. */
export const ENTRANCE_EXAMS = ['Abstract Reasoning', 'Basic Math & Logic', 'Technical / Mechanical', 'Communication & Verbs'] as const;

/** Seeds the catalogue; an exam already on file keeps its name, score and weight. */
export async function seedEntranceExams(): Promise<number> {
  let created = 0;
  for (const [i, name] of ENTRANCE_EXAMS.entries()) {
    const existing = await prisma.examCatalog.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) continue;
    await prisma.examCatalog.create({ data: { name, sortOrder: i + 1, isSystem: true } });
    created++;
  }
  return created;
}

/** The candidate's moves, in the pipeline's order (the PDF's chips). */
export const CANDIDATE_FLOW = [
  'APPLIED',
  'UNDER_SCREENING',
  'EXAM_SCHEDULED',
  'EXAM_DONE',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_PASSED',
  'INTERVIEW_FAILED',
  'CONTRACT_STAGE',
  'HIRED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type CandidateStatusKey = (typeof CANDIDATE_FLOW)[number];

/** Where a candidate stands for good: hired, or out of the running. */
export const CANDIDATE_CLOSED: CandidateStatusKey[] = ['HIRED', 'DECLINED', 'WITHDRAWN'];

/**
 * The moves HR may make by hand. HIRED is never one: only the hire (an
 * employee record made from a signed contract) sets it. CONTRACT_STAGE
 * follows a passed interview; a contract may be prepared from it.
 */
export function nextStatuses(from: CandidateStatusKey): CandidateStatusKey[] {
  switch (from) {
    case 'APPLIED':
      return ['UNDER_SCREENING', 'DECLINED', 'WITHDRAWN'];
    case 'UNDER_SCREENING':
      return ['EXAM_SCHEDULED', 'INTERVIEW_SCHEDULED', 'DECLINED', 'WITHDRAWN'];
    case 'EXAM_SCHEDULED':
      return ['EXAM_DONE', 'DECLINED', 'WITHDRAWN'];
    case 'EXAM_DONE':
      return ['INTERVIEW_SCHEDULED', 'DECLINED', 'WITHDRAWN'];
    case 'INTERVIEW_SCHEDULED':
      return ['INTERVIEW_PASSED', 'INTERVIEW_FAILED', 'WITHDRAWN'];
    case 'INTERVIEW_PASSED':
      return ['CONTRACT_STAGE', 'DECLINED', 'WITHDRAWN'];
    case 'INTERVIEW_FAILED':
      return ['INTERVIEW_SCHEDULED', 'DECLINED'];
    case 'CONTRACT_STAGE':
      return ['DECLINED', 'WITHDRAWN'];
    case 'DECLINED':
    case 'WITHDRAWN':
      // Back into the running at screening — a second look is a real thing.
      return ['UNDER_SCREENING'];
    default:
      return [];
  }
}

export interface ScoreInput {
  score: number;
  maxScore: number;
  weight: number;
}

/**
 * The candidate's exam score: the WEIGHTED percentage of the exams they sat —
 * each exam's score over its maximum, weighed by the exam's weight — to one
 * decimal; null when they sat none. An exam not sat counts for nothing either
 * way: the score says how they did on what they took.
 */
export function weightedScore(results: ScoreInput[]): number | null {
  const sat = results.filter((r) => r.maxScore > 0 && r.weight > 0);
  if (!sat.length) return null;
  const weights = sat.reduce((a, r) => a + r.weight, 0);
  const pct = sat.reduce((a, r) => a + (Math.min(r.score, r.maxScore) / r.maxScore) * 100 * r.weight, 0) / weights;
  return Math.round(pct * 10) / 10;
}

/** One exam's score as a percentage of its maximum, to one decimal. */
export const examPct = (score: number, maxScore: number) => (maxScore > 0 ? Math.round((Math.min(score, maxScore) / maxScore) * 1000) / 10 : 0);

/**
 * The benchmark the analytics card compares a candidate with (the owner's
 * answer: "company average" — employees never sit the entrance exam, so it is
 * the average of the HIRED candidates' results): per active exam, the mean
 * percentage of every hired candidate who sat it, and how many did; null
 * where nobody hired has.
 */
export async function hiredBenchmark(): Promise<Map<string, { pct: number | null; count: number }>> {
  const [exams, rows] = await Promise.all([
    prisma.examCatalog.findMany({ select: { id: true } }),
    prisma.examResult.findMany({ where: { candidate: { status: 'HIRED' } }, select: { examId: true, score: true, exam: { select: { maxScore: true } } } }),
  ]);
  const out = new Map<string, { pct: number | null; count: number }>();
  for (const e of exams) {
    const mine = rows.filter((r) => r.examId === e.id);
    const pct = mine.length ? mine.reduce((a, r) => a + examPct(Number(r.score), r.exam.maxScore), 0) / mine.length : null;
    out.set(e.id, { pct: pct == null ? null : Math.round(pct * 10) / 10, count: mine.length });
  }
  return out;
}
