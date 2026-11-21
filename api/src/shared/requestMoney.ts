/**
 * What a budget request's money stands for, in three figures — the ONE
 * reading every screen that adds requests up goes through (2026-11-21, the
 * split travel request: finance books the air fare and the hotel on the
 * company card, the rest is cash to the traveller).
 *
 *  - `waiting`  — approved (or pending) and not yet out: what is left of the
 *                 amount after what finance booked and the cash released.
 *                 A request whose cash was liquidated asks nothing more — a
 *                 finance part never booked by then is freed.
 *  - `cashOut`  — cash released and not yet accounted for (released less
 *                 refunded, until the liquidation is approved).
 *  - `spent`    — the approved liquidation's total plus what finance booked
 *                 (`amountSpent`, re-derived by `refreshBudgetRequest()`).
 *  - `booked`   — the bookings alone, part of `spent`. A reader that counts
 *                 the liquidation claim on its own (the office budget, the
 *                 project ledger) adds `booked`, never `spent`.
 *
 * Nothing here reads the database; it imports nothing that could import it.
 */
type Money = { toString(): string } | number | null | undefined;
const n = (v: Money) => (v == null ? 0 : Number(v));
const c = (v: number) => Math.round(v * 100) / 100;

export interface RequestMoneyRow {
  status: string;
  amount: Money;
  amountReleased: Money;
  amountRefunded: Money;
  amountSpent: Money;
  amountBooked?: Money;
  liquidatedAt?: Date | null;
}

/** The select every reader of `requestMoney()` needs. */
export const REQUEST_MONEY = {
  status: true,
  amount: true,
  amountReleased: true,
  amountRefunded: true,
  amountSpent: true,
  amountBooked: true,
  liquidatedAt: true,
} as const;

const DEAD = ['DRAFT', 'REJECTED', 'CANCELLED'];
const ASKING = ['PENDING_APPROVAL', 'APPROVED', 'RELEASED'];

export function requestMoney(r: RequestMoneyRow): { waiting: number; cashOut: number; spent: number; booked: number; total: number } {
  if (DEAD.includes(r.status)) return { waiting: 0, cashOut: 0, spent: 0, booked: 0, total: 0 };
  const released = n(r.amountReleased);
  const booked = n(r.amountBooked);
  const spent = n(r.amountSpent);
  const liquidated = !!r.liquidatedAt && released > 0.005;
  const cashOut = liquidated ? 0 : c(Math.max(0, released - n(r.amountRefunded)));
  const waiting = ASKING.includes(r.status) && !liquidated ? c(Math.max(0, n(r.amount) - booked - released)) : 0;
  return { waiting, cashOut, spent: c(spent), booked: c(booked), total: c(waiting + cashOut + spent) };
}

/** The cash a liquidation accounts for was spent: the liquidation's part of `amountSpent`. */
export function cashSpent(r: { amountSpent: Money; amountBooked?: Money }): number {
  return c(Math.max(0, n(r.amountSpent) - n(r.amountBooked)));
}
