import type { FlowItemStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { can, type ResolvedUser } from '../permissions/resolve';
import { manilaDayKey } from './day';
import { hrSettings, settingList } from './hr';

/**
 * People Flow — one person's path from start to separation (2026-10-13, the
 * owner's PEOPLE_FLOW_FROM_START_TO_SEPARATION: Onboarding, Integration,
 * Development & Growth, Retention & Engagement, Separation).
 *
 * The CHECKLIST is data (`hr.peopleFlow`, HR Settings); what HR recorded for a
 * person is `EmployeeFlowItem`; the items a record answers for — the
 * probation review, skill building, the clearance's — are DERIVED from that
 * record on every read and never ticked by hand (the clearance's rule), only
 * waived with a reason. The person's STAGE is derived too, never stored:
 * `stageOf()`. Everything here but the loader is pure, on 'YYYY-MM-DD' keys
 * (the Manila day), so verify-hr pins it without a clock.
 */

export type FlowStage = 'ONBOARDING' | 'INTEGRATION' | 'DEVELOPMENT' | 'RETENTION' | 'SEPARATION';

export const FLOW_STAGES: { key: FlowStage; label: string; blurb: string }[] = [
  { key: 'ONBOARDING', label: 'Onboarding', blurb: 'Before Day 1 and the first weeks' },
  { key: 'INTEGRATION', label: 'Integration', blurb: 'Training, early feedback and the probation review' },
  { key: 'DEVELOPMENT', label: 'Development & Growth', blurb: 'Performance, skills and career, through the first year' },
  { key: 'RETENTION', label: 'Retention & Engagement', blurb: 'Rewards, culture and the shape of the work, after the first year' },
  { key: 'SEPARATION', label: 'Separation', blurb: 'Notice, handover and offboarding' },
];

export const STAGE_LABEL = Object.fromEntries(FLOW_STAGES.map((s) => [s.key, s.label])) as Record<FlowStage, string>;

/** The records an item may follow instead of being ticked by HR. */
export type FlowSource =
  | 'probation_review'
  | 'training'
  | 'clearance_raised'
  | 'clearance_handover'
  | 'clearance_property'
  | 'clearance_cleared';

export const FLOW_SOURCES: { key: FlowSource; label: string }[] = [
  { key: 'probation_review', label: 'The probation evaluation' },
  { key: 'training', label: 'Verified training (Academy)' },
  { key: 'clearance_raised', label: 'A clearance raised' },
  { key: 'clearance_handover', label: 'The clearance’s work-handover lines' },
  { key: 'clearance_property', label: 'The clearance’s property lines and the login' },
  { key: 'clearance_cleared', label: 'The clearance approved' },
];

export const SOURCE_LABEL = Object.fromEntries(FLOW_SOURCES.map((s) => [s.key, s.label])) as Record<FlowSource, string>;

export interface FlowItemDef {
  stage: FlowStage;
  /** Permanent — a person's rows point at it. Rename the title freely. */
  key: string;
  title: string;
  description?: string | null;
  /**
   * When it falls due: days after the hire date for Onboarding and
   * Integration, days from the last working day for Separation (negative is
   * before it). Development and Retention are a steady state — no due date.
   */
  dueDays?: number | null;
  /** Set when a record answers for the item; null or absent when HR ticks it. */
  source?: FlowSource | null;
}

export const PEOPLE_FLOW_KEY = 'hr.peopleFlow';

/** The owner's file, item by item — the checklist until HR edits it. */
export const PEOPLE_FLOW_DEFAULTS: FlowItemDef[] = [
  {
    stage: 'ONBOARDING',
    key: 'preboarding',
    title: 'Pre-boarding',
    description: 'Administrative setup, background checks, system access requests and the welcome package, before Day 1.',
    dueDays: 0,
  },
  {
    stage: 'ONBOARDING',
    key: 'orientation',
    title: 'Orientation',
    description: 'The company culture, policies, workplace tools and the team.',
    dueDays: 5,
  },
  {
    stage: 'ONBOARDING',
    key: 'role_alignment',
    title: 'Role alignment',
    description: 'Clear first expectations, the 30-60-90 day goals (write them in the notes) and a buddy or mentor named.',
    dueDays: 14,
  },
  {
    stage: 'INTEGRATION',
    key: 'job_training',
    title: 'Job training',
    description: 'The role’s own tools, processes and workflows, in depth.',
    dueDays: 60,
  },
  {
    stage: 'INTEGRATION',
    key: 'early_feedback',
    title: 'Early feedback',
    description: 'Regular 1-on-1s with the manager: questions answered, workload adjusted, fit judged.',
    dueDays: 60,
  },
  {
    stage: 'INTEGRATION',
    key: 'probation_review',
    title: 'Probation review',
    description: 'The evaluation at the end of probation that confirms regular status.',
    source: 'probation_review',
  },
  {
    stage: 'DEVELOPMENT',
    key: 'performance_management',
    title: 'Performance management',
    description: 'Continuous feedback, periodic reviews (quarterly or yearly) and key metrics tracked.',
  },
  {
    stage: 'DEVELOPMENT',
    key: 'skill_building',
    title: 'Skill building',
    description: 'On-the-job learning, workshops, certifications and leadership training.',
    source: 'training',
  },
  {
    stage: 'DEVELOPMENT',
    key: 'career_pathing',
    title: 'Career pathing',
    description: 'Promotion, lateral transfer or succession planning, matched to what the person wants.',
  },
  {
    stage: 'RETENTION',
    key: 'total_rewards',
    title: 'Total rewards',
    description: 'The annual salary review, performance bonus, benefits and recognition.',
  },
  {
    stage: 'RETENTION',
    key: 'workplace_culture',
    title: 'Workplace culture',
    description: 'Work-life balance, team building and open channels for feedback (pulse surveys).',
  },
  {
    stage: 'RETENTION',
    key: 'work_redesign',
    title: 'Work redesign',
    description: 'Responsibilities adjusted or flexible arrangements, to prevent burnout and keep motivation.',
  },
  {
    stage: 'SEPARATION',
    key: 'notice',
    title: 'Notice & resignation',
    description: 'The resignation letter received, the transition timeline agreed and the people who need to know told.',
    source: 'clearance_raised',
  },
  {
    stage: 'SEPARATION',
    key: 'knowledge_transfer',
    title: 'Knowledge transfer',
    description: 'Ongoing tasks, documents, project files and customer accounts handed over to the team.',
    source: 'clearance_handover',
  },
  {
    stage: 'SEPARATION',
    key: 'exit_interview',
    title: 'Exit interview',
    description: 'Candid feedback on the culture and management (write it in the notes).',
    dueDays: 0,
  },
  {
    stage: 'SEPARATION',
    key: 'access_property',
    title: 'Access revoked, property collected',
    description: 'System access closed and company property returned — laptop, badge, keys.',
    source: 'clearance_property',
  },
  {
    stage: 'SEPARATION',
    key: 'final_pay',
    title: 'Final pay & benefits',
    description: 'Final pay processed, and benefits continuation (pension, government contributions) explained.',
    dueDays: 30,
  },
  {
    stage: 'SEPARATION',
    key: 'clearance_certificate',
    title: 'Clearance certificate',
    description: 'The clearance approved and the certificate issued.',
    source: 'clearance_cleared',
  },
];

export async function flowChecklist(): Promise<FlowItemDef[]> {
  return settingList<FlowItemDef>(PEOPLE_FLOW_KEY, PEOPLE_FLOW_DEFAULTS);
}

/** Onboarding lasts at least this long from the hire date. */
export const ONBOARDING_DAYS = 30;
/** Development & Growth until the first anniversary; Retention after it. */
export const RETENTION_AFTER_DAYS = 365;
/** Due within this many days is "due soon" on My Work and the probation tile. */
export const DUE_SOON_DAYS = 7;

/** The clearance lines that are work handed over (shared/clearance.ts's SUPERVISOR scan). */
export const HANDOVER_SOURCES = new Set(['job', 'tasks', 'leads', 'quotations', 'visits', 'activities', 'approvals', 'reports', 'sessions']);

// ── Day keys ─────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const keyDate = (key: string) => new Date(`${key}T00:00:00Z`);
/** A DATE column's own day. */
export const dateKey = (d: Date) => d.toISOString().slice(0, 10);
export function addDaysKey(key: string, days: number): string {
  return dateKey(new Date(keyDate(key).getTime() + days * DAY));
}
export function daysBetweenKeys(from: string, to: string): number {
  return Math.round((keyDate(to).getTime() - keyDate(from).getTime()) / DAY);
}
/** Months later, clamped to the month's end (31 January + 1 month = 28 February). */
export function addMonthsKey(key: string, months: number): string {
  const d = keyDate(key);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return dateKey(d);
}

// ── The facts a path is read from ────────────────────────────────────────────

export interface StoredFlowItem {
  status: FlowItemStatus;
  doneOn: string | null;
  notes: string | null;
  by: string | null;
  at: string;
}

export interface FlowFacts {
  employmentType: string;
  hiredOn: string | null;
  /** The record's creation, the Manila day — the start when no hire date is typed (turnover's rule). */
  createdOn: string;
  regularizedOn: string | null;
  separatedOn: string | null;
  /** A typed end of the probation or training period. */
  periodEndOn: string | null;
  /** null when the person has no login. */
  loginActive: boolean | null;
  /** The latest APPROVED evaluation. */
  evaluation: { id: string; number: string; recommendation: string | null; approvedOn: string | null; extendedTo: string | null } | null;
  training: { count: number; latestTitle: string | null; latestOn: string | null };
  /** The clearance standing since the hire: OPEN, PENDING_APPROVAL or CLEARED. */
  clearance: {
    id: string;
    number: string;
    status: string;
    reason: string;
    lastDay: string;
    raisedOn: string;
    clearedOn: string | null;
    items: { sourceType: string | null; status: string }[];
  } | null;
  stored: Record<string, StoredFlowItem>;
}

export interface FlowItemView {
  key: string;
  stage: FlowStage;
  title: string;
  description: string | null;
  source: FlowSource | null;
  derived: boolean;
  status: FlowItemStatus;
  /** What the record says — "EV-… approved: regularize", "2 of 5 lines settled". */
  fact: string | null;
  link: string | null;
  dueOn: string | null;
  overdue: boolean;
  doneOn: string | null;
  notes: string | null;
  /** Who last recorded it, and when — HR's own rows only. */
  by: string | null;
  at: string | null;
}

export interface FlowPath {
  stage: FlowStage;
  stageLabel: string;
  hiredOn: string | null;
  probationEndOn: string | null;
  items: FlowItemView[];
  /** Open items of the current stage. */
  open: number;
  overdue: number;
  /** The next open item of the current stage, soonest due first. */
  next: { key: string; title: string; dueOn: string | null } | null;
  /** The probation review's due day while it is open. */
  probationDueOn: string | null;
}

const settled = (status: string) => status !== 'PENDING';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const RECOMMENDATION: Record<string, string> = {
  REGULARIZE: 'regularize',
  ABSORB: 'absorb',
  END: 'end the employment',
  EXTEND: 'extend the period',
};
const PROBATION_TYPES = new Set(['PROBATIONARY', 'TRAINEE']);
const NO_PROBATION: Record<string, string> = {
  PROJECT_BASED: 'a project-based employee',
  CONTRACTUAL: 'a contractual employee',
  PART_TIME: 'a part-time employee',
};

interface Derived {
  status: FlowItemStatus;
  fact: string;
  link: string | null;
  doneOn: string | null;
  dueOn?: string | null;
}

function derive(source: FlowSource, f: FlowFacts, employeeId: string, probationEndOn: string | null): Derived {
  const c = f.clearance;
  const clearanceLink = c ? `/g-hr/clearances/${c.id}` : null;
  switch (source) {
    case 'probation_review': {
      const ev = f.evaluation;
      const evLink = ev ? `/g-hr/evaluations/${ev.id}` : null;
      const decided = ev && ev.recommendation && ev.recommendation !== 'EXTEND';
      if (PROBATION_TYPES.has(f.employmentType)) {
        if (decided) {
          return { status: 'DONE', fact: `${ev.number} approved: ${RECOMMENDATION[ev.recommendation!]}`, link: evLink, doneOn: ev.approvedOn };
        }
        const fact = ev?.recommendation === 'EXTEND'
          ? `${ev.number} extended the period${ev.extendedTo ? ` to ${ev.extendedTo}` : ''}`
          : 'No approved evaluation yet';
        return { status: 'PENDING', fact, link: evLink ?? '/g-hr/evaluations', doneOn: null, dueOn: probationEndOn };
      }
      if (f.employmentType === 'REGULAR') {
        if (decided) return { status: 'DONE', fact: `${ev.number} approved: ${RECOMMENDATION[ev.recommendation!]}`, link: evLink, doneOn: ev.approvedOn ?? f.regularizedOn };
        return { status: 'DONE', fact: f.regularizedOn ? `Regular since ${f.regularizedOn}` : 'Regular employee', link: null, doneOn: f.regularizedOn };
      }
      return { status: 'NA', fact: `No probation for ${NO_PROBATION[f.employmentType] ?? 'this employment type'}`, link: null, doneOn: null };
    }
    case 'training': {
      const t = f.training;
      const link = `/g-hr/academy/passports/${employeeId}`;
      if (t.count > 0) {
        return {
          status: 'DONE',
          fact: `${plural(t.count, 'verified training record')}${t.latestTitle ? ` — latest: ${t.latestTitle}` : ''}`,
          link,
          doneOn: t.latestOn,
        };
      }
      return { status: 'PENDING', fact: 'No verified training yet', link, doneOn: null };
    }
    case 'clearance_raised':
      return c
        ? { status: 'DONE', fact: `Clearance ${c.number} raised — last working day ${c.lastDay}`, link: clearanceLink, doneOn: c.raisedOn }
        : { status: 'PENDING', fact: 'No clearance raised', link: null, doneOn: null };
    case 'clearance_handover': {
      if (!c) return { status: 'PENDING', fact: 'No clearance raised', link: null, doneOn: null };
      const lines = c.items.filter((i) => i.sourceType && HANDOVER_SOURCES.has(i.sourceType));
      const done = lines.filter((i) => settled(i.status)).length;
      if (lines.length === 0) return { status: 'DONE', fact: 'Nothing to hand over on the clearance', link: clearanceLink, doneOn: c.raisedOn };
      return done === lines.length
        ? { status: 'DONE', fact: `${plural(lines.length, 'handover line')} settled`, link: clearanceLink, doneOn: null }
        : { status: 'PENDING', fact: `${done} of ${plural(lines.length, 'handover line')} settled`, link: clearanceLink, doneOn: null };
    }
    case 'clearance_property': {
      if (!c) return { status: 'PENDING', fact: 'No clearance raised', link: null, doneOn: null };
      const lines = c.items.filter((i) => !i.sourceType || !HANDOVER_SOURCES.has(i.sourceType));
      const done = lines.filter((i) => settled(i.status)).length;
      const loginOpen = f.loginActive === true;
      const parts = [`${done} of ${plural(lines.length, 'property line')} settled`, loginOpen ? 'the login is still open' : f.loginActive === false ? 'the login is closed' : 'no login'];
      return done === lines.length && !loginOpen
        ? { status: 'DONE', fact: parts.join(' · '), link: clearanceLink, doneOn: null }
        : { status: 'PENDING', fact: parts.join(' · '), link: clearanceLink, doneOn: null };
    }
    case 'clearance_cleared':
      if (!c) return { status: 'PENDING', fact: 'No clearance raised', link: null, doneOn: null };
      return c.status === 'CLEARED'
        ? { status: 'DONE', fact: `Clearance ${c.number} approved`, link: clearanceLink, doneOn: c.clearedOn }
        : { status: 'PENDING', fact: `Clearance ${c.number} ${c.status === 'PENDING_APPROVAL' ? 'is waiting for approval' : 'is open'}`, link: clearanceLink, doneOn: null };
  }
}

/**
 * Which stage a person stands in — derived, never stored:
 * - SEPARATION once a clearance stands or a separation date is on file;
 * - ONBOARDING for the first `ONBOARDING_DAYS` (a future hire is in
 *   pre-boarding), and after that while an Onboarding item is still open
 *   within the new-hire window (the probation period: the typed period end,
 *   else `probationMonths` from the hire);
 * - INTEGRATION while still PROBATIONARY or a TRAINEE — the probation review
 *   is what ends it — or within the window while an Integration item is open;
 * - DEVELOPMENT until the first anniversary, RETENTION after it.
 * An onboarding nobody recorded never holds a regular employee of ten years
 * in Onboarding: past the window, only the dates decide.
 */
export function stageOf(
  f: FlowFacts,
  items: Pick<FlowItemView, 'stage' | 'status'>[],
  today: string,
  probationMonths: number,
): FlowStage {
  if (f.separatedOn || f.clearance) return 'SEPARATION';
  const hire = f.hiredOn ?? f.createdOn;
  const days = daysBetweenKeys(hire, today);
  const windowEnd = f.periodEndOn ?? addMonthsKey(hire, probationMonths);
  const inWindow = today <= windowEnd;
  const open = (stage: FlowStage) => items.some((i) => i.stage === stage && i.status === 'PENDING');
  if (days < ONBOARDING_DAYS) return 'ONBOARDING';
  if (inWindow && open('ONBOARDING')) return 'ONBOARDING';
  if (PROBATION_TYPES.has(f.employmentType)) return 'INTEGRATION';
  if (inWindow && open('INTEGRATION')) return 'INTEGRATION';
  return days < RETENTION_AFTER_DAYS ? 'DEVELOPMENT' : 'RETENTION';
}

/** One person's path: the checklist merged with HR's rows and the records, and the stage. */
export function buildPath(
  checklist: FlowItemDef[],
  f: FlowFacts,
  employeeId: string,
  today: string,
  probationMonths: number,
): FlowPath {
  const hire = f.hiredOn ?? f.createdOn;
  const probationEndOn = PROBATION_TYPES.has(f.employmentType)
    ? (f.periodEndOn ?? (f.employmentType === 'PROBATIONARY' ? addMonthsKey(hire, probationMonths) : null))
    : null;

  const items: FlowItemView[] = checklist.map((def) => {
    const stored = f.stored[def.key];
    const source = def.source ?? null;
    let status: FlowItemStatus;
    let fact: string | null = null;
    let link: string | null = null;
    let doneOn: string | null = stored?.doneOn ?? null;
    let derivedDue: string | null | undefined;
    if (source) {
      const d = derive(source, f, employeeId, probationEndOn);
      fact = d.fact;
      link = d.link;
      derivedDue = d.dueOn;
      if (stored?.status === 'WAIVED') status = 'WAIVED';
      else {
        status = d.status;
        doneOn = d.doneOn;
      }
    } else {
      status = stored?.status ?? 'PENDING';
    }

    let dueOn: string | null = null;
    if (status === 'PENDING') {
      if (derivedDue !== undefined) dueOn = derivedDue;
      else if (def.dueDays != null && (def.stage === 'ONBOARDING' || def.stage === 'INTEGRATION')) dueOn = addDaysKey(hire, def.dueDays);
      else if (def.dueDays != null && def.stage === 'SEPARATION' && f.clearance) dueOn = addDaysKey(f.clearance.lastDay, def.dueDays);
    }
    return {
      key: def.key,
      stage: def.stage,
      title: def.title,
      description: def.description ?? null,
      source,
      derived: !!source,
      status,
      fact,
      link,
      dueOn,
      overdue: false,
      doneOn,
      notes: stored?.notes ?? null,
      by: stored?.by ?? null,
      at: stored?.at ?? null,
    };
  });

  const stage = stageOf(f, items, today, probationMonths);
  // Overdue only in the stage the person stands in: an onboarding item left
  // open when the stage moved on stays open, but nobody is chased for it.
  for (const i of items) i.overdue = i.stage === stage && i.status === 'PENDING' && !!i.dueOn && i.dueOn < today;
  const current = items.filter((i) => i.stage === stage && i.status === 'PENDING');
  const next = [...current].sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))[0] ?? null;
  const probation = items.find((i) => i.source === 'probation_review' && i.status === 'PENDING');
  return {
    stage,
    stageLabel: STAGE_LABEL[stage],
    hiredOn: f.hiredOn,
    probationEndOn,
    items,
    open: current.length,
    overdue: current.filter((i) => i.overdue).length,
    next: next ? { key: next.key, title: next.title, dueOn: next.dueOn } : null,
    probationDueOn: probation?.dueOn ?? null,
  };
}

// ── Reading it from the database ─────────────────────────────────────────────

export const FLOW_EMPLOYEE_SELECT = {
  id: true,
  employeeNo: true,
  firstName: true,
  lastName: true,
  position: true,
  employmentType: true,
  dateHired: true,
  dateRegularized: true,
  dateSeparated: true,
  periodEndDate: true,
  createdAt: true,
  isActive: true,
  userId: true,
  department: { select: { id: true, name: true } },
  user: { select: { id: true, isActive: true, supervisorId: true } },
} as const;

export interface FlowEmployee {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  employmentType: string;
  dateHired: Date | null;
  dateRegularized: Date | null;
  dateSeparated: Date | null;
  periodEndDate: Date | null;
  createdAt: Date;
  isActive: boolean;
  userId: string | null;
  department: { id: string; name: string } | null;
  user: { id: string; isActive: boolean; supervisorId: string | null } | null;
}

/** The path of each employee given, read in five queries whatever their number. */
export async function pathsFor(employees: FlowEmployee[], today = manilaDayKey(new Date())): Promise<Map<string, FlowPath>> {
  const out = new Map<string, FlowPath>();
  if (!employees.length) return out;
  const ids = employees.map((e) => e.id);
  const [checklist, settings, evaluations, training, clearances, stored] = await Promise.all([
    flowChecklist(),
    hrSettings(),
    prisma.employeeEvaluation.findMany({
      where: { employeeId: { in: ids }, status: 'APPROVED' },
      select: { id: true, number: true, employeeId: true, recommendation: true, approvedAt: true, extendedTo: true },
      orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.trainingRecord.findMany({
      where: { employeeId: { in: ids }, status: 'VERIFIED' },
      select: { employeeId: true, completedAt: true, course: { select: { title: true } } },
      orderBy: { completedAt: 'desc' },
    }),
    prisma.employeeClearance.findMany({
      where: { employeeId: { in: ids }, status: { in: ['OPEN', 'PENDING_APPROVAL', 'CLEARED'] } },
      select: {
        id: true,
        number: true,
        employeeId: true,
        status: true,
        reason: true,
        lastWorkingDay: true,
        createdAt: true,
        clearedAt: true,
        items: { select: { sourceType: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.employeeFlowItem.findMany({
      where: { employeeId: { in: ids } },
      select: { employeeId: true, itemKey: true, status: true, doneOn: true, notes: true, updatedAt: true, updatedBy: { select: { name: true } } },
    }),
  ]);

  const firstBy = <T extends { employeeId: string }>(rows: T[]) => {
    const m = new Map<string, T>();
    for (const r of rows) if (!m.has(r.employeeId)) m.set(r.employeeId, r);
    return m;
  };
  const evalBy = firstBy(evaluations);
  const trainingBy = new Map<string, { count: number; latestTitle: string | null; latestOn: string | null }>();
  for (const t of training) {
    const cur = trainingBy.get(t.employeeId);
    if (cur) cur.count += 1;
    else trainingBy.set(t.employeeId, { count: 1, latestTitle: t.course.title, latestOn: dateKey(t.completedAt) });
  }
  const storedBy = new Map<string, Record<string, StoredFlowItem>>();
  for (const s of stored) {
    const rec = storedBy.get(s.employeeId) ?? {};
    rec[s.itemKey] = {
      status: s.status,
      doneOn: s.doneOn ? dateKey(s.doneOn) : null,
      notes: s.notes,
      by: s.updatedBy?.name ?? null,
      at: s.updatedAt.toISOString(),
    };
    storedBy.set(s.employeeId, rec);
  }

  for (const e of employees) {
    const hiredOn = e.dateHired ? dateKey(e.dateHired) : null;
    const createdOn = manilaDayKey(e.createdAt);
    // A clearance from before a rehire is the earlier employment's.
    const c = clearances.find((r) => r.employeeId === e.id && manilaDayKey(r.createdAt) >= (hiredOn ?? createdOn)) ?? null;
    const ev = evalBy.get(e.id);
    const facts: FlowFacts = {
      employmentType: e.employmentType,
      hiredOn,
      createdOn,
      regularizedOn: e.dateRegularized ? dateKey(e.dateRegularized) : null,
      separatedOn: e.dateSeparated ? dateKey(e.dateSeparated) : null,
      periodEndOn: e.periodEndDate ? dateKey(e.periodEndDate) : null,
      loginActive: e.user ? e.user.isActive : null,
      evaluation: ev
        ? {
            id: ev.id,
            number: ev.number,
            recommendation: ev.recommendation,
            approvedOn: ev.approvedAt ? manilaDayKey(ev.approvedAt) : null,
            extendedTo: ev.extendedTo ? dateKey(ev.extendedTo) : null,
          }
        : null,
      training: trainingBy.get(e.id) ?? { count: 0, latestTitle: null, latestOn: null },
      clearance: c
        ? {
            id: c.id,
            number: c.number,
            status: c.status,
            reason: c.reason,
            lastDay: dateKey(c.lastWorkingDay),
            raisedOn: manilaDayKey(c.createdAt),
            clearedOn: c.clearedAt ? manilaDayKey(c.clearedAt) : null,
            items: c.items,
          }
        : null,
      stored: storedBy.get(e.id) ?? {},
    };
    out.set(e.id, buildPath(checklist, facts, e.id, today, settings.probationMonths));
  }
  return out;
}

// ── Who reads whose path ─────────────────────────────────────────────────────

/**
 * HR (`view_all`) reads everyone's; a person their own (`view_own`); a
 * supervisor holding the HR dashboard right their DIRECT REPORTS' — the clock
 * capture's rule, one level down and no further.
 */
export function mayReadFlow(me: ResolvedUser, employee: { userId: string | null; user: { supervisorId: string | null } | null }): boolean {
  if (can(me, 'ghr.people_flow.view_all')) return true;
  if (employee.userId && employee.userId === me.id && can(me, 'ghr.people_flow.view_own')) return true;
  return can(me, 'ghr.dashboard.view_all') && !!employee.user?.supervisorId && employee.user.supervisorId === me.id;
}

// ── My Work ──────────────────────────────────────────────────────────────────

export interface FlowWorkRow {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  when?: Date | null;
  overdue?: boolean;
  link: string;
}

const MAX_WORK_ROWS = 10;
const name = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

/**
 * My Work's People Flow rows: for HR (`edit_all`), the open items of each
 * person's CURRENT stage that are overdue or due within a week (the probation
 * review included); for the person, their own open onboarding items while
 * they stand in Onboarding — read-only, HR ticks them.
 */
export async function peopleFlowWork(me: ResolvedUser): Promise<FlowWorkRow[]> {
  const today = manilaDayKey(new Date());
  const soon = addDaysKey(today, DUE_SOON_DAYS);
  const rows: FlowWorkRow[] = [];
  const asDate = (key: string) => keyDate(key);

  if (can(me, 'ghr.people_flow.edit_all')) {
    const people = await prisma.employee.findMany({ where: { isActive: true }, select: FLOW_EMPLOYEE_SELECT });
    const paths = await pathsFor(people, today);
    for (const e of people) {
      const p = paths.get(e.id)!;
      for (const i of p.items) {
        if (i.stage !== p.stage || i.status !== 'PENDING' || !i.dueOn || i.dueOn > soon) continue;
        rows.push({
          id: `${e.id}~${i.key}`,
          kind: 'people_flow',
          title: `${i.title} — ${name(e)}`,
          subtitle: `${p.stageLabel} · ${e.employeeNo}${i.derived && i.fact ? ` · ${i.fact}` : ''}`,
          when: asDate(i.dueOn),
          overdue: i.overdue,
          link: `/g-hr/people-flow/${e.id}`,
        });
      }
    }
  } else if (can(me, 'ghr.people_flow.view_own') || can(me, 'ghr.people_flow.view_all')) {
    const mine = await prisma.employee.findUnique({ where: { userId: me.id }, select: FLOW_EMPLOYEE_SELECT });
    if (mine?.isActive) {
      const p = (await pathsFor([mine], today)).get(mine.id)!;
      if (p.stage === 'ONBOARDING') {
        for (const i of p.items) {
          if (i.stage !== 'ONBOARDING' || i.status !== 'PENDING') continue;
          rows.push({
            id: `${mine.id}~${i.key}`,
            kind: 'people_flow',
            title: i.title,
            subtitle: 'Your onboarding · HR ticks it off',
            when: i.dueOn ? asDate(i.dueOn) : null,
            overdue: i.overdue,
            link: `/g-hr/people-flow/${mine.id}`,
          });
        }
      }
    }
  }
  return rows
    .sort((a, b) => (a.overdue === b.overdue ? (a.when?.getTime() ?? Infinity) - (b.when?.getTime() ?? Infinity) : a.overdue ? -1 : 1))
    .slice(0, MAX_WORK_ROWS);
}
