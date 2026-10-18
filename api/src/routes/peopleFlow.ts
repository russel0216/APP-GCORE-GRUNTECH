import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, idsFilter, notFound, badRequest, type ListQuery } from '../http/kit';
import { authenticate, requireAny, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { requireEdit, assertCanEdit, mayEdit } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { registerAttachmentGuard } from '../shared/attachments';
import { renderDocument, formatDate, formatShortDate } from '../shared/pdf';
import { LIST_CAP, listReference, choice, sendListPdf } from '../shared/listPaper';
import { manilaDayKey } from '../shared/day';
import {
  FLOW_EMPLOYEE_SELECT,
  FLOW_STAGES,
  SOURCE_LABEL,
  STAGE_LABEL,
  DUE_SOON_DAYS,
  addDaysKey,
  flowChecklist,
  mayReadFlow,
  pathsFor,
  type FlowEmployee,
  type FlowPath,
  type FlowStage,
} from '../shared/peopleFlow';

/**
 * People Flow (2026-10-13) — G-HR › People › People Flow: every active
 * person's stage and what is open on their path, and one person's path from
 * pre-boarding to the clearance certificate. The rules are
 * `shared/peopleFlow.ts`; this file only reads, filters and records HR's
 * ticks. The list is computed over every visible active employee and paged
 * AFTER the stage filter (the stage is derived, never stored) — a page is
 * never a filtered fraction of a page.
 */

export const peopleFlowRoutes = Router();
peopleFlowRoutes.use(authenticate);

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;
const STAGE_KEYS = FLOW_STAGES.map((s) => s.key);

/** Whose paths the viewer may list: HR everyone; anybody else themself and, with the HR dashboard right, their direct reports. */
function visibleWhere(me: ResolvedUser): Prisma.EmployeeWhereInput {
  if (can(me, 'ghr.people_flow.view_all')) return {};
  const or: Prisma.EmployeeWhereInput[] = [{ userId: me.id }];
  if (can(me, 'ghr.dashboard.view_all')) or.push({ user: { supervisorId: me.id } });
  return { OR: or };
}

/** Visibility, search, department and `ids` — everything but the stage filters, which need the paths. */
function baseWhere(me: ResolvedUser, q: ListQuery): Prisma.EmployeeWhereInput {
  const and: Prisma.EmployeeWhereInput[] = [{ isActive: true }, visibleWhere(me)];
  if (q.search) {
    and.push({
      OR: [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { employeeNo: { contains: q.search, mode: 'insensitive' } },
        { position: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  if (q.filters.departmentId) and.push({ departmentId: q.filters.departmentId });
  // A supervisor's own list: the people who report to them, without themself.
  if (choice(q.filters.reports, ['true'], 'Reports', () => 'true')) and.push({ user: { supervisorId: me.id } });
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return { AND: and };
}

interface Row {
  employee: FlowEmployee;
  path: FlowPath;
}

/** The stage, overdue and probation filters — each a declared key the summary tiles link to. */
function matches(q: ListQuery, today: string) {
  const stage = choice(q.filters.stage, STAGE_KEYS, 'Stage', (s) => STAGE_LABEL[s as FlowStage]);
  const overdue = choice(q.filters.overdue, ['true'], 'Overdue', () => 'true');
  const probation = choice(q.filters.probation, ['due'], 'Probation review', () => 'due');
  const soon = addDaysKey(today, DUE_SOON_DAYS);
  return {
    stage,
    overdue: !!overdue,
    probation: !!probation,
    test: (r: Row) =>
      (!stage || r.path.stage === stage) &&
      (!overdue || r.path.overdue > 0) &&
      (!probation || (!!r.path.probationDueOn && r.path.probationDueOn <= soon)),
  };
}

const SORTS: Record<string, (a: Row, b: Row) => number> = {
  name: (a, b) => fullName(a.employee).localeCompare(fullName(b.employee)),
  employeeNo: (a, b) => (a.employee.employeeNo ?? '').localeCompare(b.employee.employeeNo ?? ''),
  stage: (a, b) => STAGE_KEYS.indexOf(a.path.stage) - STAGE_KEYS.indexOf(b.path.stage),
  open: (a, b) => a.path.open - b.path.open,
  overdue: (a, b) => a.path.overdue - b.path.overdue,
  hired: (a, b) => (a.path.hiredOn ?? '').localeCompare(b.path.hiredOn ?? ''),
};

async function flowRows(me: ResolvedUser, q: ListQuery) {
  const today = manilaDayKey(new Date());
  const employees = await prisma.employee.findMany({
    where: baseWhere(me, q),
    select: FLOW_EMPLOYEE_SELECT,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  const paths = await pathsFor(employees, today);
  const all: Row[] = employees.map((e) => ({ employee: e, path: paths.get(e.id)! }));
  const m = matches(q, today);
  const soon = addDaysKey(today, DUE_SOON_DAYS);

  // The tiles count under everything but their own three filters, so a tile
  // and the list it opens are one query.
  const summary = {
    total: all.length,
    stages: Object.fromEntries(FLOW_STAGES.map((s) => [s.key, all.filter((r) => r.path.stage === s.key).length])),
    overdue: all.filter((r) => r.path.overdue > 0).length,
    probationDue: all.filter((r) => !!r.path.probationDueOn && r.path.probationDueOn <= soon).length,
  };

  const rows = all.filter(m.test);
  const sort = (q.sort && SORTS[q.sort]) || SORTS.name;
  rows.sort((a, b) => (q.dir === 'desc' && q.sort ? -1 : 1) * sort(a, b) || SORTS.name(a, b));
  return { rows, summary, m };
}

function present({ employee: e, path: p }: Row) {
  return {
    id: e.id,
    employeeNo: e.employeeNo,
    name: fullName(e),
    position: e.position,
    department: e.department,
    employmentType: e.employmentType,
    hiredOn: p.hiredOn,
    stage: p.stage,
    stageLabel: p.stageLabel,
    open: p.open,
    overdue: p.overdue,
    next: p.next,
    probationDueOn: p.probationDueOn,
  };
}

peopleFlowRoutes.get(
  '/',
  requireAny('ghr.people_flow.view_all', 'ghr.people_flow.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { rows, summary } = await flowRows(me, q);
    const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    res.json({ ...listResult(page.map(present), rows.length, q), summary });
  }),
);

/**
 * The list on paper, as filtered or as ticked — declared above `/:employeeId`.
 * Seven columns: portrait.
 */
peopleFlowRoutes.get(
  '/pdf',
  requireAny('ghr.people_flow.view_all', 'ghr.people_flow.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { rows, m } = await flowRows(me, q);
    const printed = rows.slice(0, LIST_CAP);
    const department = q.filters.departmentId
      ? await prisma.department.findUnique({ where: { id: q.filters.departmentId }, select: { name: true } })
      : null;
    const reference = listReference(rows.length, printed.length, ['person', 'people'], [
      q.search && `search "${q.search}"`,
      m.stage && `stage ${STAGE_LABEL[m.stage as FlowStage]}`,
      m.overdue && 'with overdue items',
      m.probation && `probation review due within ${DUE_SOON_DAYS} days`,
      q.filters.departmentId && `department ${department?.name ?? 'not found'}`,
      q.filters.reports === 'true' ? 'your direct reports' : !can(me, 'ghr.people_flow.view_all') && 'yourself and your direct reports',
      q.filters.ids && 'the rows selected',
    ]);
    const day = (key: string | null) => (key ? formatShortDate(new Date(`${key}T00:00:00Z`)) : '—');
    const pdf = await renderDocument({
      title: 'People Flow',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Employee', 'Department', 'Hired', 'Stage', 'Open', 'Overdue', 'Next'],
          rows: printed.map(({ employee: e, path: p }) => [
            { title: `${e.lastName}, ${e.firstName}`, body: [e.employeeNo, e.position].filter(Boolean).join(' · ') },
            e.department?.name ?? '—',
            day(p.hiredOn),
            p.stageLabel,
            String(p.open),
            p.overdue ? String(p.overdue) : '—',
            p.next ? { title: p.next.title, body: p.next.dueOn ? `due ${day(p.next.dueOn)}` : undefined } : '—',
          ]),
        },
      ],
    });
    await audit(
      { entityType: 'people_flow', entityId: 'list', action: 'EXPORTED', summary: `Exported the People Flow list as PDF (${printed.length} people)` },
      req,
    );
    sendListPdf(res, pdf, 'people-flow.pdf');
  }),
);

async function pathResponse(me: ResolvedUser, employee: FlowEmployee) {
  const path = (await pathsFor([employee])).get(employee.id)!;
  return {
    employee: {
      id: employee.id,
      employeeNo: employee.employeeNo,
      name: fullName(employee),
      position: employee.position,
      department: employee.department,
      employmentType: employee.employmentType,
      isActive: employee.isActive,
      self: employee.userId === me.id,
    },
    ...path,
    stages: FLOW_STAGES,
    sources: SOURCE_LABEL,
    // Edit Own (2026-10-18): the person ticks their own path's items.
    canEdit: mayEdit(me, 'ghr', 'people_flow', employee.userId === me.id),
  };
}

/** The signed-in person's own path. */
peopleFlowRoutes.get(
  '/mine',
  requireAny('ghr.people_flow.view_all', 'ghr.people_flow.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const employee = await prisma.employee.findUnique({ where: { userId: me.id }, select: FLOW_EMPLOYEE_SELECT });
    if (!employee) throw notFound('No employee record is linked to your login, so there is no path to show');
    res.json(await pathResponse(me, employee));
  }),
);

async function readable(me: ResolvedUser, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: FLOW_EMPLOYEE_SELECT });
  // Someone else's path is a 404, not a 403: that a path exists is the person's business.
  if (!employee || !mayReadFlow(me, employee)) throw notFound('Employee not found');
  return employee;
}

peopleFlowRoutes.get(
  '/:employeeId',
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(await pathResponse(me, await readable(me, req.params.employeeId)));
  }),
);

const itemBody = z.object({
  status: z.enum(['PENDING', 'DONE', 'WAIVED', 'NA']),
  doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD').nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

const STATUS_WORDS = { PENDING: 'open', DONE: 'done', WAIVED: 'waived', NA: 'not applicable' } as const;

/**
 * HR records one item — and, with Edit Own (2026-10-18), the person on
 * their own path; an item that follows a record is never ticked by hand by
 * either. A derived item follows its record and can only be
 * WAIVED (with a reason) or put back to follow it (PENDING); everything else
 * is a 400 naming the record. A manual item is DONE on a day (today by
 * default, never a day to come), WAIVED with a reason, NA, or reopened.
 */
peopleFlowRoutes.put(
  '/:employeeId/items/:key',
  requireEdit('ghr', 'people_flow'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const employee = await readable(me, req.params.employeeId);
    assertCanEdit(me, 'ghr', 'people_flow', employee.userId === me.id);
    const def = (await flowChecklist()).find((d) => d.key === req.params.key);
    if (!def) throw notFound(`"${req.params.key}" is not on the People Flow checklist`);
    const body = parseBody(itemBody, req.body);
    const notes = body.notes?.trim() || null;
    const today = manilaDayKey(new Date());

    if (def.source && body.status !== 'WAIVED' && body.status !== 'PENDING') {
      throw badRequest(`${def.title} follows ${SOURCE_LABEL[def.source].toLowerCase()} — it cannot be ticked by hand; waive it with a reason instead`);
    }
    if (body.status === 'WAIVED' && (!notes || notes.length < 3)) throw badRequest('Say why it is waived');
    let doneOn: string | null = null;
    if (body.status === 'DONE') {
      doneOn = body.doneOn ?? today;
      if (doneOn > today) throw badRequest('Something done cannot be dated after today');
    }
    if (body.status === 'WAIVED') doneOn = body.doneOn ?? today;

    const before = await prisma.employeeFlowItem.findUnique({
      where: { employeeId_itemKey: { employeeId: employee.id, itemKey: def.key } },
      select: { status: true, doneOn: true, notes: true },
    });
    const data = {
      status: body.status,
      doneOn: doneOn ? new Date(`${doneOn}T00:00:00Z`) : null,
      notes: body.status === 'PENDING' && def.source ? null : notes,
      updatedById: me.id,
    };
    await prisma.employeeFlowItem.upsert({
      where: { employeeId_itemKey: { employeeId: employee.id, itemKey: def.key } },
      create: { employeeId: employee.id, itemKey: def.key, ...data },
      update: data,
    });
    const when = doneOn ? ` (${formatDate(new Date(`${doneOn}T00:00:00Z`))})` : '';
    await audit(
      {
        entityType: 'people_flow',
        entityId: employee.id,
        action: 'UPDATED',
        summary: `People Flow of ${fullName(employee)} — ${def.title}: ${STATUS_WORDS[body.status]}${when}`,
        before: before ? { status: before.status, doneOn: before.doneOn, notes: before.notes } : null,
        after: { item: def.key, status: body.status, doneOn, notes: data.notes },
      },
      req,
    );
    res.json(await pathResponse(me, employee));
  }),
);

// Files on an item (the exit interview's form, the 30-60-90 plan) are
// attachments on `employee_flow_item` with entityId `<employeeId>~<itemKey>`:
// read by whoever reads the path, added and removed by HR — and by the
// person on their own path with Edit Own (2026-10-18).
registerAttachmentGuard(
  'employee_flow_item',
  async (user, entityId) => {
    const employeeId = entityId.split('~')[0];
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true, user: { select: { supervisorId: true } } },
    });
    return !!employee && mayReadFlow(user, employee);
  },
  {
    write: async (user, entityId) => {
      if (can(user, 'ghr.people_flow.edit_all')) return true;
      if (!can(user, 'ghr.people_flow.edit_own')) return false;
      const employee = await prisma.employee.findUnique({ where: { id: entityId.split('~')[0] }, select: { userId: true } });
      return !!employee?.userId && employee.userId === user.id;
    },
  },
);
