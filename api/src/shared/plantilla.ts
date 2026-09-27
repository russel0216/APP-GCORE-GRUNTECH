import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, notFound } from '../http/kit';
import { nextNumber } from './numbering';

/**
 * The plantilla — the authorised staffing pattern (model §4.7).
 *
 * A `Position` is a job title, the department it sits in and how many of it
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
  return tx.employee.update({ where: { id: employeeId }, data });
}

/**
 * A title change reaches every holder of the position — the other half of
 * the mirror rule. Called by PATCH /positions inside its transaction.
 */
export async function mirrorPositionTitle(tx: Tx, positionId: string, title: string): Promise<number> {
  const { count } = await tx.employee.updateMany({
    where: { positionId },
    data: { position: title },
  });
  return count;
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
  byDepartment: {
    department: { id: string; name: string } | null;
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
        department: { select: { id: true, name: true } },
      },
    }),
    filledByPosition(),
    prisma.employee.count({ where: { isActive: true, positionId: null } }),
  ]);

  const byDept = new Map<string, PlantillaSummary['byDepartment'][number]>();
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

    const key = p.department?.id ?? '';
    const row = byDept.get(key) ?? {
      department: p.department,
      authorised: 0,
      filled: 0,
      vacant: 0,
      overComplement: 0,
    };
    row.authorised += p.authorisedHeadcount;
    row.filled += f;
    if (gap > 0) row.vacant += gap;
    else row.overComplement += -gap;
    byDept.set(key, row);
  }

  // Filled positions that lost their department still count; the "unassigned"
  // bucket sorts last so the named departments read first.
  const byDepartment = [...byDept.values()].sort((a, b) => {
    if (!a.department) return 1;
    if (!b.department) return -1;
    return a.department.name.localeCompare(b.department.name);
  });

  return { authorised, filled: filledTotal, vacant, overComplement: over, unclassified, byDepartment };
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
    select: { id: true, position: true, departmentId: true, isActive: true },
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
        const departments = new Set(active.map((h) => h.departmentId));
        position = await tx.position.create({
          data: {
            code: await nextNumber('position', tx),
            title,
            departmentId: departments.size === 1 ? [...departments][0] : null,
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
