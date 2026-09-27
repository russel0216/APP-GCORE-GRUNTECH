import { Router } from 'express';
import { z } from 'zod';
import { Prisma, SeparationReason, ClearanceStatus, type ClearanceArea } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  conflict,
  badRequest,
  forbidden,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  pickWorkflow,
  usersInRole,
  approvalSignoffs,
} from '../shared/approvals';
import { renderDocument, formatDate, formatDateTime, type PdfSection } from '../shared/pdf';
import { toCsv } from '../shared/csv';
import { dayKey, leaveBalance, myEmployee } from '../shared/hr';
import {
  AREA_ORDER,
  CLEARANCE_AREAS,
  canClearMap,
  areaRight,
  clearanceSummary,
  hrSignsOwnWork,
  seedChecklist,
  sweepSeparations,
  syncClearanceItems,
  trailingYear,
  turnover,
} from '../shared/clearance';

/**
 * Employee clearance — turnover of accountabilities before someone leaves.
 *
 * The document is raised by the leaver (a resignation) or by HR on anyone's
 * behalf; the leaver never clears their own items and never signs their own
 * form. Items are cleared by the area that owns them, in parallel; the
 * sign-off chain (supervisor → finance → HR) is the approval engine's, and
 * approval is what records the separation.
 */

export const clearanceRoutes = Router();
clearanceRoutes.use(authenticate);

const REASON_LABEL: Record<SeparationReason, string> = {
  RESIGNATION: 'Resignation',
  END_OF_CONTRACT: 'End of contract',
  END_OF_PROJECT: 'End of project',
  TERMINATION: 'Termination',
  RETIREMENT: 'Retirement',
  AWOL: 'AWOL',
  OTHER: 'Other',
};

function asEnum<T extends Record<string, string>>(e: T, value: string | undefined): T[keyof T] | undefined {
  return value && value in e ? (value as T[keyof T]) : undefined;
}

function asDay(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${value}" is not a valid date`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

/** Whole years and months between two dates — "2 yr 4 mo". */
function tenure(from: Date | null, to: Date): string {
  if (!from) return '—';
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return `${Math.floor(months / 12)} yr ${months % 12} mo`;
}

const headerInclude = {
  employee: {
    select: {
      id: true,
      employeeNo: true,
      firstName: true,
      lastName: true,
      position: true,
      employmentType: true,
      dateHired: true,
      userId: true,
      department: { select: { id: true, name: true } },
      user: {
        select: {
          id: true,
          name: true,
          isActive: true,
          supervisor: { select: { id: true, name: true } },
        },
      },
    },
  },
  raisedBy: { select: { id: true, name: true, position: true } },
  handedOverTo: { select: { id: true, name: true, position: true } },
} satisfies Prisma.EmployeeClearanceInclude;

type Header = Prisma.EmployeeClearanceGetPayload<{ include: typeof headerInclude }>;

async function loadClearance(id: string): Promise<Header> {
  const row = await prisma.employeeClearance.findUnique({ where: { id }, include: headerInclude });
  if (!row) throw notFound('Clearance not found');
  return row;
}

/** "Mine" for view_own: I raised it, or it is about me. */
const isMine = (me: { id: string }, c: { raisedById: string; employee: { userId: string | null } }) =>
  c.raisedById === me.id || c.employee.userId === me.id;

function assertCanView(me: ReturnType<typeof currentUser>, c: Header) {
  if (can(me, 'ghr.clearances.view_all')) return;
  if (can(me, 'ghr.clearances.view_own') && isMine(me, c)) return;
  throw forbidden('That is someone else’s clearance');
}

const mayEdit = (me: ReturnType<typeof currentUser>, c: { raisedById: string }) =>
  canEditRecord(me, 'ghr', 'clearances', c.raisedById);

// ── List and summary ─────────────────────────────────────────────────────────

clearanceRoutes.get(
  '/',
  requireAny('ghr.clearances.view_all', 'ghr.clearances.view_own'),
  handler(async (req, res) => {
    await sweepSeparations();
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.EmployeeClearanceWhereInput = {};

    const onlyOwn = !can(me, 'ghr.clearances.view_all');
    if (onlyOwn || q.scope === 'mine') {
      where.OR = [{ raisedById: me.id }, { employee: { userId: me.id } }];
    }
    const status = asEnum(ClearanceStatus, q.filters.status);
    if (status) where.status = status;
    const reason = asEnum(SeparationReason, q.filters.reason);
    if (reason) where.reason = reason;
    if (q.filters.departmentId) where.employee = { departmentId: q.filters.departmentId };
    if (q.filters.employeeId) where.employeeId = q.filters.employeeId;
    if (q.search) {
      where.AND = [
        {
          OR: [
            { number: { contains: q.search, mode: 'insensitive' } },
            { employee: { firstName: { contains: q.search, mode: 'insensitive' } } },
            { employee: { lastName: { contains: q.search, mode: 'insensitive' } } },
            { employee: { employeeNo: { contains: q.search, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.employeeClearance.findMany({
        where,
        include: {
          employee: {
            select: {
              id: true,
              employeeNo: true,
              firstName: true,
              lastName: true,
              position: true,
              department: { select: { id: true, name: true } },
            },
          },
          raisedBy: { select: { id: true, name: true } },
          items: { select: { status: true } },
        },
        orderBy: orderBy(q, ['number', 'lastWorkingDay', 'createdAt', 'status'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.employeeClearance.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map(({ items, ...r }) => ({
          ...r,
          items: {
            total: items.length,
            cleared: items.filter((i) => i.status === 'CLEARED').length,
            waived: items.filter((i) => i.status === 'WAIVED').length,
            pending: items.filter((i) => i.status === 'PENDING').length,
          },
        })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The turnover strip on the register and the HR dashboard tiles. Company-wide
 * figures, so view_own (an employee raising their own resignation) does not
 * reach them — HR Reports' right does.
 */
clearanceRoutes.get(
  '/summary',
  requireAny('ghr.clearances.view_all', 'ghr.reports.view_all', 'ghr.dashboard.view_all'),
  handler(async (_req, res) => {
    await sweepSeparations();
    res.json(await clearanceSummary());
  }),
);

clearanceRoutes.get(
  '/areas',
  requireAny('ghr.clearances.view_all', 'ghr.clearances.view_own'),
  handler(async (_req, res) => {
    res.json(CLEARANCE_AREAS);
  }),
);

/**
 * The caller's own employee record, for the Raise form of someone who may only
 * raise their own clearance (a resignation). Names and posts only. Must sit
 * above `/:id`.
 */
clearanceRoutes.get(
  '/me',
  requireAny('ghr.clearances.view_all', 'ghr.clearances.view_own', 'ghr.clearances.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const mine = await myEmployee(me.id);
    if (!mine) {
      res.json({ employee: null, open: null });
      return;
    }
    const [employee, open] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: mine.id },
        select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true, isActive: true },
      }),
      prisma.employeeClearance.findFirst({
        where: { employeeId: mine.id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } },
        select: { id: true, number: true, status: true },
      }),
    ]);
    res.json({ employee, open });
  }),
);

// ── Raise ────────────────────────────────────────────────────────────────────

const raiseSchema = z.object({
  employeeId: z.string().min(1, 'Pick the employee'),
  reason: z.nativeEnum(SeparationReason),
  lastWorkingDay: z.string().min(1, 'The last working day is required'),
  handedOverToId: z.string().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

clearanceRoutes.post(
  '/',
  require_('ghr.clearances.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(raiseSchema, req.body);

    // Someone with only their own rights may raise their own — a resignation.
    if (!can(me, 'ghr.clearances.view_all') && !can(me, 'ghr.clearances.edit_all')) {
      const mine = await myEmployee(me.id);
      if (!mine || mine.id !== body.employeeId) {
        throw forbidden('You can only raise a clearance for yourself');
      }
    }

    const employee = await prisma.employee.findUnique({
      where: { id: body.employeeId },
      select: { id: true, firstName: true, lastName: true, isActive: true, userId: true, user: { select: { supervisorId: true } } },
    });
    if (!employee) throw notFound('Employee not found');
    if (!employee.isActive) throw badRequest(`${fullName(employee)} is already inactive`);

    const existing = await prisma.employeeClearance.findFirst({
      where: { employeeId: employee.id, status: { in: ['OPEN', 'PENDING_APPROVAL'] } },
      select: { number: true },
    });
    if (existing) {
      throw conflict(`${fullName(employee)} already has clearance ${existing.number} in progress`);
    }
    if (body.handedOverToId) {
      const receiver = await prisma.user.findUnique({ where: { id: body.handedOverToId }, select: { id: true } });
      if (!receiver) throw notFound('The person receiving the turnover was not found');
    }

    const clearance = await prisma.$transaction(async (tx) => {
      const created = await tx.employeeClearance.create({
        data: {
          number: await nextNumber('clearance', tx),
          employeeId: employee.id,
          reason: body.reason,
          lastWorkingDay: asDay(body.lastWorkingDay),
          raisedById: me.id,
          handedOverToId: body.handedOverToId || null,
          notes: body.notes || null,
        },
      });
      await seedChecklist(tx, created.id, employee.id);
      await syncClearanceItems(tx, created.id);
      return created;
    });

    const itemCount = await prisma.clearanceItem.count({ where: { clearanceId: clearance.id } });
    await audit(
      {
        entityType: 'clearance',
        entityId: clearance.id,
        action: 'CREATED',
        summary: `Raised clearance ${clearance.number} for ${fullName(employee)} — ${REASON_LABEL[body.reason].toLowerCase()}, last day ${formatDate(clearance.lastWorkingDay)}`,
      },
      req,
    );

    // The raiser, the leaver (when that is someone else) and their supervisor.
    const recipients = new Set<string>([me.id]);
    if (employee.userId) recipients.add(employee.userId);
    if (employee.user?.supervisorId) recipients.add(employee.user.supervisorId);
    await notify(
      [...recipients].map((userId) => ({
        userId,
        type: 'clearance.raised' as const,
        title: `Clearance ${clearance.number}: ${fullName(employee)} — ${itemCount} item(s) to clear`,
        body: `${REASON_LABEL[body.reason]}, last working day ${formatDate(clearance.lastWorkingDay)}`,
        link: `/g-hr/clearances/${clearance.id}`,
      })),
    );

    res.status(201).json(clearance);
  }),
);

// ── Read one ─────────────────────────────────────────────────────────────────

clearanceRoutes.get(
  '/:id',
  requireAny('ghr.clearances.view_all', 'ghr.clearances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const head = await loadClearance(req.params.id);
    assertCanView(me, head);

    await prisma.$transaction((tx) => syncClearanceItems(tx, head.id));

    const items = await prisma.clearanceItem.findMany({
      where: { clearanceId: head.id },
      include: { clearedBy: { select: { id: true, name: true } } },
      orderBy: [{ sortOrder: 'asc' }],
    });

    const byArea = {} as Record<ClearanceArea, { total: number; pending: number; cleared: number; waived: number }>;
    for (const a of AREA_ORDER) {
      const mine = items.filter((i) => i.area === a);
      byArea[a] = {
        total: mine.length,
        pending: mine.filter((i) => i.status === 'PENDING').length,
        cleared: mine.filter((i) => i.status === 'CLEARED').length,
        waived: mine.filter((i) => i.status === 'WAIVED').length,
      };
    }

    const ctx = { userId: head.employee.userId, raisedById: head.raisedById };
    const canClear = await canClearMap(me, ctx);

    const year = new Date().getFullYear();
    const types = await prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    const leaveRemaining = [];
    for (const t of types) {
      const b = await leaveBalance(head.employee.id, t.id, year);
      leaveRemaining.push({ type: t.name, remaining: b.remaining });
    }

    const pending = items.filter((i) => i.status === 'PENDING').length;
    const editable = ['OPEN', 'REJECTED'].includes(head.status);
    res.json({
      ...head,
      reasonLabel: REASON_LABEL[head.reason],
      items: items.map((i) => ({ ...i, derived: i.sourceType != null })),
      byArea,
      canClear,
      readyToSubmit: editable && items.length > 0 && pending === 0,
      canEdit: editable && mayEdit(me, head),
      canManageItems: editable && can(me, 'ghr.clearances.edit_all'),
      // Same rule as POST /:id/cancel, so the button cannot promise more.
      canCancel: ['OPEN', 'PENDING_APPROVAL', 'REJECTED'].includes(head.status) && mayEdit(me, head),
      leaveRemaining,
      tenure: tenure(head.employee.dateHired, head.lastWorkingDay),
    });
  }),
);

// ── Edit the header ──────────────────────────────────────────────────────────

const patchSchema = z.object({
  reason: z.nativeEnum(SeparationReason).optional(),
  lastWorkingDay: z.string().optional(),
  handedOverToId: z.string().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});

clearanceRoutes.patch(
  '/:id',
  requireAny('ghr.clearances.edit_own', 'ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(patchSchema, req.body);
    const before = await loadClearance(req.params.id);
    if (!mayEdit(me, before)) throw forbidden('Only the person who raised this clearance, or HR, can edit it');
    if (!['OPEN', 'REJECTED'].includes(before.status)) {
      throw badRequest(`A ${before.status.toLowerCase().replace(/_/g, ' ')} clearance cannot be edited`);
    }

    const data: Prisma.EmployeeClearanceUpdateInput = {};
    if (body.reason) data.reason = body.reason;
    if (body.lastWorkingDay) data.lastWorkingDay = asDay(body.lastWorkingDay);
    if (body.handedOverToId !== undefined) {
      data.handedOverTo = body.handedOverToId ? { connect: { id: body.handedOverToId } } : { disconnect: true };
    }
    if (body.notes !== undefined) data.notes = body.notes || null;

    const after = await prisma.employeeClearance.update({ where: { id: before.id }, data, include: headerInclude });
    await audit(
      {
        entityType: 'clearance',
        entityId: after.id,
        action: 'UPDATED',
        summary: `Updated clearance ${after.number}`,
        before: { reason: before.reason, lastWorkingDay: before.lastWorkingDay, handedOverToId: before.handedOverToId, notes: before.notes },
        after: { reason: after.reason, lastWorkingDay: after.lastWorkingDay, handedOverToId: after.handedOverToId, notes: after.notes },
      },
      req,
    );
    res.json(after);
  }),
);

// ── Items ────────────────────────────────────────────────────────────────────

const AREAS = AREA_ORDER as [ClearanceArea, ...ClearanceArea[]];

clearanceRoutes.post(
  '/:id/items',
  require_('ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ area: z.enum(AREAS), description: z.string().trim().min(3, 'Say what has to be returned or done') }),
      req.body,
    );
    const head = await loadClearance(req.params.id);
    if (!['OPEN', 'REJECTED'].includes(head.status)) throw badRequest('Items can only be added while the clearance is open');

    const last = await prisma.clearanceItem.aggregate({ where: { clearanceId: head.id }, _max: { sortOrder: true } });
    const item = await prisma.clearanceItem.create({
      data: {
        clearanceId: head.id,
        area: body.area,
        description: body.description,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    await audit(
      { entityType: 'clearance', entityId: head.id, action: 'UPDATED', summary: `${head.number}: added item "${body.description}" (${body.area})` },
      req,
    );
    res.status(201).json(item);
  }),
);

async function loadItem(clearanceId: string, itemId: string) {
  const item = await prisma.clearanceItem.findFirst({ where: { id: itemId, clearanceId } });
  if (!item) throw notFound('Clearance item not found');
  return item;
}

async function assertMayAct(req: Parameters<typeof currentUser>[0], head: Header, area: ClearanceArea) {
  const me = currentUser(req);
  if (!['OPEN', 'REJECTED'].includes(head.status)) {
    throw badRequest('Items can only be cleared while the clearance is open');
  }
  const ok = await areaRight(area, me, { userId: head.employee.userId, raisedById: head.raisedById });
  if (!ok) {
    const label = CLEARANCE_AREAS.find((a) => a.key === area)?.label ?? area;
    throw forbidden(
      head.employee.userId === me.id
        ? 'You cannot clear items on your own clearance'
        : `"${label}" items are cleared by the area that owns them, not by you`,
    );
  }
  return me;
}

clearanceRoutes.post(
  '/:id/items/:itemId/clear',
  handler(async (req, res) => {
    const body = parseBody(z.object({ remarks: z.string().trim().optional().nullable() }), req.body ?? {});
    const head = await loadClearance(req.params.id);
    const item = await loadItem(head.id, req.params.itemId);
    const me = await assertMayAct(req, head, item.area);

    if (item.sourceType) {
      throw badRequest(
        `This item is cleared from its record, not by hand — ${item.description}. If it will never be settled, waive it with a written reason.`,
      );
    }
    if (item.status !== 'PENDING') throw badRequest('This item is not pending');

    const updated = await prisma.clearanceItem.update({
      where: { id: item.id },
      data: { status: 'CLEARED', clearedById: me.id, clearedAt: new Date(), remarks: body.remarks || null },
    });
    await audit(
      { entityType: 'clearance', entityId: head.id, action: 'UPDATED', summary: `${head.number}: cleared "${item.description}" (${item.area})` },
      req,
    );
    res.json(updated);
  }),
);

clearanceRoutes.post(
  '/:id/items/:itemId/waive',
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ reason: z.string().trim().min(5, 'A waiver needs a written reason of at least five characters') }),
      req.body ?? {},
    );
    const head = await loadClearance(req.params.id);
    const item = await loadItem(head.id, req.params.itemId);
    const me = await assertMayAct(req, head, item.area);
    if (item.status === 'WAIVED') throw badRequest('This item is already waived');

    const updated = await prisma.clearanceItem.update({
      where: { id: item.id },
      data: { status: 'WAIVED', clearedById: me.id, clearedAt: new Date(), remarks: body.reason },
    });
    await audit(
      {
        entityType: 'clearance',
        entityId: head.id,
        action: 'UPDATED',
        summary: `${head.number}: waived "${item.description}" (${item.area}) — ${body.reason}`,
      },
      req,
    );
    res.json(updated);
  }),
);

clearanceRoutes.post(
  '/:id/items/:itemId/reopen',
  require_('ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const head = await loadClearance(req.params.id);
    if (!['OPEN', 'REJECTED'].includes(head.status)) throw badRequest('Items can only be reopened while the clearance is open');
    const item = await loadItem(head.id, req.params.itemId);
    if (item.status === 'PENDING') throw badRequest('This item is already pending');

    const updated = await prisma.clearanceItem.update({
      where: { id: item.id },
      data: { status: 'PENDING', clearedById: null, clearedAt: null, remarks: null },
    });
    await audit(
      { entityType: 'clearance', entityId: head.id, action: 'UPDATED', summary: `${head.number}: reopened "${item.description}"` },
      req,
    );
    res.json(updated);
  }),
);

clearanceRoutes.delete(
  '/:id/items/:itemId',
  require_('ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const head = await loadClearance(req.params.id);
    const item = await loadItem(head.id, req.params.itemId);
    if (item.sourceType) throw badRequest('An item that points at a record cannot be removed — it clears itself when the record settles');
    if (item.status !== 'PENDING') throw badRequest('Only a pending item can be removed');
    await prisma.clearanceItem.delete({ where: { id: item.id } });
    await audit(
      { entityType: 'clearance', entityId: head.id, action: 'UPDATED', summary: `${head.number}: removed item "${item.description}"` },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Submit, cancel ───────────────────────────────────────────────────────────

clearanceRoutes.post(
  '/:id/submit',
  requireAny('ghr.clearances.edit_own', 'ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const head = await loadClearance(req.params.id);
    if (!mayEdit(me, head)) throw forbidden('Only the person who raised this clearance, or HR, can submit it');
    if (!['OPEN', 'REJECTED'].includes(head.status)) {
      throw badRequest('This clearance has already been submitted');
    }

    await prisma.$transaction((tx) => syncClearanceItems(tx, head.id));
    const items = await prisma.clearanceItem.findMany({ where: { clearanceId: head.id }, orderBy: { sortOrder: 'asc' } });
    if (items.length === 0) throw badRequest('There is nothing on this clearance to sign off');
    const pending = items.filter((i) => i.status === 'PENDING');
    if (pending.length) {
      throw badRequest(
        `${pending.length} item(s) still pending: ${pending.map((p) => p.description).join('; ')}`,
        pending.map((p) => ({ id: p.id, area: p.area, description: p.description })),
      );
    }

    // The leaver's own login is the requester whenever one exists, so step 1
    // resolves to THEIR supervisor and the engine's self-approval rule keeps
    // them off their own form. Only a login-less employee falls back to the
    // raiser.
    const requesterId = head.employee.userId ?? head.raisedById;

    // A lone HR holder who also raised the form would be signing their own
    // work at the HR step — the engine only guards step 1, so guard here.
    const workflow = await pickWorkflow('clearance');
    if (workflow?.steps.some((s) => s.approverType === 'HR')) {
      if (hrSignsOwnWork(head.raisedById, await usersInRole('hr'))) {
        throw badRequest(
          'This clearance routes to HR, and the person who raised it is the only HR holder — a second HR user must exist before it can be signed off.',
        );
      }
    }

    await prisma.employeeClearance.update({
      where: { id: head.id },
      data: { status: 'PENDING_APPROVAL', submittedAt: new Date() },
    });
    try {
      await submitForApproval({
        documentType: 'clearance',
        documentId: head.id,
        documentNumber: head.number,
        subject: `${fullName(head.employee)} — clearance (${REASON_LABEL[head.reason].toLowerCase()}), last day ${formatDate(head.lastWorkingDay)}`,
        link: `/g-hr/clearances/${head.id}`,
        requesterId,
      });
    } catch (err) {
      await prisma.employeeClearance.update({
        where: { id: head.id },
        data: { status: head.status, submittedAt: head.submittedAt },
      });
      throw err;
    }

    // The engine's SUBMITTED row names the requester (the leaver). This one
    // names the person who actually pressed the button.
    await audit(
      {
        entityType: 'clearance',
        entityId: head.id,
        action: 'SUBMITTED',
        summary: `${head.number} submitted for sign-off by ${me.name}${requesterId !== me.id ? ' on behalf of the leaver' : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

clearanceRoutes.post(
  '/:id/cancel',
  requireAny('ghr.clearances.edit_own', 'ghr.clearances.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const head = await loadClearance(req.params.id);
    if (!mayEdit(me, head)) throw forbidden('Only the person who raised this clearance, or HR, can cancel it');
    if (!['OPEN', 'PENDING_APPROVAL', 'REJECTED'].includes(head.status)) {
      throw badRequest(`A ${head.status.toLowerCase()} clearance cannot be cancelled`);
    }
    const body = parseBody(z.object({ reason: z.string().trim().optional().nullable() }), req.body ?? {});

    await prisma.$transaction(async (tx) => {
      await tx.employeeClearance.update({ where: { id: head.id }, data: { status: 'CANCELLED' } });
      await tx.approvalRequest.updateMany({
        where: { documentType: 'clearance', documentId: head.id, status: 'PENDING' },
        data: { status: 'CANCELLED', closedAt: new Date() },
      });
    });
    await audit(
      {
        entityType: 'clearance',
        entityId: head.id,
        action: 'CANCELLED',
        summary: `${head.number} cancelled${body.reason ? ` — ${body.reason}` : ''}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Print ────────────────────────────────────────────────────────────────────

clearanceRoutes.get(
  '/:id/pdf',
  requireAny('ghr.clearances.view_all', 'ghr.clearances.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const head = await loadClearance(req.params.id);
    assertCanView(me, head);
    const items = await prisma.clearanceItem.findMany({
      where: { clearanceId: head.id },
      include: { clearedBy: { select: { name: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    const signoffs = await approvalSignoffs('clearance', head.id);

    const e = head.employee;
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: 'Reason', value: REASON_LABEL[head.reason] },
          { label: 'Last working day', value: formatDate(head.lastWorkingDay) },
          { label: 'Date hired', value: e.dateHired ? formatDate(e.dateHired) : '—' },
          { label: 'Tenure', value: tenure(e.dateHired, head.lastWorkingDay) },
          { label: 'Employment type', value: e.employmentType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) },
          { label: 'Handed over to', value: head.handedOverTo?.name ?? '—' },
        ],
      },
    ];
    for (const area of CLEARANCE_AREAS) {
      const rows = items.filter((i) => i.area === area.key);
      if (!rows.length) continue;
      sections.push({
        kind: 'table',
        title: area.label,
        head: ['Item', 'Status', 'Cleared by', 'Date', 'Remarks'],
        widths: [46, 12, 16, 12, 14],
        rows: rows.map((i) => [
          i.description,
          i.status === 'CLEARED' ? 'Cleared' : i.status === 'WAIVED' ? 'Waived' : 'Pending',
          i.clearedBy?.name ?? (i.status === 'CLEARED' && i.sourceType ? 'From the record' : '—'),
          i.clearedAt ? formatDateTime(i.clearedAt) : '—',
          i.remarks ?? '',
        ]),
      });
    }
    if (head.notes) sections.push({ kind: 'text', title: 'Notes', body: head.notes });

    // Sign-offs in step order: supervisor, finance, HR. A slot the engine has
    // not filled prints "Pending" — no `at`, no borrowed date.
    const slot = (i: number) => (signoffs[i] ? { name: signoffs[i].name, position: signoffs[i].position, at: signoffs[i].at } : {});
    const pdf = await renderDocument({
      title: 'Employee Clearance',
      documentNumber: head.number,
      date: head.createdAt,
      reference: `${e.employeeNo} · ${fullName(e)} · ${e.position ?? '—'} · ${e.department?.name ?? '—'}`,
      sections,
      signatories: [
        { role: 'PREPARED BY', name: head.raisedBy.name, position: head.raisedBy.position ?? undefined, at: head.createdAt },
        { role: 'SUPERVISOR', ...slot(0) },
        { role: 'FINANCE', ...slot(1) },
        { role: 'HR', ...slot(2) },
        { role: 'RECEIVED BY', name: head.handedOverTo?.name, position: head.handedOverTo?.position ?? undefined },
      ],
      footerNote: 'Turnover of accountabilities — an item marked Waived carries its written reason above.',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${head.number}.pdf"`);
    res.send(pdf);
  }),
);

// ── The outcome ──────────────────────────────────────────────────────────────

/**
 * Approval records the separation. The employee's `dateSeparated` becomes
 * the last working day; if that day has already passed the employee and the
 * login are switched off here, otherwise `sweepSeparations()` does it on the
 * day. A rejection leaves the items as they are for HR to fix and resubmit.
 *
 * Errors are logged loudly, never thrown — the decision is the record of
 * fact, and the subscriber cannot roll it back.
 */
onApprovalSettled('clearance', async (approval, outcome) => {
  const head = await prisma.employeeClearance.findUnique({
    where: { id: approval.documentId },
    include: { employee: { include: { user: { select: { id: true, isActive: true } } } } },
  });
  if (!head) return;

  if (outcome !== 'APPROVED') {
    await prisma.employeeClearance.update({ where: { id: head.id }, data: { status: 'REJECTED' } });
    return;
  }

  const now = new Date();
  const today = dayKey(now);
  const gone = head.lastWorkingDay <= today;
  const e = head.employee;

  await prisma.$transaction(async (tx) => {
    await tx.employeeClearance.update({ where: { id: head.id }, data: { status: 'CLEARED', clearedAt: now } });
    await tx.employee.update({
      where: { id: e.id },
      data: {
        ...(e.dateSeparated ? {} : { dateSeparated: head.lastWorkingDay }),
        ...(gone ? { isActive: false } : {}),
      },
    });
    if (gone && e.user?.isActive) {
      await tx.user.update({ where: { id: e.user.id }, data: { isActive: false } });
    }
  });

  await audit({
    entityType: 'clearance',
    entityId: head.id,
    action: 'COMPLETED',
    summary: `${head.number} cleared — ${fullName(e)} separated ${formatDate(head.lastWorkingDay)}`,
  });
  if (gone) {
    await audit({
      entityType: 'employee',
      entityId: e.id,
      action: 'SEPARATED',
      summary: `${fullName(e)} separated on ${formatDate(head.lastWorkingDay)} — clearance ${head.number} approved`,
    });
    if (e.user?.isActive) {
      await audit({
        entityType: 'user',
        entityId: e.user.id,
        action: 'SEPARATED',
        summary: `Login closed — clearance ${head.number} approved`,
      });
    }
  }

  const recipients = new Set<string>([head.raisedById, ...(await usersInRole('hr'))]);
  await notify(
    [...recipients].map((userId) => ({
      userId,
      type: 'clearance.cleared' as const,
      title: `Cleared: ${head.number} — ${fullName(e)}`,
      body: gone
        ? 'The employee record and login have been closed.'
        : `Separation recorded for ${formatDate(head.lastWorkingDay)}; the record closes on the day.`,
      link: `/g-hr/clearances/${head.id}`,
    })),
  );
});

// ════════════════════════════════════════════════════════════════════
//  TURNOVER REPORT — /api/hr-reports/turnover (mounted before hrReportRoutes)
// ════════════════════════════════════════════════════════════════════

export const turnoverReportRoutes = Router();
turnoverReportRoutes.use(authenticate);

function reportWindow(req: { query: Record<string, unknown> }) {
  const defaults = trailingYear();
  const from = req.query.from ? asDay(String(req.query.from)) : defaults.from;
  const to = req.query.to ? asDay(String(req.query.to)) : defaults.to;
  if (to < from) throw badRequest('The end of the range is before its start');
  const where: Prisma.EmployeeWhereInput = {};
  if (req.query.departmentId) where.departmentId = String(req.query.departmentId);
  return { from, to, where };
}

turnoverReportRoutes.get(
  '/turnover',
  require_('ghr.reports.view_all'),
  handler(async (req, res) => {
    const { from, to, where } = reportWindow(req);
    res.json(await turnover(from, to, { where }));
  }),
);

turnoverReportRoutes.get(
  '/turnover.csv',
  require_('ghr.reports.export'),
  handler(async (req, res) => {
    const { from, to, where } = reportWindow(req);
    const report = await turnover(from, to, { where });

    // Logged BEFORE the bytes go out (the Phase 9 rule): an export that failed
    // to be recorded should not have happened.
    await audit(
      {
        entityType: 'hr_report',
        entityId: 'turnover',
        action: 'EXPORTED',
        summary: `Turnover ${formatDate(from)} – ${formatDate(to)}: ${report.months.length} month(s), ${report.leavers.length} leaver(s)`,
      },
      req,
    );

    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    const rows: (string | number | null)[][] = [
      ['Month', 'Opening', 'Hires', 'Separations', 'Closing', 'Rate %'],
      ...report.months.map((m) => [m.label, m.opening, m.hires, m.separations, m.closing, m.ratePct]),
      [],
      ['Employee No', 'Name', 'Department', 'Position', 'Hired', 'Separated', 'Tenure (mo)', 'Reason', 'Clearance No'],
      ...report.leavers.map((l) => [
        l.employeeNo,
        l.name,
        l.department?.name ?? '',
        l.position ?? '',
        day(l.dateHired),
        day(l.dateSeparated),
        l.tenureMonths,
        l.reason,
        l.clearance?.number ?? '',
      ]),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="turnover-${day(from)}-to-${day(to)}.csv"`);
    res.send(toCsv(rows));
  }),
);
