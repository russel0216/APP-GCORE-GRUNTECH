import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * Stock movement and job-cost posting.
 *
 * Two rules from the model carry all the weight here:
 *
 * 1. **Where a job is charged depends on why the thing was bought** (§4.3).
 *    Direct-to-job material charges the job at RECEIVING. Stock replenishment
 *    charges the job at ISSUANCE. Getting this wrong double-counts material
 *    bought for a job and later issued from stock.
 *
 * 2. **Moving weighted average cost.** A receipt changes the average; an issue
 *    takes the average as given. That is what stops issuing stock from
 *    silently changing the value of what remains.
 */

const D = (v: number | string) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const qty = (n: number) => Math.round(n * 1000) / 1000;

type Tx = Prisma.TransactionClient;

export interface MoveInput {
  itemId: string;
  warehouseId: string;
  quantity: number;
  unitCost?: number;
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  notes?: string | null;
  createdById?: string | null;
  occurredAt?: Date;
}

/**
 * Receives stock and recomputes the moving average.
 *
 *   newAverage = (onHandValue + receiptValue) / (onHand + receiptQty)
 *
 * Guarded against a negative starting balance, where the arithmetic would
 * otherwise produce a nonsensical average.
 */
export async function receiveStock(tx: Tx, input: MoveInput) {
  if (input.quantity <= 0) throw badRequest('Received quantity must be more than zero');

  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
  });

  const onHand = num(balance?.quantity);
  const average = num(balance?.averageCost);
  const unitCost = input.unitCost ?? average;

  const newQty = qty(onHand + input.quantity);
  const newAverage =
    onHand > 0
      ? (onHand * average + input.quantity * unitCost) / newQty
      : unitCost;

  const updated = await tx.inventoryBalance.upsert({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    create: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      quantity: D(newQty),
      averageCost: D(Math.round(newAverage * 10000) / 10000),
    },
    update: {
      quantity: D(newQty),
      averageCost: D(Math.round(newAverage * 10000) / 10000),
    },
  });

  await tx.inventoryTransaction.create({
    data: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      type: 'RECEIPT',
      quantity: D(input.quantity),
      unitCost: D(unitCost),
      balanceAfter: D(newQty),
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });

  // Keep the item's last purchase cost current — costing uses it as a hint.
  await tx.item.update({ where: { id: input.itemId }, data: { lastCost: D(unitCost) } });

  return { balance: updated, unitCost, averageCost: num(updated.averageCost) };
}

/**
 * Issues stock at the current average cost and returns what it was worth.
 *
 * Refuses to go negative: a warehouse cannot issue what it does not have, and
 * allowing it would corrupt the average for everything that follows.
 */
export async function issueStock(tx: Tx, input: Omit<MoveInput, 'unitCost'> & { type?: 'ISSUE' | 'BORROW' }) {
  if (input.quantity <= 0) throw badRequest('Issued quantity must be more than zero');

  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    include: { item: { select: { code: true, name: true, unit: true } } },
  });

  const onHand = num(balance?.quantity);
  const borrowed = num(balance?.borrowedQty);
  const available = qty(onHand - borrowed);

  if (!balance || available < input.quantity) {
    const label = balance ? `${balance.item.code} — ${balance.item.name}` : 'that item';
    throw badRequest(
      `Not enough stock of ${label}: ${available} available${borrowed > 0 ? ` (${onHand} on hand, ${borrowed} out on loan)` : ''}, ${input.quantity} requested.`,
    );
  }

  const unitCost = num(balance.averageCost);
  const newQty = qty(onHand - input.quantity);

  // The average is NOT recomputed on issue — it is the cost of what remains,
  // and taking stock out does not change what the rest cost.
  const updated = await tx.inventoryBalance.update({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    data: { quantity: D(newQty) },
  });

  await tx.inventoryTransaction.create({
    data: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      type: input.type ?? 'ISSUE',
      quantity: D(-input.quantity),
      unitCost: D(unitCost),
      balanceAfter: D(newQty),
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });

  return { balance: updated, unitCost, amount: cents(input.quantity * unitCost) };
}

/** Moves stock into the on-loan bucket without changing what is owned. */
export async function borrowStock(tx: Tx, input: Omit<MoveInput, 'unitCost'>) {
  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    include: { item: { select: { code: true, name: true } } },
  });

  const onHand = num(balance?.quantity);
  const borrowed = num(balance?.borrowedQty);
  const available = qty(onHand - borrowed);

  if (!balance || available < input.quantity) {
    const label = balance ? `${balance.item.code} — ${balance.item.name}` : 'that item';
    throw badRequest(`Not enough of ${label} available to lend: ${available} free, ${input.quantity} requested.`);
  }

  await tx.inventoryBalance.update({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    data: { borrowedQty: D(qty(borrowed + input.quantity)) },
  });

  await tx.inventoryTransaction.create({
    data: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      type: 'BORROW',
      quantity: D(-input.quantity),
      unitCost: balance.averageCost,
      // Still owned — the on-hand balance does not move, only availability.
      balanceAfter: balance.quantity,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
    },
  });
}

export async function returnBorrowedStock(tx: Tx, input: Omit<MoveInput, 'unitCost'>) {
  const balance = await tx.inventoryBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
  });
  if (!balance) throw badRequest('No stock record for that item and warehouse');

  const borrowed = num(balance.borrowedQty);
  if (input.quantity > borrowed + 0.0005) {
    throw badRequest(`Only ${borrowed} of that item is out on loan; ${input.quantity} cannot be returned.`);
  }

  await tx.inventoryBalance.update({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
    data: { borrowedQty: D(qty(borrowed - input.quantity)) },
  });

  await tx.inventoryTransaction.create({
    data: {
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      type: 'RETURN',
      quantity: D(input.quantity),
      unitCost: balance.averageCost,
      balanceAfter: balance.quantity,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      createdById: input.createdById ?? null,
    },
  });
}

// ════════════════════════════════════════════════════════════════════
//  JOB COST POSTING
// ════════════════════════════════════════════════════════════════════

export interface PostInput {
  jobId: string;
  costCategoryId: string;
  state: 'COMMITTED' | 'INCURRED' | 'CONSUMED';
  amount: number;
  sourceType: string;
  sourceId?: string | null;
  sourceNumber?: string | null;
  description?: string | null;
  createdById?: string | null;
}

/** Writes one row into the job cost ledger. The only way cost reaches a job. */
export async function postJobCost(tx: Tx, input: PostInput) {
  if (input.amount === 0) return null;
  return tx.jobCostEntry.create({
    data: {
      jobId: input.jobId,
      costCategoryId: input.costCategoryId,
      state: input.state,
      amount: D(cents(input.amount)),
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceNumber: input.sourceNumber ?? null,
      description: input.description ?? null,
      createdById: input.createdById ?? null,
    },
  });
}

/**
 * Releases a commitment by posting its negative.
 *
 * Reversal rather than deletion: the ledger is a record of what happened, and
 * "we committed 150,000 then received it" is a truer history than a row that
 * quietly vanished. Budget Monitoring sums the ledger, so a negative
 * COMMITTED row nets the commitment back out.
 */
export async function releaseCommitment(
  tx: Tx,
  opts: {
    jobId: string;
    sourceType: string;
    sourceId: string;
    reason: string;
    createdById?: string | null;
    /** Limits the release to one category; omit to release everything. */
    costCategoryId?: string;
    /** Releases a partial amount rather than the whole commitment. */
    amount?: number;
  },
) {
  const existing = await tx.jobCostEntry.findMany({
    where: {
      jobId: opts.jobId,
      state: 'COMMITTED',
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      ...(opts.costCategoryId ? { costCategoryId: opts.costCategoryId } : {}),
    },
  });
  if (!existing.length) return;

  // Net of any release already posted, so this is safe to call twice.
  const byCategory = new Map<string, number>();
  for (const row of existing) {
    byCategory.set(row.costCategoryId, (byCategory.get(row.costCategoryId) ?? 0) + num(row.amount));
  }

  for (const [costCategoryId, net] of byCategory) {
    if (Math.abs(net) < 0.005) continue;
    const release = opts.amount !== undefined ? Math.min(opts.amount, net) : net;
    await postJobCost(tx, {
      jobId: opts.jobId,
      costCategoryId,
      state: 'COMMITTED',
      amount: -release,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      sourceNumber: null,
      description: opts.reason,
      createdById: opts.createdById,
    });
  }
}

/** Budgeted − committed − incurred, for one category of one job. */
export async function availableBudget(
  tx: Tx,
  jobId: string,
  costCategoryId: string,
): Promise<{ budgeted: number; committed: number; incurred: number; available: number }> {
  const rows = await tx.jobCostEntry.groupBy({
    by: ['state'],
    where: { jobId, costCategoryId },
    _sum: { amount: true },
  });
  const get = (state: string) => num(rows.find((r) => r.state === state)?._sum.amount);
  const budgeted = get('BUDGETED');
  const committed = get('COMMITTED');
  const incurred = get('INCURRED');
  return {
    budgeted: cents(budgeted),
    committed: cents(committed),
    incurred: cents(incurred),
    available: cents(budgeted - committed - incurred),
  };
}

/**
 * Whether spending is blocked once a category runs out of budget.
 *
 * "A PR that would push Available below zero is blocked, or requires a Budget
 * Request first — configurable per job in Settings" (model §5.2). Default on:
 * a budget nobody can exceed is the only kind that means anything.
 */
export async function overBudgetIsBlocked(): Promise<boolean> {
  const setting = await prisma.setting.findUnique({ where: { key: 'procurement.blockOverBudget' } });
  if (!setting) return true;
  return setting.value !== false;
}
