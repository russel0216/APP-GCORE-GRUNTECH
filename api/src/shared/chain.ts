import { prisma } from '../prisma';
import { can, type ResolvedUser } from '../permissions/resolve';
import { cents } from './finance';
import { manilaDate } from './day';

/**
 * G-CHAIN figures that more than one screen shows.
 *
 * The G-CHAIN dashboard, the Insights brief and the inventory summary each
 * used to carry their own copy of "what is stock worth" and "what is waiting
 * on procurement". A hand-copied where-clause is the drift mechanism — one
 * of them was already three tiles of zero after swallowing a single 403.
 * These are decided once, here.
 */

const num = (v: { toString(): string } | number | null | undefined) =>
  v == null ? 0 : Number(v);

/** Stock on hand: every balance with quantity, valued at its moving average. */
export async function stockOnHand(): Promise<{ value: number; lines: number }> {
  const balances = await prisma.inventoryBalance.findMany({
    where: { quantity: { gt: 0 } },
    select: { quantity: true, averageCost: true },
  });
  return {
    value: cents(balances.reduce((sum, b) => sum + num(b.quantity) * num(b.averageCost), 0)),
    lines: balances.length,
  };
}

type Qty = { toString(): string } | number;

/**
 * Available to issue: on hand less what is out on loan, to the centavo.
 * With `belowReorder`, the ONE rule for the stock list's flag, its "Below
 * level" filter and paper, the inventory reports' tile and Insights'
 * Inventory Analytics — which used to keep its own (stock above zero only,
 * strictly under the level) and so left out an item with nothing left.
 */
export const availableOf = (b: { quantity: Qty; borrowedQty: Qty }) => cents(num(b.quantity) - num(b.borrowedQty));

/** At or under the item's reorder level; an item with no level never is. */
export function belowReorder(b: { quantity: Qty; borrowedQty: Qty; item: { reorderLevel: Qty | null } }): boolean {
  return b.item.reorderLevel !== null && availableOf(b) <= num(b.item.reorderLevel);
}

/** The balances `belowReorder` can be true of: an item with a level set. Narrow with it, then filter. */
export const REORDER_CANDIDATES = { item: { reorderLevel: { not: null } } } as const;

export interface ChainOverview {
  /** PENDING_APPROVAL purchase requests — own only when the caller sees own only. */
  requestsAwaitingApproval: number | null;
  /** ISSUED or PARTIALLY_RECEIVED purchase orders. */
  ordersAwaitingDelivery: number | null;
  /** OUT or PARTIALLY_RETURNED borrow slips past their due date. */
  borrowSlipsOverdue: number | null;
  stock: { value: number; lines: number } | null;
}

/**
 * The four G-CHAIN figures, each null when the caller lacks the permission
 * that lists it — a tile that cannot be opened prints "—", never 0.
 *
 * Purchase requests are scoped exactly as the list is (procurement.ts): a
 * view_own holder counts their own requests, everyone else counts them all.
 * The other three are view_all-only lists, so the count is all or nothing.
 */
export async function chainOverview(me: ResolvedUser): Promise<ChainOverview> {
  // Manila's date: `dueAt` is a DATE, and an instant compared with it is read
  // as its UTC date — yesterday's until 08:00.
  const today = manilaDate(new Date());

  const seesRequests =
    can(me, 'gchain.purchase_requests.view_all') || can(me, 'gchain.purchase_requests.view_own');
  const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gchain.purchase_requests.view_all');

  const [requests, orders, borrows, stock] = await Promise.all([
    seesRequests
      ? prisma.purchaseRequest.count({
          where: { status: 'PENDING_APPROVAL', ...(onlyOwn ? { requestedById: me.id } : {}) },
        })
      : null,
    can(me, 'gchain.purchase_orders.view_all')
      ? prisma.purchaseOrder.count({ where: { status: { in: ['ISSUED', 'PARTIALLY_RECEIVED'] } } })
      : null,
    can(me, 'gchain.borrow_slips.view_all')
      ? prisma.borrowSlip.count({
          where: { status: { in: ['OUT', 'PARTIALLY_RETURNED'] }, dueAt: { lt: today } },
        })
      : null,
    can(me, 'gchain.inventory.view_all') ? stockOnHand() : null,
  ]);

  return {
    requestsAwaitingApproval: requests,
    ordersAwaitingDelivery: orders,
    borrowSlipsOverdue: borrows,
    stock,
  };
}
