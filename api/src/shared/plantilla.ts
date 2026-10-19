import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, notFound } from '../http/kit';
import { nextNumber } from './numbering';
import { titleFromRoles } from './roleRev1';

/**
 * The plantilla — the authorised staffing pattern (model §4.7).
 *
 * A `Position` is a job title (since 2026-10-19 counting a role's holders) and how many of it
 * the company has approved. Filled and vacant are DERIVED by counting active
 * employees on the position, never stored: a stored copy can disagree with
 * the employees it counts, and the whole point of the screen is that it is
 * right the moment someone is hired or cleared.
 *
 * `Employee.position` (the string) stays, because search, the attendance CSV,
 * PDFs and every people list read it. It is a MIRROR of `positionRef.title`,
 * and this module is the only thing that writes it for a linked employee.
 * Free text survives only on an employee with no plantilla position — the
 * "unclassified" the Plantilla screen counts.
 */

type Tx = Prisma.TransactionClient;

// ── The one writer of the mirror ─────────────────────────────────────────────

/**
 * What to write on an employee for a position choice.
 *
 * With a `positionId`: the position must exist and be active, and `position`
 * becomes its title — the free text is ignored, whatever the caller typed.
 * With null: the link is dropped and the free text is kept as it is.
 *
 * Used by employee create (which has no row to update yet) and by
 * `setEmployeePosition()` below, so a create and a patch cannot disagree.
 */
export async function positionFields(
  tx: Tx,
  positionId: string | null | undefined,
  freeText: string | null | undefined,
): Promise<{ positionId: string | null; position: string | null }> {
  if (!positionId) {
    return { positionId: null, position: freeText?.trim() || null };
  }
  const position = await tx.position.findUnique({
    where: { id: positionId },
    select: { id: true, title: true, isActive: true },
  });
  if (!position) throw notFound('That plantilla position does not exist');
  if (!position.isActive) {
    throw badRequest(`"${position.title}" is an inactive position — reactivate it in the Plantilla first`);
  }
  return { positionId: position.id, position: position.title };
}

/**
 * Puts an employee on a plantilla position (or takes them off one), writing
 * the mirror in the same statement.
 */
export async function setEmployeePosition(
  tx: Tx,
  employeeId: string,
  positionId: string | null,
  freeText: string | null | undefined,
) {
  const data = await positionFields(tx, positionId, freeText);
  // Off the plantilla, nothing else is held beside it.
  if (!data.positionId) await tx.employeeExtraPosition.deleteMany({ where: { employeeId } });
  else await tx.employeeExtraPosition.deleteMany({ where: { employeeId, positionId: data.positionId } });
  await tx.employee.update({ where: { id: employeeId }, data });
  return refreshPositionTitle(tx, employeeId);
}

/** The joined title: the main position's, then each one also held, " / " between. */
export const POSITION_JOIN = ' / ';

/**
 * Re-derives an employee's mirrored title (and their login's) from the main
 * position and the ones also held. Free text on an unlinked employee is left.
 */
export async function refreshPositionTitle(tx: Tx, employeeId: string) {
  const e = await tx.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: {
      positionId: true,
      positionRef: { select: { title: true } },
      extraPositions: { orderBy: { sortOrder: 'asc' }, select: { position: { select: { title: true } } } },
      user: { select: { id: true, roles: { select: { role: { select: { name: true, rank: true, sortOrder: true } } } } } },
    },
  });
  // A person with roles is titled by the highest of them (ROLE_REV1, 2026-10-19).
  const byRole = e.user ? titleFromRoles(e.user.roles.map((r) => r.role)) : null;
  if (byRole) {
    await tx.user.update({ where: { id: e.user!.id }, data: { position: byRole } });
    return tx.employee.update({ where: { id: employeeId }, data: { position: byRole } });
  }
  if (!e.positionId || !e.positionRef) return tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
  const title = [e.positionRef.title, ...e.extraPositions.map((x) => x.position.title)].join(POSITION_JOIN);
  await tx.user.updateMany({ where: { employee: { id: employeeId } }, data: { position: title } });
  return tx.employee.update({ where: { id: employeeId }, data: { position: title } });
}

/**
 * Sets the positions an employee ALSO holds, replaced whole, in order. Needs a
 * main position; each must be active; the main one and repeats are dropped.
 */
export async function setExtraPositions(tx: Tx, employeeId: string, positionIds: string[]) {
  const e = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { positionId: true } });
  const ids = [...new Set(positionIds.map((x) => x.trim()).filter(Boolean))].filter((x) => x !== e.positionId);
  if (ids.length && !e.positionId) throw badRequest('Choose the main plantilla position first');
  if (ids.length) {
    const found = await tx.position.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, isActive: true } });
    if (found.length !== ids.length) throw notFound('One of those plantilla positions does not exist');
    const off = found.find((p) => !p.isActive);
    if (off) throw badRequest(`"${off.title}" is an inactive position — reactivate it in the Plantilla first`);
  }
  await tx.employeeExtraPosition.deleteMany({ where: { employeeId } });
  if (ids.length) {
    await tx.employeeExtraPosition.createMany({ data: ids.map((positionId, sortOrder) => ({ employeeId, positionId, sortOrder })) });
  }
  return refreshPositionTitle(tx, employeeId);
}

/**
 * A title change reaches every holder of the position — the other half of
 * the mirror rule. Called by PATCH /positions inside its transaction.
 */
export async function mirrorPositionTitle(tx: Tx, positionId: string, title: string): Promise<number> {
  const { count } = await tx.employee.updateMany({
    where: { positionId, extraPositions: { none: {} } },
    data: { position: title },
  });
  // And their logins, which mirror the employee (shared/accounts.ts,
  // `syncLoginFromEmployee` — 2026-10-16).
  await tx.user.updateMany({ where: { employee: { positionId, extraPositions: { none: {} } } }, data: { position: title } });
  // Anyone holding it beside another has a joined title to work out again.
  const joined = await tx.employee.findMany({
    where: { OR: [{ positionId, extraPositions: { some: {} } }, { extraPositions: { some: { positionId } } }] },
    select: { id: true },
  });
  for (const j of joined) await refreshPositionTitle(tx, j.id);
  return count + joined.length;
}

// ── Derived figures ──────────────────────────────────────────────────────────

/** Active employees per position, in one groupBy. */
export async function filledByPosition(
  positionIds?: string[],
  tx: Tx = prisma,
): Promise<Map<string, number>> {
  const groups = await tx.employee.groupBy({
    by: ['positionId'],
    where: {
      isActive: true,
      positionId: positionIds ? { in: positionIds } : { not: null },
    },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const g of groups) if (g.positionId) out.set(g.positionId, g._count._all);
  // A slot that counts a role (ROLE_REV1, 2026-10-19: "keep plantilla, count
  // by role") is filled by the active employees whose login holds the role.
  const byRole = await tx.position.findMany({
    where: { roleId: { not: null }, ...(positionIds ? { id: { in: positionIds } } : {}) },
    select: { id: true, roleId: true },
  });
  if (byRole.length) {
    const holders = await tx.userRole.groupBy({
      by: ['roleId'],
      where: { roleId: { in: byRole.map((p) => p.roleId!) }, user: { isActive: true, employee: { isActive: true } } },
      _count: { _all: true },
    });
    const n = new Map(holders.map((h) => [h.roleId, h._count._all]));
    for (const p of byRole) out.set(p.id, n.get(p.roleId!) ?? 0);
    return out;
  }
  // A position also held counts its holder as filling it.
  const extra = await tx.employeeExtraPosition.groupBy({
    by: ['positionId'],
    where: { employee: { isActive: true }, ...(positionIds ? { positionId: { in: positionIds } } : {}) },
    _count: { _all: true },
  });
  for (const g of extra) out.set(g.positionId, (out.get(g.positionId) ?? 0) + g._count._all);
  return out;
}

export interface PlantillaSummary {
  authorised: number;
  filled: number;
  /** Sum of the positive vacancies. */
  vacant: number;
  /** Sum of the over-complement — people beyond what is authorised. */
  overComplement: number;
  /** Active employees with no plantilla position at all. */
  unclassified: number;
  /**
   * By LEVEL (2026-10-19, the owner's call: the department is gone; the
   * Plantilla counts by role, so it reads down the levels of the roles its
   * positions count — `Role.rank`, 1 the CEO / President). A position that
   * counts no role, or one with no level, is "No level", last.
   */
  byLevel: {
    level: number | null;
    authorised: number;
    filled: number;
    vacant: number;
    overComplement: number;
  }[];
}

/**
 * The figures on the Plantilla screen and the HR dashboard tiles. Both read
 * this, so they cannot disagree; verify-plantilla asserts the dashboard's
 * copy against a count taken directly.
 */
export async function plantillaSummary(): Promise<PlantillaSummary> {
  const [positions, filled, unclassified] = await Promise.all([
    prisma.position.findMany({
      where: { isActive: true },
      select: {
        id: true,
        authorisedHeadcount: true,
        role: { select: { rank: true } },
      },
    }),
    filledByPosition(),
    prisma.employee.count({ where: { isActive: true, positionId: null, OR: [{ userId: null }, { user: { roles: { none: {} } } }] } }),
  ]);

  const byLevelMap = new Map<number | null, PlantillaSummary['byLevel'][number]>();
  let authorised = 0;
  let filledTotal = 0;
  let vacant = 0;
  let over = 0;

  for (const p of positions) {
    const f = filled.get(p.id) ?? 0;
    const gap = p.authorisedHeadcount - f;
    authorised += p.authorisedHeadcount;
    filledTotal += f;
    if (gap > 0) vacant += gap;
    else over += -gap;

    const key = p.role?.rank ?? null;
    const row = byLevelMap.get(key) ?? {
      level: key,
      authorised: 0,
      filled: 0,
      vacant: 0,
      overComplement: 0,
    };
    row.authorised += p.authorisedHeadcount;
    row.filled += f;
    if (gap > 0) row.vacant += gap;
    else row.overComplement += -gap;
    byLevelMap.set(key, row);
  }

  // Level 1 first; "No level" last.
  const byLevel = [...byLevelMap.values()].sort((a, b) => (a.level ?? Infinity) - (b.level ?? Infinity));

  return { authorised, filled: filledTotal, vacant, overComplement: over, unclassified, byLevel };
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * Links every employee whose `position` is free text to a Position of that
 * title, creating the position when there is none. Idempotent: employees
 * already linked are not touched, and an empty title stays unclassified.
 *
 * The seed carries its own copy of this today; this export exists so the seed
 * can import it instead once the orchestrator prefers one definition.
 *
 * Day one prints 100% filled and 0 vacant — `authorisedHeadcount` starts at
 * the number of active holders, so nothing is authorised beyond what exists
 * until HR edits the figure.
 */
export async function backfillPositions(): Promise<{ linked: number; positions: number }> {
  const unlinked = await prisma.employee.findMany({
    where: { positionId: null, position: { not: null } },
    select: { id: true, position: true, isActive: true },
  });

  const byTitle = new Map<string, { title: string; holders: typeof unlinked }>();
  for (const e of unlinked) {
    const title = (e.position ?? '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    const group = byTitle.get(key) ?? { title, holders: [] };
    group.holders.push(e);
    byTitle.set(key, group);
  }

  let linked = 0;
  let positions = 0;
  for (const { title, holders } of byTitle.values()) {
    await prisma.$transaction(async (tx) => {
      let position = await tx.position.findFirst({
        where: { title: { equals: title, mode: 'insensitive' } },
      });
      if (!position) {
        const active = holders.filter((h) => h.isActive);
        position = await tx.position.create({
          data: {
            code: await nextNumber('position', tx),
            title,
            authorisedHeadcount: active.length,
          },
        });
      }
      const { count } = await tx.employee.updateMany({
        where: { id: { in: holders.map((h) => h.id) } },
        data: { positionId: position.id, position: position.title },
      });
      linked += count;
      positions += 1;
    });
  }

  return { linked, positions };
}
