import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { QUOTATION_CURRENCY_CODES } from './quotation';

/**
 * Exchange rates for quotations in another currency (2026-10-17, the owner's
 * call: "a rate on each quotation, starting from one kept in Settings").
 *
 * Settings keep one rate per currency — pesos per one unit — in the
 * `quotation.exchangeRates` row; a quotation in that currency takes it when
 * saved (`Quotation.exchangeRate`) and keeps its own after, so a rate changed
 * in Settings never restates a quotation already on file. Every summary that
 * ADDS quotations — the list's Sum and team cards, the board, the forecast,
 * Insights, the sales order list — converts through `inBase()`. The
 * quotation's page, its paper and its sales orders stay in its own currency.
 */
export const EXCHANGE_RATES_KEY = 'quotation.exchangeRates';
// Spelled out, not imported: a module load cycle through quotation.ts must never leave it undefined.
export const BASE_CURRENCY = 'PHP';

export type RateTable = Record<string, number>;

export async function exchangeRates(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<RateTable> {
  const row = await db.setting.findUnique({ where: { key: EXCHANGE_RATES_KEY } });
  const raw = (row?.value ?? {}) as Record<string, unknown>;
  const out: RateTable = {};
  for (const code of QUOTATION_CURRENCY_CODES) {
    if (code === BASE_CURRENCY) continue;
    const n = Number(raw[code]);
    if (Number.isFinite(n) && n > 0) out[code] = n;
  }
  return out;
}

/** The rate a quotation stores: none for PHP, the one typed, else Settings'. */
export function storedRate(currency: string, typed: number | null | undefined, table: RateTable): Prisma.Decimal | null {
  if (currency === BASE_CURRENCY) return null;
  const rate = typed && typed > 0 ? typed : table[currency];
  return rate ? new Prisma.Decimal(rate).toDecimalPlaces(6) : null;
}

/** Pesos per unit for a quotation — 1 for PHP, and 1 (unconverted) for a foreign one with no rate yet. */
export function rateOf(q: { currency?: string | null; exchangeRate?: Prisma.Decimal | number | null }): number {
  if (!q.currency || q.currency === BASE_CURRENCY) return 1;
  const r = Number(q.exchangeRate ?? 0);
  return r > 0 ? r : 1;
}

/** A figure in a quotation's own currency, in pesos — to the centavo. */
export function inBase(value: number, q: { currency?: string | null; exchangeRate?: Prisma.Decimal | number | null }): number {
  const r = rateOf(q);
  return r === 1 ? value : Math.round(value * r * 100) / 100;
}

/** The select every summing query adds to read a quotation's rate. */
export const RATE_SELECT = { currency: true, exchangeRate: true } as const;

/**
 * The seed, every deploy: a foreign-currency quotation with no rate takes
 * Settings' rate for its currency, once Settings has one. Claimed on null,
 * so a rate typed on a quotation is never overwritten.
 */
export async function fillQuotationRates(): Promise<number> {
  const table = await exchangeRates();
  let filled = 0;
  for (const [code, rate] of Object.entries(table)) {
    const r = await prisma.quotation.updateMany({
      where: { currency: code, exchangeRate: null },
      data: { exchangeRate: new Prisma.Decimal(rate).toDecimalPlaces(6) },
    });
    filled += r.count;
  }
  return filled;
}
