import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, idsFilter, notFound, conflict, badRequest, type ListQuery } from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { requireView, requireEdit, ownOnly, assertCanView, assertCanEdit, mayEdit } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { filledByPosition, mirrorPositionTitle, plantillaSummary } from '../shared/plantilla';
import { sweepSeparations } from '../shared/clearance';
import { renderDocument } from '../shared/pdf';
import { LIST_CAP, listReference, sendListPdf } from '../shared/listPaper';

/**
 * The plantilla — positions (each counting a role since 2026-10-19), how many
 * of each are authorised, who fills them and what is vacant (model §4.7). The
 * department is gone (2026-10-19, the owner's call): positions read by the
 * LEVEL of the role they count, and a title is one position company-wide.
 *
 * Filled and vacant are computed on every read off active employees. There
 * is no stored count to go stale, and no route here can make one.
 */

export const positionRoutes = Router();
positionRoutes.use(authenticate);

const HOLDER_PREVIEW = 5;

type PositionRow = Prisma.PositionGetPayload<{ include: { role: { select: { id: true; name: true; rank: true } } } }> & {
  filled: number;
  vacant: number;
};

/**
 * The plantilla list's rows — the screen's and the printed list's, from one
 * query. Filled and vacant are counted on read (never stored), so the
 * derived filters (vacant, over) and sort keys run over the counted rows in
 * memory: a plantilla is dozens of rows, not thousands. `?ids=` narrows to
 * the rows ticked. A View Own holder (2026-10-18) gets the positions they
 * added and nothing else — the screen and the paper alike.
 */
async function plantillaRows(me: ReturnType<typeof currentUser>, q: ListQuery): Promise<PositionRow[]> {
  const where: Prisma.PositionWhereInput = {};
  // The level of the role a position counts (`Role.rank`), or `none`.
  const level = q.filters.level;
  if (level === 'none') where.OR = [{ roleId: null }, { role: { rank: null } }];
  else if (level) {
    if (!/^\d+$/.test(level)) throw badRequest('Level: a number, or none');
    where.role = { rank: Number(level) };
  }
  if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
  if (q.search) {
    where.AND = [
      {
        OR: [
          { title: { contains: q.search, mode: 'insensitive' } },
          { code: { contains: q.search, mode: 'insensitive' } },
        ],
      },
    ];
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };

  const positions = await prisma.position.findMany({
    where: ownOnly(me, 'ghr', 'plantilla', where, (ids) => ({ createdById: { in: ids } })),
    include: { role: { select: { id: true, name: true, rank: true } } },
    // Level 1 first (Postgres sorts nulls last ascending), then the chart's order.
    orderBy: [{ role: { rank: 'asc' } }, { sortOrder: 'asc' }, { title: 'asc' }],
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
  else if (q.sort === 'level') {
    rows.sort((a, b) => dir * ((a.role?.rank ?? 99) - (b.role?.rank ?? 99)));
  } else if (q.sort === 'authorisedHeadcount') rows.sort((a, b) => dir * (a.authorisedHeadcount - b.authorisedHeadcount));
  else if (q.sort === 'filled') rows.sort((a, b) => dir * (a.filled - b.filled));
  else if (q.sort === 'vacant') rows.sort((a, b) => dir * (a.vacant - b.vacant));
  return rows;
}

/** The active holders of these positions, by position, A–Z. */
async function holdersOf(positionIds: string[]) {
  const holders = positionIds.length
    ? await prisma.employee.findMany({
        where: { positionId: { in: positionIds }, isActive: true },
        select: { id: true, employeeNo: true, firstName: true, lastName: true, employmentType: true, positionId: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      })
    : [];
  const by = new Map<string, typeof holders>();
  for (const h of holders) {
    const list = by.get(h.positionId!) ?? [];
    list.push(h);
    by.set(h.positionId!, list);
  }
  return by;
}

positionRoutes.get(
  '/',
  requireView('ghr', 'plantilla'),
  handler(async (req, res) => {
    await sweepSeparations();
    const me = currentUser(req);
    const q = listQuery(req);
    const rows = await plantillaRows(me, q);
    const total = rows.length;
    const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const holdersBy = await holdersOf(page.map((p) => p.id));

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
            role: p.role,
            level: p.role?.rank ?? null,
            filled: p.filled,
            vacant: p.vacant,
            createdById: p.createdById,
            canEdit: mayEdit(me, 'ghr', 'plantilla', p.createdById === me.id, p.createdById),
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

/**
 * The plantilla on paper — the list as filtered (or the rows ticked),
 * through `plantillaRows`, so the paper is the screen it was printed off:
 * each position, its level, authorised against filled, the gap, and
 * every active holder by name (the screen shows five; the paper is the
 * record, so it names them all). Names and posts only — never a rate. The
 * headcount under the table adds up the rows the filter matched. Declared
 * above `/:id`, or that route swallows it.
 */
positionRoutes.get(
  '/pdf',
  requireView('ghr', 'plantilla'),
  handler(async (req, res) => {
    await sweepSeparations();
    const q = listQuery(req);
    const f = q.filters;
    const all = await plantillaRows(currentUser(req), q);
    const rows = all.slice(0, LIST_CAP);
    const holdersBy = await holdersOf(rows.map((p) => p.id));

    const reference = listReference(all.length, rows.length, ['position', 'positions'], [
      q.search && `search "${q.search}"`,
      f.level && (f.level === 'none' ? 'no level' : `level ${f.level}`),
      f.vacant === 'true' && 'with vacancies',
      f.over === 'true' && 'over complement',
      f.isActive && (f.isActive === 'true' ? 'active' : 'inactive'),
      f.ids && 'the rows selected',
    ]);
    let authorised = 0;
    let filled = 0;
    let vacant = 0;
    let over = 0;
    for (const p of all) {
      authorised += p.authorisedHeadcount;
      filled += p.filled;
      if (p.vacant > 0) vacant += p.vacant;
      else over -= p.vacant;
    }
    const n = (v: number) => v.toLocaleString('en-PH');

    // Eight columns: landscape (rule 6). The gap is a vacancy, or the
    // over-complement as a negative — shown, never refused, as on screen.
    const pdf = await renderDocument({
      title: 'Plantilla',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Position', 'Level', 'Authorised', 'Filled', 'Vacant', 'Holders', 'Status'],
          align: ['left', 'left', 'left', 'right', 'right', 'right', 'left', 'left'],
          rows: rows.map((p) => {
            const holders = holdersBy.get(p.id) ?? [];
            return [
              p.code ?? '—',
              p.description ? { title: p.title, body: p.description } : p.title,
              p.role?.rank != null ? `Level ${p.role.rank}` : '—',
              n(p.authorisedHeadcount),
              n(p.filled),
              p.vacant < 0 ? `${n(-p.vacant)} over` : n(p.vacant),
              holders.length ? holders.map((h) => `${h.firstName} ${h.lastName}`).join(', ') : '—',
              p.isActive ? 'Active' : 'Inactive',
            ];
          }),
        },
        {
          kind: 'text',
          title: 'Headcount',
          body:
            `Authorised ${n(authorised)} · filled ${n(filled)} · vacant ${n(vacant)}` +
            (over ? ` · over complement ${n(over)}` : '') +
            `, across the ${n(all.length)} position${all.length === 1 ? '' : 's'} listed. ` +
            'Filled counts active employees on each position, on the day this was printed.',
        },
      ],
    });
    await audit(
      { entityType: 'position', entityId: 'list', action: 'EXPORTED', summary: `Exported the plantilla as PDF (${rows.length} position(s))` },
      req,
    );
    sendListPdf(res, pdf, 'plantilla.pdf');
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

/** The roles a Plantilla slot may count (2026-10-19), names only — above `/:id`. */
positionRoutes.get(
  '/roles',
  requireView('ghr', 'plantilla'),
  handler(async (_req, res) => {
    res.json(await prisma.role.findMany({ select: { id: true, name: true, rank: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
  }),
);

/**
 * The picker on the employee form and on a course's requirements. Naming a
 * position is not the plantilla right, so the employee, course and hiring
 * keys are enough here.
 */
positionRoutes.get(
  '/lookup',
  requireAny(
    'ghr.employees.view_all',
    'ghr.plantilla.view_all',
    'ghr.courses.view_all',
    'ghr.courses.create',
    'ghr.courses.edit_all',
    // A Man Power Request and a contract name the slot they fill (2026-10-21).
    'ghr.manpower_requests.create',
    'ghr.employment_contracts.create',
  ),
  handler(async (_req, res) => {
    const positions = await prisma.position.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        title: true,
        authorisedHeadcount: true,
        role: { select: { rank: true } },
      },
      orderBy: [{ role: { rank: 'asc' } }, { title: 'asc' }],
    });
    const filled = await filledByPosition(positions.map((p) => p.id));
    res.json(
      positions.map((p) => ({
        id: p.id,
        code: p.code,
        title: p.title,
        level: p.role?.rank ?? null,
        authorisedHeadcount: p.authorisedHeadcount,
        filled: filled.get(p.id) ?? 0,
      })),
    );
  }),
);

positionRoutes.get(
  '/:id',
  requireView('ghr', 'plantilla'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const position = await prisma.position.findUnique({
      where: { id: req.params.id },
      include: {
        role: { select: { id: true, name: true, rank: true } },
        employees: {
          where: { isActive: true },
          select: { id: true, employeeNo: true, firstName: true, lastName: true, employmentType: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        },
      },
    });
    if (!position) throw notFound('Position not found');
    // View Own reads only the positions the caller added (2026-10-18).
    assertCanView(me, 'ghr', 'plantilla', position.createdById === me.id, position.createdById);
    // A slot that counts a role is held by the role's active holders (2026-10-19).
    const employees = position.roleId
      ? await prisma.employee.findMany({
          where: { isActive: true, user: { isActive: true, roles: { some: { roleId: position.roleId } } } },
          select: { id: true, employeeNo: true, firstName: true, lastName: true, employmentType: true },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        })
      : position.employees;
    const { employees: _legacy, ...rest } = position;
    res.json({
      ...rest,
      canEdit: mayEdit(me, 'ghr', 'plantilla', position.createdById === me.id, position.createdById),
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
  authorisedHeadcount: z.number().int().min(0, 'Authorised headcount cannot be negative').default(1),
  description: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  /** The role this slot counts (2026-10-19): filled = active holders of it. */
  roleId: z.string().optional().nullable(),
});

async function checkRole(tx: Prisma.TransactionClient, roleId: string | null | undefined): Promise<string | null> {
  if (!roleId) return null;
  if (!(await tx.role.findUnique({ where: { id: roleId }, select: { id: true } }))) throw badRequest('roleId: that role was not found');
  return roleId;
}

/** One position per title, company-wide (the department that told two apart is gone). */
async function assertUniqueTitle(tx: Prisma.TransactionClient, title: string, exceptId?: string) {
  const clash = await tx.position.findFirst({
    where: {
      title: { equals: title, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { code: true },
  });
  if (clash) {
    throw conflict(`"${title}" already exists as ${clash.code} — edit its headcount instead of adding a second one`);
  }
}

positionRoutes.post(
  '/',
  require_('ghr.plantilla.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(positionSchema, req.body);

    const position = await prisma.$transaction(async (tx) => {
      await assertUniqueTitle(tx, body.title);
      const code = body.code || (await nextNumber('position', tx));
      if (body.code && (await tx.position.findUnique({ where: { code } }))) {
        throw conflict(`Position code "${code}" is already in use`);
      }
      return tx.position.create({
        data: {
          code,
          title: body.title,
          authorisedHeadcount: body.authorisedHeadcount,
          description: body.description || null,
          sortOrder: body.sortOrder ?? 0,
          isActive: body.isActive ?? true,
          roleId: await checkRole(tx, body.roleId),
          // Who added it — what "own" means on the plantilla (2026-10-18).
          createdById: me.id,
        },
        include: { role: { select: { id: true, name: true, rank: true } } },
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
    res.status(201).json({ ...position, filled: 0, vacant: position.authorisedHeadcount, holders: [], holderCount: 0, canEdit: mayEdit(me, 'ghr', 'plantilla', true) });
  }),
);

positionRoutes.patch(
  '/:id',
  requireEdit('ghr', 'plantilla'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(positionSchema.partial(), req.body);
    const before = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Position not found');
    // Edit Own changes only the positions the caller added (2026-10-18).
    assertCanEdit(me, 'ghr', 'plantilla', before.createdById === me.id, before.createdById);

    const position = await prisma.$transaction(async (tx) => {
      const title = body.title ?? before.title;
      if (title.toLowerCase() !== before.title.toLowerCase()) await assertUniqueTitle(tx, title, before.id);
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
          ...(body.authorisedHeadcount !== undefined ? { authorisedHeadcount: body.authorisedHeadcount } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.roleId !== undefined ? { roleId: await checkRole(tx, body.roleId) } : {}),
        },
        include: { role: { select: { id: true, name: true, rank: true } } },
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
    res.json({ ...position, filled, vacant: position.authorisedHeadcount - filled, canEdit: true });
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
