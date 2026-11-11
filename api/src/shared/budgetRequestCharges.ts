import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { chargeGroups, type LineCharge } from './lineCharges';

type Db = Prisma.TransactionClient | typeof prisma;

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * A budget request charged item by item (2026-11-11): the places its items
 * name and what each takes — the item amounts summed per project and budget
 * line, or office line, in the order first met.
 */
export async function requestPlaces(requestId: string, db: Db = prisma): Promise<LineCharge[]> {
  return (await requestGroups(requestId, db)).map((g) => g.charge);
}

export async function requestGroups(requestId: string, db: Db = prisma) {
  const items = await db.budgetRequestItem.findMany({
    where: { requestId },
    orderBy: { sortOrder: 'asc' },
    select: { jobId: true, costCategoryId: true, officeBudgetLineId: true, amount: true },
  });
  return chargeGroups(items.map((i) => ({ charge: { jobId: i.jobId, costCategoryId: i.costCategoryId, officeBudgetLineId: i.officeBudgetLineId }, amount: num(i.amount) })));
}

/**
 * A sum spread over the places in proportion to what each was asked — the
 * released cash, or what a direct payment spent — exact to the centavo, the
 * remainder on the last place so the shares add up to the sum.
 */
export function spreadOver<T extends { amount: number }>(groups: T[], sum: number): (T & { share: number })[] {
  const asked = groups.reduce((s, g) => s + g.amount, 0);
  let left = cents(sum);
  return groups.map((g, i) => {
    const share = i === groups.length - 1 ? left : asked > 0 ? cents((sum * g.amount) / asked) : 0;
    left = cents(left - share);
    return { ...g, share };
  });
}
