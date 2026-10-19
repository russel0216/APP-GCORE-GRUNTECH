import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * More than one costing behind a quotation or a project (2026-10-19, the
 * owner's call: "sometimes there will be 2 costings to generate the quotation
 * or project"). The first stays on the record's own `costingId`; the others
 * are `QuotationRevisionCosting` / `JobCostingLink` rows, in order. These are
 * the only readers and the one writer of that split, so nothing else has to
 * remember there are two places.
 */

type Tx = Prisma.TransactionClient;

/** Ids as given, trimmed, blanks and repeats dropped, order kept. */
export function cleanCostingIds(ids: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = (raw ?? '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The costings a body names: `costingIds` when sent, else the single
 * `costingId` (every caller before 2026-10-19). Undefined when it names
 * neither, so a PATCH that leaves them out keeps what is on file.
 */
export function costingIdsOf(body: { costingId?: string | null; costingIds?: (string | null)[] | null }): string[] | undefined {
  if (body.costingIds !== undefined && body.costingIds !== null) return cleanCostingIds(body.costingIds);
  if (body.costingId !== undefined) return cleanCostingIds([body.costingId]);
  return undefined;
}

/** Every costing named exists, or a 400 naming how many do not. */
export async function assertCostingsExist(ids: string[], tx: Tx = prisma): Promise<void> {
  if (!ids.length) return;
  const found = await tx.costing.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw badRequest(ids.length === 1 ? 'Costing not found' : 'One of the costings was not found');
}

/** A revision's costings, the first first. */
export async function revisionCostingIds(revision: { id: string; costingId: string | null }, tx: Tx = prisma): Promise<string[]> {
  if (!revision.costingId) return [];
  const others = await tx.quotationRevisionCosting.findMany({
    where: { revisionId: revision.id },
    orderBy: { sortOrder: 'asc' },
    select: { costingId: true },
  });
  return cleanCostingIds([revision.costingId, ...others.map((o) => o.costingId)]);
}

/** Many revisions' costings at once: revision id → its costings, the first first. */
export async function revisionsCostingIds(
  revisions: { id: string; costingId: string | null }[],
  tx: Tx = prisma,
): Promise<Map<string, string[]>> {
  const others = revisions.length
    ? await tx.quotationRevisionCosting.findMany({
        where: { revisionId: { in: revisions.map((r) => r.id) } },
        orderBy: { sortOrder: 'asc' },
        select: { revisionId: true, costingId: true },
      })
    : [];
  const map = new Map<string, string[]>();
  for (const r of revisions) {
    map.set(
      r.id,
      r.costingId ? cleanCostingIds([r.costingId, ...others.filter((o) => o.revisionId === r.id).map((o) => o.costingId)]) : [],
    );
  }
  return map;
}

/**
 * Writes a revision's costings: the first on `costingId`, the others as rows,
 * replaced whole. An empty list unlinks every costing.
 */
export async function setRevisionCostings(tx: Tx, revisionId: string, ids: string[]): Promise<void> {
  const clean = cleanCostingIds(ids);
  await tx.quotationRevision.update({ where: { id: revisionId }, data: { costingId: clean[0] ?? null } });
  await tx.quotationRevisionCosting.deleteMany({ where: { revisionId } });
  if (clean.length > 1) {
    await tx.quotationRevisionCosting.createMany({
      data: clean.slice(1).map((costingId, i) => ({ revisionId, costingId, sortOrder: i })),
    });
  }
}

/** A project's costings, the first first. */
export async function jobCostingIds(job: { id: string; costingId: string }, tx: Tx = prisma): Promise<string[]> {
  const others = await tx.jobCostingLink.findMany({
    where: { jobId: job.id },
    orderBy: { sortOrder: 'asc' },
    select: { costingId: true },
  });
  return cleanCostingIds([job.costingId, ...others.map((o) => o.costingId)]);
}

/** Projects built on a costing, as its first or as one of the others. */
export function jobsOnCostingWhere(costingId: string): Prisma.JobWhereInput {
  return { OR: [{ costingId }, { otherCostings: { some: { costingId } } }] };
}

/** Revisions quoted from a costing, as their first or as one of the others. */
export function revisionsOnCostingWhere(costingId: string): Prisma.QuotationRevisionWhereInput {
  return { OR: [{ costingId }, { otherCostings: { some: { costingId } } }] };
}
