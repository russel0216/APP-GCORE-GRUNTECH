import { prisma } from '../prisma';
import { groupKey } from './quotationGroups';

/**
 * The WAREHOUSE's purchase request has routes of its own (2026-11-25, the
 * owner's call: "Purchase Request approver for automatic reordering,
 * consumables and local purchasing — Local Purchasing Manager only; include
 * cost control and CEO if the products to purchase is international like
 * omega, prevost").
 *
 * A stock replenishment — the automatic reorder's and any the warehouse
 * raises by hand — never takes the project route (Technical Manager › Team
 * Leader). It takes one of two, both ordinary `purchase_request` workflows
 * an administrator edits in Admin › Approval Workflows, told apart by their
 * `optionLabel` (which `pickWorkflow` never picks unasked, so no project
 * request lands on one):
 *
 *   LOCAL    — the Purchasing Manager (Local), alone.
 *   IMPORTED — the Purchasing Manager (Local), the Cost Controller, the CEO /
 *              President: any line whose item is filed under a product group
 *              ticked "Imported brand" (Admin › Categories › Quotation groups).
 *
 * Nobody ticks anything on the request: the lines decide. With the route
 * switched off or its label changed, the request falls back to the standard
 * purchase request route rather than stalling.
 */
export const STOCK_LOCAL_OPTION = 'Warehouse stock — local purchase';
export const STOCK_IMPORT_OPTION = 'Warehouse stock — imported brand';

/** Does any of these items sit under a product group marked imported? */
export async function hasImportedItem(itemIds: (string | null | undefined)[]): Promise<boolean> {
  const ids = [...new Set(itemIds.filter((v): v is string => !!v))];
  if (!ids.length) return false;
  const [items, imported] = await Promise.all([
    prisma.item.findMany({ where: { id: { in: ids }, productGroup: { not: null } }, select: { productGroup: true } }),
    prisma.quotationGroup.findMany({ where: { isImported: true }, select: { key: true } }),
  ]);
  if (!imported.length) return false;
  const keys = new Set(imported.map((g) => g.key));
  return items.some((i) => i.productGroup && keys.has(groupKey(i.productGroup)));
}

/**
 * The route a purchase request takes: `{ optionId }` for the engine (null is
 * the standard route) and which one it is, for the page's words.
 */
export async function stockRequestRoute(
  kind: string,
  itemIds: (string | null | undefined)[],
): Promise<{ optionId: string | null; route: 'standard' | 'local' | 'imported' }> {
  if (kind !== 'STOCK_REPLENISHMENT') return { optionId: null, route: 'standard' };
  const imported = await hasImportedItem(itemIds);
  const label = imported ? STOCK_IMPORT_OPTION : STOCK_LOCAL_OPTION;
  const workflow = await prisma.approvalWorkflow.findFirst({
    where: { documentType: 'purchase_request', isActive: true, optionLabel: label },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!workflow) return { optionId: null, route: 'standard' };
  return { optionId: workflow.id, route: imported ? 'imported' : 'local' };
}
