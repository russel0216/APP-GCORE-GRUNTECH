import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';
import { receiptUnitCost } from './receiptCost';

/**
 * PURCHASING FOR THE OFFICE (2026-11-27, help tickets GT-HT-2026-0043 and
 * 0045: "please add yearly budget/overheads as project for admin requests").
 *
 * A purchase request of kind OFFICE names no project, warehouse, sales order
 * or quotation: each LINE names the office budget line it is charged to
 * (`PurchaseRequestItem.officeBudgetLineId`), and its purchase order's lines
 * carry the same (`PurchaseOrderItem.officeBudgetLineId`). The goods are
 * received for office use — never shelved, never a job's cost. What the
 * purchase stands for on its office line is READ here, never stored:
 *
 * - **requested** — a request waiting for approval, at its declared estimate;
 *   an order with no request behind it waiting for approval, at its price.
 * - **released** (the monitor's "Cash out", committed) — an approved request's
 *   lines not yet received, at the declared estimate (Budget Monitoring's
 *   declared-value rule); an issued order line with no request, not yet
 *   received, at its price in pesos.
 * - **spent** (actual) — what the Incoming received on those lines, at the
 *   cost it took them in at (pesos, before VAT).
 *
 * A supplier bill against such an order charges no office line (a bill with a
 * purchase order never does), so nothing is counted twice.
 */

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

const PR_APPROVED = ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'] as const;
const PO_ISSUED = ['ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED'] as const;

export interface PurchaseFigures {
  requested: number;
  released: number;
  spent: number;
}

/** What office purchasing says about each line — added to the other documents' figures. */
export async function officePurchaseFigures(lineIds: string[], ownRequestId?: string): Promise<Map<string, PurchaseFigures>> {
  const out = new Map<string, PurchaseFigures>(lineIds.map((id) => [id, { requested: 0, released: 0, spent: 0 }]));
  if (!lineIds.length) return out;
  const on = { officeBudgetLineId: { in: lineIds } };
  const notOwn = ownRequestId ? { id: { not: ownRequestId } } : {};
  const [requestLines, orderLines, received] = await Promise.all([
    prisma.purchaseRequestItem.findMany({
      where: { ...on, request: { kind: 'OFFICE', status: { in: ['PENDING_APPROVAL', ...PR_APPROVED] }, ...notOwn } },
      select: {
        officeBudgetLineId: true,
        quantity: true,
        pulledQty: true,
        estimatedCost: true,
        estimatedAmount: true,
        request: { select: { status: true } },
        orderItems: { where: { order: { status: { not: 'CANCELLED' } } }, select: { receivedQty: true } },
      },
    }),
    prisma.purchaseOrderItem.findMany({
      where: { ...on, requestItemId: null, order: { kind: 'OFFICE', status: { in: ['PENDING_APPROVAL', ...PO_ISSUED] } } },
      select: {
        officeBudgetLineId: true,
        quantity: true,
        receivedQty: true,
        unitPrice: true,
        landedUnitCost: true,
        order: { select: { number: true, status: true, currency: true, exchangeRate: true, discountPct: true } },
      },
    }),
    prisma.receivingItem.findMany({
      where: { receiving: { status: 'RECEIVED' }, orderItem: { ...on, order: { kind: 'OFFICE' } } },
      select: { quantity: true, unitCost: true, orderItem: { select: { officeBudgetLineId: true } } },
    }),
  ]);
  for (const l of requestLines) {
    const f = out.get(l.officeBudgetLineId!)!;
    if (l.request.status === 'PENDING_APPROVAL') {
      f.requested += num(l.estimatedAmount);
      continue;
    }
    const got = l.orderItems.reduce((s, o) => s + num(o.receivedQty), 0);
    const left = Math.max(0, num(l.quantity) - num(l.pulledQty) - got);
    f.released += left * num(l.estimatedCost);
  }
  for (const l of orderLines) {
    const f = out.get(l.officeBudgetLineId!)!;
    const unit = receiptUnitCost(l.order, l).unitCost ?? num(l.unitPrice);
    if (l.order.status === 'PENDING_APPROVAL') f.requested += num(l.quantity) * unit;
    else f.released += Math.max(0, num(l.quantity) - num(l.receivedQty)) * unit;
  }
  for (const r of received) {
    const f = out.get(r.orderItem!.officeBudgetLineId!)!;
    f.spent += num(r.quantity) * num(r.unitCost);
  }
  return out;
}

/** The office purchases charged to these lines — the budget page's drill-down, one row per document and line. */
export async function officePurchaseDocuments(lineIds: string[]) {
  if (!lineIds.length) return [];
  const on = { officeBudgetLineId: { in: lineIds } };
  const [requests, orders] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where: { kind: 'OFFICE', status: { notIn: ['DRAFT', 'REJECTED', 'CANCELLED'] }, items: { some: on } },
      select: {
        id: true, number: true, status: true, createdAt: true, purpose: true, requestedBy: { select: { name: true } },
        items: { where: on, select: { officeBudgetLineId: true, estimatedAmount: true } },
      },
    }),
    prisma.purchaseOrder.findMany({
      where: { kind: 'OFFICE', status: { notIn: ['DRAFT', 'CANCELLED'] }, items: { some: on } },
      select: {
        id: true, number: true, status: true, createdAt: true, currency: true, exchangeRate: true, discountPct: true,
        supplier: { select: { name: true } },
        items: { where: on, select: { officeBudgetLineId: true, quantity: true, unitPrice: true, landedUnitCost: true, requestItem: { select: { estimatedCost: true } } } },
      },
    }),
  ]);
  const rows: { kind: 'purchase_request' | 'purchase_order'; id: string; number: string; status: string; amount: number; date: Date; what: string; who: string; lineId: string; link: string }[] = [];
  for (const r of requests) {
    const byLine = new Map<string, number>();
    for (const i of r.items) byLine.set(i.officeBudgetLineId!, (byLine.get(i.officeBudgetLineId!) ?? 0) + num(i.estimatedAmount));
    for (const [lineId, amount] of byLine) {
      rows.push({ kind: 'purchase_request', id: r.id, number: r.number, status: r.status, amount, date: r.createdAt, what: r.purpose, who: r.requestedBy.name, lineId, link: `/g-chain/purchase-requests/${r.id}` });
    }
  }
  for (const o of orders) {
    const byLine = new Map<string, number>();
    for (const i of o.items) {
      const unit = receiptUnitCost({ ...o, number: o.number }, i).unitCost ?? num(i.unitPrice);
      byLine.set(i.officeBudgetLineId!, (byLine.get(i.officeBudgetLineId!) ?? 0) + num(i.quantity) * unit);
    }
    for (const [lineId, amount] of byLine) {
      rows.push({ kind: 'purchase_order', id: o.id, number: o.number, status: o.status, amount: Math.round(amount * 100) / 100, date: o.createdAt, what: 'Purchase order', who: o.supplier?.name ?? '', lineId, link: `/g-chain/purchase-orders/${o.id}` });
    }
  }
  return rows;
}

/** How many purchase lines name each office line — a line in use is closed, never removed. */
export async function officePurchaseUse(lineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!lineIds.length) return out;
  const by = { by: ['officeBudgetLineId'] as ['officeBudgetLineId'], where: { officeBudgetLineId: { in: lineIds } }, _count: { _all: true as const } };
  const groups = await Promise.all([prisma.purchaseRequestItem.groupBy(by), prisma.purchaseOrderItem.groupBy(by)]);
  for (const g of groups.flat()) if (g.officeBudgetLineId) out.set(g.officeBudgetLineId, (out.get(g.officeBudgetLineId) ?? 0) + g._count._all);
  return out;
}

/**
 * The office lines an OFFICE request's lines name, each checked: on file, open
 * (in an active budget) — or one the line already carries (`keep`). Any other
 * kind names none: what the caller sent is dropped.
 */
export async function checkOfficeLines(
  kind: string,
  lines: { officeBudgetLineId?: string | null; label: string; keep?: string | null }[],
): Promise<(string | null)[]> {
  if (kind !== 'OFFICE') return lines.map(() => null);
  const ids = [...new Set(lines.map((l) => l.officeBudgetLineId).filter((v): v is string => !!v))];
  const found = ids.length
    ? await prisma.officeBudgetLine.findMany({ where: { id: { in: ids } }, include: { budget: { select: { name: true, isActive: true } } } })
    : [];
  const byId = new Map(found.map((l) => [l.id, l]));
  return lines.map((l, i) => {
    const n = i + 1;
    if (!l.officeBudgetLineId) throw badRequest(`Line ${n} (${l.label}): choose the office budget line it is charged to`);
    const line = byId.get(l.officeBudgetLineId);
    if (!line) throw badRequest(`Line ${n} (${l.label}): that office budget line is not on file`);
    if (l.officeBudgetLineId !== l.keep && (!line.isActive || !line.budget.isActive)) {
      throw badRequest(`Line ${n} (${l.label}): ${line.code} ${line.name} is closed — choose another line of ${line.budget.name}`);
    }
    return line.id;
  });
}
