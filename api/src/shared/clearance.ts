import { Prisma, type ApprovalStep, type ClearanceArea } from '@prisma/client';
import { addDays } from './day';
import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { can } from '../permissions/resolve';
import { approversForStep, pendingFor } from './approvals';
import { audit, redact } from './audit';
import { notify } from './notifications';
import { dayKey, leaveBalance, settingList } from './hr';
import { formatDate, formatMoney } from './pdf';

/**
 * Turnover of accountabilities — the clearance (model §4.7).
 *
 * The checklist is built from records the system already holds: open borrow
 * slips, unpaid claims, pending filings, projects and people assigned to the
 * leaver, plus the company-property list HR keeps in Settings. An item that
 * points at a record derives its status FROM that record on every read, so a
 * clearance can never say a tool is back while G-CHAIN says the slip is OUT.
 *
 * Approval of the document — supervisor, finance, then HR — is what records
 * the separation. Nothing here writes `dateSeparated` before that.
 */

type Tx = Prisma.TransactionClient;

// ── Areas ────────────────────────────────────────────────────────────────────

export const CLEARANCE_AREAS: { key: ClearanceArea; label: string; blurb: string }[] = [
  { key: 'SUPERVISOR', label: 'Work handover', blurb: 'Projects, leads, visits, tasks and the people who report to them' },
  { key: 'WAREHOUSE', label: 'Tools & equipment', blurb: 'Borrow slips still out against their name' },
  { key: 'FINANCE', label: 'Money', blurb: 'Unpaid claims, unliquidated advances and final pay' },
  { key: 'HR', label: 'HR', blurb: 'Pending filings, exit interview, final pay computation' },
  { key: 'ADMIN', label: 'Company property', blurb: 'ID, laptop, keys, access cards, PPE' },
];

export const AREA_ORDER = CLEARANCE_AREAS.map((a) => a.key);

/**
 * Who may clear an item in an area. ONE definition, so the route's refusal
 * and the `canClear` map the screen renders cannot drift apart.
 *
 * SUPERVISOR is the approval engine's own resolution of "the requester's
 * supervisor, else HR" — the same people who sign step 1 — for the leaver's
 * login, or for the raiser when the leaver has none. The leaver themself can
 * never clear their own items, whatever they hold.
 */
export async function areaRight(
  area: ClearanceArea,
  me: ResolvedUser,
  ctx: { userId: string | null; raisedById: string },
): Promise<boolean> {
  if (ctx.userId && ctx.userId === me.id) return false;
  if (can(me, 'ghr.clearances.edit_all')) return true;
  switch (area) {
    case 'SUPERVISOR': {
      const eligible = await approversForStep(
        { approverType: 'SUPERVISOR' } as ApprovalStep,
        ctx.userId ?? ctx.raisedById,
      );
      return eligible.includes(me.id);
    }
    case 'WAREHOUSE':
      return can(me, 'gchain.borrow_slips.edit_all');
    case 'FINANCE':
      return can(me, 'gfin.expenses.edit_all') || can(me, 'gfin.ap.edit_all');
    case 'HR':
      return can(me, 'ghr.clearances.edit_all');
    case 'ADMIN':
      return can(me, 'admin.users.edit_all');
    default:
      return false;
  }
}

export async function canClearMap(
  me: ResolvedUser,
  ctx: { userId: string | null; raisedById: string },
): Promise<Record<ClearanceArea, boolean>> {
  const out = {} as Record<ClearanceArea, boolean>;
  for (const a of AREA_ORDER) out[a] = await areaRight(a, me, ctx);
  return out;
}

// ── Scanning what a leaver still holds ───────────────────────────────────────

export interface AccountabilityRef {
  area: ClearanceArea;
  sourceType: string;
  sourceId: string;
  description: string;
  link: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Every OPEN accountability the records hold against this person. Read-only.
 *
 * Only the unsettled ones come back: the sync treats an item whose reference
 * has dropped out of this list as settled, so a returned slip or a reassigned
 * project clears its own line without anybody touching the clearance.
 */
export async function scanAccountabilities(employee: {
  id: string;
  userId: string | null;
  firstName: string;
  lastName: string;
}): Promise<AccountabilityRef[]> {
  const refs: AccountabilityRef[] = [];
  const userId = employee.userId;
  const fullName = `${employee.firstName} ${employee.lastName}`.trim();
  const today = dayKey(new Date());

  // ── WAREHOUSE: borrow slips ──
  // A slip written to a person with no login is matched by name; only
  // borrowerId is reliable, and the screen says "searched by name" on those.
  const slips = await prisma.borrowSlip.findMany({
    where: {
      status: { not: 'RETURNED' },
      ...(userId
        ? { borrowerId: userId }
        : { borrowerId: null, borrowerName: { equals: fullName, mode: 'insensitive' } }),
    },
    include: { items: { select: { quantity: true, returnedQty: true } } },
    orderBy: { dueAt: 'asc' },
  });
  for (const s of slips) {
    const outstanding = s.items.filter((i) => Number(i.quantity) > Number(i.returnedQty)).length;
    refs.push({
      area: 'WAREHOUSE',
      sourceType: 'borrow_slip',
      sourceId: s.id,
      description: `Borrow slip ${s.number} — ${plural(outstanding, 'item')} outstanding, due ${formatDate(s.dueAt)}${
        userId ? '' : ' (searched by name)'
      }`,
      link: `/g-chain/borrow-slips/${s.id}`,
    });
  }

  if (userId) {
    // ── FINANCE: expense claims and cash advances ──
    const claims = await prisma.expenseClaim.findMany({
      where: { claimedById: userId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
      select: { id: true, number: true, total: true, amountPaid: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const c of claims) {
      const owed = Math.max(0, Number(c.total) - Number(c.amountPaid));
      refs.push({
        area: 'FINANCE',
        sourceType: 'expense_claim',
        sourceId: c.id,
        description:
          c.status === 'DRAFT'
            ? `Expense claim ${c.number} still a draft — submit or cancel it`
            : `Expense claim ${c.number} — ${formatMoney(owed)} still unpaid (final pay)`,
        link: `/g-fin/expenses/${c.id}`,
      });
    }
    const advances = await prisma.cashAdvance.findMany({
      where: { requestedById: userId, status: { in: ['APPROVED', 'RELEASED', 'REFUND_DUE'] } },
      select: { id: true, number: true, amount: true, amountReleased: true, amountRefunded: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const a of advances) {
      const held = Math.max(0, Number(a.amountReleased) - Number(a.amountRefunded));
      refs.push({
        area: 'FINANCE',
        sourceType: 'cash_advance',
        sourceId: a.id,
        description:
          a.status === 'REFUND_DUE'
            ? `Cash advance ${a.number} — ${formatMoney(held)} unspent cash to return`
            : `Cash advance ${a.number} — ${formatMoney(a.status === 'APPROVED' ? Number(a.amount) : held)} awaiting liquidation`,
        link: `/g-fin/cash-advances/${a.id}`,
      });
    }
  }

  // ── HR: filings awaiting a decision ──
  const [leave, overtime] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { employeeId: employee.id, status: 'PENDING_APPROVAL' },
      select: { id: true, number: true },
    }),
    prisma.overtimeRequest.findMany({
      where: { employeeId: employee.id, stage: { in: ['PRIOR', 'ACTUAL_FILED'] } },
      select: { id: true, number: true },
    }),
  ]);
  for (const l of leave) {
    refs.push({
      area: 'HR',
      sourceType: 'leave_request',
      sourceId: l.id,
      description: `Leave ${l.number} awaiting decision`,
      link: `/g-hr/leave/${l.id}`,
    });
  }
  for (const o of overtime) {
    refs.push({
      area: 'HR',
      sourceType: 'overtime_request',
      sourceId: o.id,
      description: `Overtime ${o.number} awaiting approval`,
      link: `/g-hr/overtime/${o.id}`,
    });
  }

  if (userId) {
    // ── SUPERVISOR: work handover ──
    const jobs = await prisma.job.findMany({
      where: { projectManagerId: userId, status: { in: ['PLANNING', 'IN_PROGRESS', 'ON_HOLD'] } },
      select: { id: true, number: true, name: true },
      orderBy: { number: 'asc' },
    });
    for (const j of jobs) {
      refs.push({
        area: 'SUPERVISOR',
        sourceType: 'job',
        sourceId: j.id,
        description: `Project ${j.number} ${j.name} — reassign the project manager`,
        link: `/g-ops/projects/${j.id}`,
      });
    }

    const [tasks, leads, quotations, visits, activities, sessions, reports, approvals] = await Promise.all([
      prisma.jobTask.count({ where: { assignedToId: userId, status: { notIn: ['DONE'] } } }),
      prisma.lead.count({ where: { assignedToId: userId, status: { notIn: ['WON', 'LOST'] } } }),
      prisma.quotation.count({ where: { ownerId: userId, outcome: { in: ['OPEN', 'SUBMITTED', 'NEGOTIATION'] } } }),
      prisma.serviceVisit.count({ where: { assignedToId: userId, status: 'SCHEDULED' } }),
      prisma.salesActivity.count({ where: { assignedToId: userId, status: 'PLANNED', startsAt: { gte: today } } }),
      prisma.trainingSession.count({ where: { trainerId: userId, status: 'SCHEDULED' } }),
      prisma.user.count({ where: { supervisorId: userId, isActive: true } }),
      // pendingFor() walks every PENDING request in the system and resolves
      // each step's approvers; it is O(queue) per call and this sync runs on
      // every open of a clearance. Fine at Gruntech's volume — if the queue
      // ever grows past a few hundred, give approvals.ts a count-only path.
      pendingFor(userId).then((rows) => rows.length),
    ]);

    const aggregate = (
      sourceType: string,
      n: number,
      description: string,
      link: string | null,
    ) => {
      if (n > 0) refs.push({ area: 'SUPERVISOR', sourceType, sourceId: userId, description, link });
    };
    aggregate('tasks', tasks, `${plural(tasks, 'open task')} assigned — reassign them in the project workspace`, '/g-ops/projects');
    aggregate('leads', leads, `${plural(leads, 'open lead')} assigned — reassign in Leads`, '/g-ops/leads');
    aggregate('quotations', quotations, `${plural(quotations, 'open quotation')} owned — hand over in Quotations`, '/g-ops/quotations');
    aggregate('visits', visits, `${plural(visits, 'scheduled service visit')} assigned — reassign in the Service Schedule`, '/g-ops/visits');
    aggregate('activities', activities, `${plural(activities, 'planned sales activity', 'planned sales activities')} from today — reassign in the Sales Calendar`, '/g-ops/calendar');
    aggregate('sessions', sessions, `${plural(sessions, 'scheduled training session')} as trainer — reassign in Training Sessions`, '/g-hr/academy/sessions');
    aggregate('approvals', approvals, `${plural(approvals, 'approval')} waiting on this person — they must decide or the workflow must change`, null);
    aggregate('reports', reports, `${plural(reports, 'person reports', 'people report')} to this person — move their reporting line in Admin › Users`, '/admin/users');
  }

  return refs;
}

// ── Building and refreshing the checklist ────────────────────────────────────

interface ChecklistLine {
  area: ClearanceArea;
  description: string;
}

/**
 * The manual lines: HR's company-property list from Settings, plus the
 * unused-leave line for final pay. Inserted once, at raise; HR edits the
 * Setting freely afterwards without touching a clearance already open.
 */
export async function seedChecklist(tx: Tx, clearanceId: string, employeeId: string): Promise<number> {
  const lines = await settingList<ChecklistLine>('hr.clearanceChecklist', []);
  const rows: Prisma.ClearanceItemCreateManyInput[] = lines
    .filter((l) => l && AREA_ORDER.includes(l.area) && typeof l.description === 'string' && l.description.trim())
    .map((l, i) => ({ clearanceId, area: l.area, description: l.description.trim(), sortOrder: i }));

  // Unused leave, for final pay — informational to finance, owned by HR.
  const year = new Date().getFullYear();
  const types = await tx.leaveType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  let unused = 0;
  for (const t of types) unused += (await leaveBalance(employeeId, t.id, year)).remaining;
  if (unused > 0) {
    rows.push({
      clearanceId,
      area: 'HR',
      description: `Final pay: ${unused} unused leave day(s) to pay out`,
      sortOrder: rows.length,
    });
  }

  if (rows.length) await tx.clearanceItem.createMany({ data: rows });
  return rows.length;
}

/**
 * Brings the derived items into line with the records behind them.
 *
 *   · a reference with no item yet → a PENDING item
 *   · an item whose reference has gone (slip returned, project reassigned,
 *     nobody reporting any more) → CLEARED, by nobody, at the moment the
 *     record settled where that is known
 *   · a CLEARED item whose reference is back (a re-borrow on the same slip) →
 *     PENDING again
 *
 * Manual items and WAIVED items are never touched — a waiver is a written
 * decision and the record is not allowed to overrule it.
 */
export async function syncClearanceItems(tx: Tx, clearanceId: string): Promise<void> {
  const clearance = await tx.employeeClearance.findUnique({
    where: { id: clearanceId },
    include: {
      employee: { select: { id: true, userId: true, firstName: true, lastName: true } },
      items: true,
    },
  });
  if (!clearance) return;
  if (!['OPEN', 'PENDING_APPROVAL', 'REJECTED'].includes(clearance.status)) return;

  const refs = await scanAccountabilities(clearance.employee);
  const key = (t: string | null, i: string | null) => `${t}::${i}`;
  const open = new Map(refs.map((r) => [key(r.sourceType, r.sourceId), r]));

  const derived = clearance.items.filter((i) => i.sourceType && i.sourceId);
  const seen = new Set<string>();
  let sortOrder = clearance.items.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;

  for (const item of derived) {
    const k = key(item.sourceType, item.sourceId);
    seen.add(k);
    if (item.status === 'WAIVED') continue;
    const ref = open.get(k);
    if (ref) {
      // Still outstanding. Refresh the wording (counts change) and reopen if
      // the record went back to unsettled after we had cleared it.
      if (item.status === 'CLEARED' || item.description !== ref.description || item.link !== ref.link) {
        await tx.clearanceItem.update({
          where: { id: item.id },
          data: {
            description: ref.description,
            link: ref.link,
            status: 'PENDING',
            clearedById: null,
            clearedAt: null,
            remarks: null,
          },
        });
      }
    } else if (item.status === 'PENDING') {
      const settledAt = await settledMoment(tx, item.sourceType!, item.sourceId!);
      await tx.clearanceItem.update({
        where: { id: item.id },
        data: {
          status: 'CLEARED',
          clearedById: null,
          clearedAt: settledAt ?? new Date(),
          remarks: 'Settled in the record itself',
        },
      });
    }
  }

  const fresh = refs.filter((r) => !seen.has(key(r.sourceType, r.sourceId)));
  if (fresh.length) {
    await tx.clearanceItem.createMany({
      data: fresh.map((r) => ({
        clearanceId,
        area: r.area,
        sortOrder: sortOrder++,
        description: r.description,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        link: r.link,
      })),
      skipDuplicates: true,
    });
  }
}

/** When the record behind a derived item settled, where the record says so. */
async function settledMoment(tx: Tx, sourceType: string, sourceId: string): Promise<Date | null> {
  if (sourceType === 'borrow_slip') {
    const slip = await tx.borrowSlip.findUnique({ where: { id: sourceId }, select: { returnedAt: true } });
    return slip?.returnedAt ?? null;
  }
  if (sourceType === 'leave_request') {
    const l = await tx.leaveRequest.findUnique({ where: { id: sourceId }, select: { decidedAt: true } });
    return l?.decidedAt ?? null;
  }
  return null;
}

/** Everyone active who holds a permission, through a role or an ALLOW override. */
export async function usersHolding(permissionKey: string, tx: Tx = prisma): Promise<string[]> {
  const rows = await tx.user.findMany({
    where: {
      isActive: true,
      OR: [
        { isSuperAdmin: true },
        {
          AND: [
            {
              OR: [
                { roles: { some: { role: { permissions: { some: { permission: { key: permissionKey } } } } } } },
                { overrides: { some: { effect: 'ALLOW', permission: { key: permissionKey } } } },
              ],
            },
            { NOT: { overrides: { some: { effect: 'DENY', permission: { key: permissionKey } } } } },
          ],
        },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Would the HR step have the raiser sign their own work? True when they are
 * the ONLY HR holder. The engine's self-approval rule guards the requester —
 * the leaver — not the person who raised the form on their behalf, so the
 * submit route refuses this case itself.
 */
export function hrSignsOwnWork(raisedById: string, hrHolders: string[]): boolean {
  return hrHolders.length === 1 && hrHolders[0] === raisedById;
}

// ── The separation sweep ─────────────────────────────────────────────────────

/**
 * Flips `isActive` off for anyone whose separation date has passed.
 *
 * Sweep-on-read, the Phase 8 precedent: G-Core has no scheduler, and a flag
 * that is only right when a cron job ran is worse than one derived when an
 * HR screen opens. Called at the top of GET /employees, /positions and
 * /clearances.
 *
 * The EMPLOYEE is deactivated on the date alone. The LOGIN is closed only
 * when a CLEARED clearance stands behind the separation — an approved,
 * audited document. A separation typed straight onto the employee form is
 * one person's keystroke, so that path tells an administrator to close the
 * login rather than closing it itself.
 */
export async function sweepSeparations(
  today: Date = dayKey(new Date()),
  /** Narrows the sweep — verify-plantilla uses it so a future date never touches real people. */
  scope: Prisma.EmployeeWhereInput = {},
): Promise<number> {
  const due = await prisma.employee.findMany({
    where: { ...scope, isActive: true, dateSeparated: { lt: today } },
    include: {
      user: { select: { id: true, name: true, isActive: true } },
      clearances: { where: { status: 'CLEARED' }, select: { id: true, number: true }, take: 1 },
    },
  });
  if (!due.length) return 0;

  const admins = await usersHolding('admin.users.edit_all');

  for (const e of due) {
    const { user, clearances, ...row } = e;
    const after = await prisma.employee.update({ where: { id: e.id }, data: { isActive: false } });
    const when = e.dateSeparated ? formatDate(e.dateSeparated) : 'an earlier date';
    await audit({
      entityType: 'employee',
      entityId: e.id,
      action: 'SEPARATED',
      actorName: 'system',
      summary: `${e.firstName} ${e.lastName} separated on ${when} — swept on read`,
      before: redact(row as Record<string, unknown>),
      after: redact(after as Record<string, unknown>),
    });

    if (!user || !user.isActive) continue;

    if (clearances.length) {
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      await audit({
        entityType: 'user',
        entityId: user.id,
        action: 'SEPARATED',
        actorName: 'system',
        summary: `Login closed — clearance ${clearances[0].number} approved, separated on ${when}`,
      });
    } else if (admins.length) {
      await notify(
        admins.map((userId) => ({
          userId,
          type: 'system' as const,
          title: `Close the login for ${e.firstName} ${e.lastName}`,
          body: `Separated on ${when} with no clearance on file — the account is still active.`,
          link: `/admin/users/${user.id}`,
        })),
      );
    }
  }
  return due.length;
}

// ── Turnover rate ────────────────────────────────────────────────────────────

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface TurnoverEmployee {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string | null;
  employmentType: string;
  dateHired: Date | null;
  dateSeparated: Date | null;
  createdAt: Date;
  department: { id: string; name: string } | null;
}

export interface TurnoverMonth {
  month: string;
  label: string;
  opening: number;
  hires: number;
  separations: number;
  closing: number;
  ratePct: number;
  /** Average headcount under 5 — one leaver is a huge percentage and no signal. */
  tooEarly: boolean;
}

export interface TurnoverFigures {
  hires: number;
  separations: number;
  averageHeadcount: number;
  ratePct: number;
  annualisedPct: number;
  tooEarly: boolean;
}

export interface TurnoverReport extends TurnoverFigures {
  from: Date;
  to: Date;
  months: TurnoverMonth[];
  regularOnly: TurnoverFigures;
  byReason: { reason: string; count: number }[];
  byDepartment: {
    department: { id: string; name: string } | null;
    separations: number;
    averageHeadcount: number;
    ratePct: number;
  }[];
  leavers: {
    id: string;
    employeeNo: string;
    name: string;
    department: { id: string; name: string } | null;
    position: string | null;
    employmentType: string;
    dateHired: Date | null;
    dateSeparated: Date;
    tenureMonths: number;
    reason: string;
    clearance: { id: string; number: string } | null;
  }[];
  averageTenureMonths: number;
}

const startOf = (e: TurnoverEmployee) => e.dateHired ?? dayKey(e.createdAt);

function headcountAt(emps: TurnoverEmployee[], d: Date): number {
  return emps.filter((e) => startOf(e) <= d && (!e.dateSeparated || e.dateSeparated > d)).length;
}

function monthWindows(from: Date, to: Date): { key: string; label: string; start: Date; end: Date }[] {
  const out = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const last = to.getUTCFullYear() * 12 + to.getUTCMonth();
  while (y * 12 + m <= last) {
    const start = utcDay(y, m, 1);
    const end = utcDay(y, m + 1, 0);
    out.push({
      key: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: start.toLocaleDateString('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      start,
      end,
    });
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

function figuresFor(emps: TurnoverEmployee[], windows: ReturnType<typeof monthWindows>): { months: TurnoverMonth[]; totals: TurnoverFigures } {
  const months: TurnoverMonth[] = windows.map((w) => {
    const opening = headcountAt(emps, addDays(w.start, -1));
    const closing = headcountAt(emps, w.end);
    const hires = emps.filter((e) => e.dateHired && e.dateHired >= w.start && e.dateHired <= w.end).length;
    const separations = emps.filter(
      (e) => e.dateSeparated && e.dateSeparated >= w.start && e.dateSeparated <= w.end,
    ).length;
    const avg = (opening + closing) / 2;
    return {
      month: w.key,
      label: w.label,
      opening,
      hires,
      separations,
      closing,
      ratePct: avg > 0 ? round2((separations / avg) * 100) : 0,
      tooEarly: avg < 5,
    };
  });

  const n = Math.max(1, months.length);
  const averageHeadcount = round2(months.reduce((s, m) => s + (m.opening + m.closing) / 2, 0) / n);
  const separations = months.reduce((s, m) => s + m.separations, 0);
  const hires = months.reduce((s, m) => s + m.hires, 0);
  const ratePct = averageHeadcount > 0 ? round2((separations / averageHeadcount) * 100) : 0;
  return {
    months,
    totals: {
      hires,
      separations,
      averageHeadcount,
      ratePct,
      annualisedPct: round2((ratePct * 12) / n),
      tooEarly: averageHeadcount < 5,
    },
  };
}

/** Whole months between two dates, to one decimal. */
export function tenureMonths(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) +
    (to.getUTCDate() - from.getUTCDate()) / 30;
  return round1(Math.max(0, months));
}

/**
 * Pure arithmetic over the employee dates — no table, nothing stored.
 *
 * Headcount at a date d = employees with `coalesce(dateHired, createdAt) ≤ d`
 * and not yet separated at d. Per month: opening, hires, separations,
 * closing, and separations ÷ the average of opening and closing. Reused by
 * the HR report, its CSV and the dashboard tiles, so they agree.
 *
 * `where` narrows the population — the verify script uses it to run the
 * arithmetic over its own fixtures.
 */
export async function turnover(
  from: Date,
  to: Date,
  opts: { where?: Prisma.EmployeeWhereInput } = {},
): Promise<TurnoverReport> {
  const fromDay = utcDay(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const toDay = utcDay(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const windows = monthWindows(fromDay, toDay);

  const emps: TurnoverEmployee[] = await prisma.employee.findMany({
    where: opts.where,
    select: {
      id: true,
      employeeNo: true,
      firstName: true,
      lastName: true,
      position: true,
      employmentType: true,
      dateHired: true,
      dateSeparated: true,
      createdAt: true,
      department: { select: { id: true, name: true } },
    },
  });

  const all = figuresFor(emps, windows);
  const regular = figuresFor(
    emps.filter((e) => e.employmentType === 'REGULAR'),
    windows,
  );

  const leavers = emps
    .filter((e) => e.dateSeparated && e.dateSeparated >= fromDay && e.dateSeparated <= toDay)
    .sort((a, b) => b.dateSeparated!.getTime() - a.dateSeparated!.getTime());

  const cleared = leavers.length
    ? await prisma.employeeClearance.findMany({
        where: { status: 'CLEARED', employeeId: { in: leavers.map((l) => l.id) } },
        select: { id: true, number: true, employeeId: true, reason: true },
        orderBy: { clearedAt: 'desc' },
      })
    : [];
  const clearanceBy = new Map<string, (typeof cleared)[number]>();
  for (const c of cleared) if (!clearanceBy.has(c.employeeId)) clearanceBy.set(c.employeeId, c);

  const byReason = new Map<string, number>();
  const rows: TurnoverReport['leavers'] = leavers.map((e) => {
    const c = clearanceBy.get(e.id);
    const reason = c?.reason ?? 'UNRECORDED';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    return {
      id: e.id,
      employeeNo: e.employeeNo,
      name: `${e.firstName} ${e.lastName}`,
      department: e.department,
      position: e.position,
      employmentType: e.employmentType,
      dateHired: e.dateHired,
      dateSeparated: e.dateSeparated!,
      tenureMonths: tenureMonths(startOf(e), e.dateSeparated!),
      reason,
      clearance: c ? { id: c.id, number: c.number } : null,
    };
  });

  const deptKeys = new Map<string, { id: string; name: string } | null>();
  for (const e of emps) deptKeys.set(e.department?.id ?? '', e.department);
  const byDepartment = [...deptKeys.entries()]
    .map(([k, department]) => {
      const f = figuresFor(
        emps.filter((e) => (e.department?.id ?? '') === k),
        windows,
      ).totals;
      return { department, separations: f.separations, averageHeadcount: f.averageHeadcount, ratePct: f.ratePct };
    })
    .filter((d) => d.averageHeadcount > 0 || d.separations > 0)
    .sort((a, b) => b.ratePct - a.ratePct || (a.department?.name ?? 'zz').localeCompare(b.department?.name ?? 'zz'));

  return {
    from: fromDay,
    to: toDay,
    ...all.totals,
    months: all.months,
    regularOnly: regular.totals,
    byReason: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    byDepartment,
    leavers: rows,
    averageTenureMonths: rows.length ? round1(rows.reduce((s, r) => s + r.tenureMonths, 0) / rows.length) : 0,
  };
}

/** The 12-month window the strip and the dashboard tiles use. */
export function trailingYear(today = new Date()): { from: Date; to: Date } {
  const to = dayKey(today);
  const from = utcDay(to.getUTCFullYear(), to.getUTCMonth() - 11, 1);
  return { from, to };
}

export interface ClearanceSummary {
  open: number;
  pendingApproval: number;
  separations12m: number;
  hires12m: number;
  turnover12mPct: number;
  annualisedPct: number;
  tooEarly: boolean;
}

export async function clearanceSummary(): Promise<ClearanceSummary> {
  const { from, to } = trailingYear();
  const [open, pendingApproval, t] = await Promise.all([
    prisma.employeeClearance.count({ where: { status: 'OPEN' } }),
    prisma.employeeClearance.count({ where: { status: 'PENDING_APPROVAL' } }),
    turnover(from, to),
  ]);
  return {
    open,
    pendingApproval,
    separations12m: t.separations,
    hires12m: t.hires,
    turnover12mPct: t.ratePct,
    annualisedPct: t.annualisedPct,
    tooEarly: t.tooEarly,
  };
}
