import { prisma } from '../prisma';

/**
 * "Who added it" for the records that had no author column before the own
 * pair of 2026-10-18 (Edit Own reads `createdById`). Once, marked
 * `OWN_BACKFILL_MARK`: each row with none takes the actor of its own CREATED
 * audit row, where the trail has one. A row nobody is on record for stays
 * null — it belongs to nobody's "own", and View All / Edit All still reach it.
 */
export const OWN_BACKFILL_MARK = 'seed.ownAuthorsBackfilled20261018';

/** Table → the audit entity type its CREATED rows are filed under. */
const TABLES: { table: string; entityType: string }[] = [
  { table: 'Item', entityType: 'item' },
  { table: 'Warehouse', entityType: 'warehouse' },
  { table: 'Position', entityType: 'position' },
  { table: 'Course', entityType: 'course' },
  { table: 'Role', entityType: 'role' },
  { table: 'ApprovalWorkflow', entityType: 'approval_workflow' },
  { table: 'CostCategory', entityType: 'cost_category' },
  { table: 'Industry', entityType: 'industry' },
  { table: 'ItemCategory', entityType: 'item_category' },
  { table: 'QuotationGroup', entityType: 'quotation_group' },
  { table: 'SalesActivityType', entityType: 'activity_type' },
  { table: 'SubIndustry', entityType: 'sub_industry' },
  { table: 'CadDrawingType', entityType: 'cad_drawing_type' },
];

export async function backfillOwnAuthors(): Promise<Record<string, number> | null> {
  if (await prisma.setting.findUnique({ where: { key: OWN_BACKFILL_MARK } })) return null;
  const filled: Record<string, number> = {};
  for (const { table, entityType } of TABLES) {
    // The earliest CREATED row with an actor names who added it.
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" t SET "createdById" = a."actorId"
         FROM (SELECT DISTINCT ON ("entityId") "entityId", "actorId"
                 FROM "AuditLog"
                WHERE "entityType" = $1 AND action = 'CREATED' AND "actorId" IS NOT NULL
                ORDER BY "entityId", at ASC) a
        WHERE t.id = a."entityId" AND t."createdById" IS NULL
          AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = a."actorId")`,
      entityType,
    );
    if (n) filled[table] = n;
  }
  await prisma.setting.create({
    data: {
      key: OWN_BACKFILL_MARK,
      value: { at: new Date().toISOString(), filled },
      description: 'seed: "who added it" was filled once (2026-10-18) from each record\'s CREATED audit row, for Edit Own',
    },
  });
  return filled;
}
