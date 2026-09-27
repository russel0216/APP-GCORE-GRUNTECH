import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, notFound, conflict } from '../http/kit';
import { authenticate, require_, requireAny } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { filledByPosition, mirrorPositionTitle, plantillaSummary } from '../shared/plantilla';
import { sweepSeparations } from '../shared/clearance';

/**
 * The plantilla — positions per department, how many of each are authorised,
 * who fills them and what is vacant (model §4.7).
 *
 * Filled and vacant are computed on every read off active employees. There
 * is no stored count to go stale, and no route here can make one.
 */

export const positionRoutes = Router();
positionRoutes.use(authenticate);

const HOLDER_PREVIEW = 5;

positionRoutes.get(
  '/',
  require_('ghr.plantilla.view_all'),
  handler(async (req, res) => {
    await sweepSeparations();
    const q = listQuery(req);
    const where: Prisma.PositionWhereInput = {};
    if (q.filters.departmentId) where.departmentId = q.filters.departmentId;
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.search) {
      where.OR = [
        { title: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    // The derived filters (vacant, over) and sort keys need the counts, so the
    // page is cut in memory. A plantilla is dozens of rows, not thousands.
    const positions = await prisma.position.findMany({
      where,
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ department: { name: 'asc' } }, { sortOrder: 'asc' }, { title: 'asc' }],
    });
    const filled = await filledByPosition(positions.map((p) => p.id));

    let rows = positions.map((p) => {
      const f = filled.get(p.id) ?? 0;
      return { ...p, filled: f, vacant: p.authorisedHeadcount - f };
    });
    if (q.filters.vacant === 'true') rows = rows.filter((r) => r.vacant > 0);
    if (q.filters.over === 'true') rows = rows.filter((r) => r.vacant < 0);

    const dir = q.dir === 'asc' ? 1 : -1;
    if (q.sort === 'title') rows.sort((a, b) => dir * a.title.localeCompare(b.title));
    else if (q.sort === 'department') {
      rows.sort((a, b) => dir * (a.department?.name ?? '').localeCompare(b.department?.name ?? ''));
    } else if (q.sort === 'authorisedHeadcount') rows.sort((a, b) => dir * (a.authorisedHeadcount - b.authorisedHeadcount));
    else if (q.sort === 'filled') rows.sort((a, b) => dir * (a.filled - b.filled));
    else if (q.sort === 'vacant') rows.sort((a, b) => dir * (a.vacant - b.vacant));

    const total = rows.length;
    const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

    const holders = page.length
      ? await prisma.employee.findMany({
          where: { positionId: { in: page.map((p) => p.id) }, isActive: true },
          select: { id: true, employeeNo: true, firstName: true, lastName: true, employmentType: true, positionId: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        })
      : [];
    const holdersBy = new Map<string, typeof holders>();
    for (const h of holders) {
      const list = holdersBy.get(h.positionId!) ?? [];
      list.push(h);
      holdersBy.set(h.positionId!, list);
    }

    res.json(
      listResult(
        page.map((p) => {
          const list = holdersBy.get(p.id) ?? [];
          return {
            id: p.id,
            code: p.code,
            title: p.title,
            description: p.description,
            isActive: p.isActive,
            sortOrder: p.sortOrder,
            authorisedHeadcount: p.authorisedHeadcount,
            department: p.department,
            filled: p.filled,
            vacant: p.vacant,
            holderCount: list.length,
            holders: list.slice(0, HOLDER_PREVIEW).map((h) => ({
              id: h.id,
              employeeNo: h.employeeNo,
              name: `${h.firstName} ${h.lastName}`,
              employmentType: h.employmentType,
            })),
          };
        }),
        total,
        q,
      ),
    );
  }),
);

// Also the HR dashboard's plantilla tile — aggregate counts, no names.
positionRoutes.get(
  '/summary',
  requireAny('ghr.plantilla.view_all', 'ghr.dashboard.view_all'),
  handler(async (_req, res) => {
    await sweepSeparations();
    res.json(await plantillaSummary());
  }),
);

/**
 * The picker on the employee form and on a course's requirements. Naming a
 * position is not the plantilla right, so the employee and course keys are
 * enough here.
 */
positionRoutes.get(
  '/lookup',
  requireAny(
    'ghr.employees.view_all',
    'ghr.plantilla.view_all',
    'ghr.courses.view_all',
    'ghr.courses.create',
    'ghr.courses.edit_all',
  ),
  handler(async (_req, res) => {
    const positions = await prisma.position.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        title: true,
        departmentId: true,
        authorisedHeadcount: true,
        department: { select: { name: true } },
      },
      orderBy: [{ department: { name: 'asc' } }, { title: 'asc' }],
    });
    const filled = await filledByPosition(positions.map((p) => p.id));
    res.json(
      positions.map((p) => ({
        id: p.id,
        code: p.code,
        title: p.title,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        authorisedHeadcount: p.authorisedHeadcount,
        filled: filled.get(p.id) ?? 0,
      })),
    );
  }),
);

positionRoutes.get(
  '/:id',
  require_('ghr.plantilla.view_all'),
  handler(async (req, res) => {
    const position = await prisma.position.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        employees: {
          where: { isActive: true },
          select: { id: true, employeeNo: true, firstName: true, lastName: true, employmentType: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        },
      },
    });
    if (!position) throw notFound('Position not found');
    const { employees, ...rest } = position;
    res.json({
      ...rest,
      filled: employees.length,
      vacant: position.authorisedHeadcount - employees.length,
      holderCount: employees.length,
      holders: employees.map((h) => ({
        id: h.id,
        employeeNo: h.employeeNo,
        name: `${h.firstName} ${h.lastName}`,
        employmentType: h.employmentType,
      })),
    });
  }),
);

const positionSchema = z.object({
  code: z.string().trim().optional().nullable(),
  title: z.string().trim().min(2, 'A title needs at least two characters'),
  departmentId: z.string().optional().nullable(),
  authorisedHeadcount: z.number().int().min(0, 'Authorised headcount cannot be negative').default(1),
  description: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

async function assertUniqueTitle(
  tx: Prisma.TransactionClient,
  title: string,
  departmentId: string | null,
  exceptId?: string,
) {
  const clash = await tx.position.findFirst({
    where: {
      title: { equals: title, mode: 'insensitive' },
      departmentId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { code: true },
  });
  if (clash) {
    throw conflict(
      `"${title}" already exists${departmentId ? ' in that department' : ''} as ${clash.code} — edit its headcount instead of adding a second one`,
    );
  }
}

positionRoutes.post(
  '/',
  require_('ghr.plantilla.create'),
  handler(async (req, res) => {
    const body = parseBody(positionSchema, req.body);

    const position = await prisma.$transaction(async (tx) => {
      const departmentId = body.departmentId || null;
      await assertUniqueTitle(tx, body.title, departmentId);
      const code = body.code || (await nextNumber('position', tx));
      if (body.code && (await tx.position.findUnique({ where: { code } }))) {
        throw conflict(`Position code "${code}" is already in use`);
      }
      return tx.position.create({
        data: {
          code,
          title: body.title,
          departmentId,
          authorisedHeadcount: body.authorisedHeadcount,
          description: body.description || null,
          sortOrder: body.sortOrder ?? 0,
          isActive: body.isActive ?? true,
        },
        include: { department: { select: { id: true, name: true } } },
      });
    });

    await audit(
      {
        entityType: 'position',
        entityId: position.id,
        action: 'CREATED',
        summary: `Created position ${position.code} — ${position.title} (${position.authorisedHeadcount} authorised)`,
      },
      req,
    );
    res.status(201).json({ ...position, filled: 0, vacant: position.authorisedHeadcount, holders: [], holderCount: 0 });
  }),
);

positionRoutes.patch(
  '/:id',
  require_('ghr.plantilla.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(positionSchema.partial(), req.body);
    const before = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Position not found');

    const position = await prisma.$transaction(async (tx) => {
      const title = body.title ?? before.title;
      const departmentId = body.departmentId !== undefined ? body.departmentId || null : before.departmentId;
      if (title !== before.title || departmentId !== before.departmentId) {
        await assertUniqueTitle(tx, title, departmentId, before.id);
      }
      if (body.code && body.code !== before.code) {
        if (await tx.position.findUnique({ where: { code: body.code } })) {
          throw conflict(`Position code "${body.code}" is already in use`);
        }
      }
      const updated = await tx.position.update({
        where: { id: before.id },
        data: {
          ...(body.code ? { code: body.code } : {}),
          title,
          departmentId,
          ...(body.authorisedHeadcount !== undefined ? { authorisedHeadcount: body.authorisedHeadcount } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
        include: { department: { select: { id: true, name: true } } },
      });
      // The mirror rule: a renamed position renames every holder's title.
      if (title !== before.title) await mirrorPositionTitle(tx, before.id, title);
      return updated;
    });

    await audit(
      {
        entityType: 'position',
        entityId: position.id,
        action: 'UPDATED',
        summary: `Updated position ${position.code} — ${position.title}`,
        before,
        after: position,
      },
      req,
    );
    const filled = (await filledByPosition([position.id])).get(position.id) ?? 0;
    res.json({ ...position, filled, vacant: position.authorisedHeadcount - filled });
  }),
);

positionRoutes.delete(
  '/:id',
  require_('ghr.plantilla.delete'),
  handler(async (req, res) => {
    const position = await prisma.position.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { employees: true } } },
    });
    if (!position) throw notFound('Position not found');
    // Active or not: an employee record keeps its counterpart (the Phase 2 rule).
    if (position._count.employees > 0) {
      throw conflict(
        `${position.title} has ${position._count.employees} employee(s) on it — deactivate it instead`,
      );
    }
    await prisma.position.delete({ where: { id: position.id } });
    await audit(
      {
        entityType: 'position',
        entityId: position.id,
        action: 'DELETED',
        summary: `Deleted position ${position.code} — ${position.title}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);
