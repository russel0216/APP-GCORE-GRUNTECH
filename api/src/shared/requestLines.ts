import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { badRequest } from '../http/kit';

/**
 * The breakdown of a cash request — what the money buys, line by line — for
 * the budget request and the cash advance (2026-10-19, the owner's call: a
 * full form, not a popup). The request's amount is the sum of its lines.
 */

export const requestItemSchema = z.object({
  name: z.string().trim().min(1, 'Say what the line buys').max(300),
  description: z.string().trim().max(2000).optional().nullable(),
  quantity: z.number().positive('A line’s quantity must be more than zero'),
  unit: z.string().trim().max(40).optional().nullable(),
  unitCost: z.number().min(0, 'A unit cost cannot be negative'),
});

export type RequestItemInput = z.infer<typeof requestItemSchema>;

/**
 * A line's amount in exact integers: quantity in thousandths × unit cost in
 * centavos ÷ 1000, half away from zero — never a float multiplied and stored
 * (rule 10). The web's `requestLineAmount()` is the same rule.
 */
export function requestLineAmount(quantity: number, unitCost: number): number {
  const milli = BigInt(Math.round(quantity * 1000));
  const centavos = BigInt(Math.round(unitCost * 100));
  const product = milli * centavos;
  const sign = product < 0n ? -1n : 1n;
  const rounded = ((product * sign + 500n) / 1000n) * sign;
  return Number(rounded) / 100;
}

/** The lines as stored, and the amount they make; with none, the typed amount stands. */
export function requestMoney(items: RequestItemInput[] | undefined, typed: number | undefined) {
  const lines = (items ?? []).map((i, n) => ({
    sortOrder: n,
    name: i.name,
    description: i.description?.trim() || null,
    quantity: new Prisma.Decimal(Math.round(i.quantity * 1000) / 1000),
    unit: i.unit?.trim() || 'pcs',
    unitCost: new Prisma.Decimal(Math.round(i.unitCost * 100) / 100),
    amount: new Prisma.Decimal(requestLineAmount(i.quantity, i.unitCost)),
  }));
  const cents = lines.length
    ? lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0)
    : Math.round((typed ?? 0) * 100);
  const amount = cents / 100;
  if (!(amount > 0)) throw badRequest(lines.length ? 'The lines add up to nothing — give them a unit cost' : 'The amount must be more than zero');
  return { lines, amount };
}
