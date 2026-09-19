import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * The money arithmetic G-FIN shares, in one place.
 *
 * The rule everything here exists to protect: **invoiced ≠ collectible**.
 * Expanded withholding tax is taken off by the customer at source and comes
 * back as a BIR 2307 certificate, not as cash. An A/R balance measured against
 * the invoice total therefore reports the withheld portion as unpaid forever,
 * and every customer looks like a late payer (model §5.4).
 *
 * So: outstanding is always measured against NET COLLECTIBLE.
 */

type Tx = Prisma.TransactionClient | typeof prisma;

export const cents = (n: number) => Math.round(n * 100) / 100;
export const D = (v: number) => new Prisma.Decimal(cents(v));
export const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

// ── Tax ──────────────────────────────────────────────────────────────────────

export interface TaxBreakdown {
  grossAmount: number;
  vatRate: number;
  vatAmount: number;
  ewtRate: number;
  ewtAmount: number;
  /** What the invoice says. */
  invoiceTotal: number;
  /** What will actually arrive in the bank. */
  netCollectible: number;
}

/**
 * VAT on top, EWT withheld off the gross.
 *
 * EWT is computed on the gross and NOT on the VAT — that is the part everyone
 * gets wrong, and it is worth 0.24% of every invoice.
 */
export function taxBreakdown(gross: number, vatRate: number, ewtRate: number): TaxBreakdown {
  const grossAmount = cents(gross);
  const vatAmount = cents(grossAmount * vatRate);
  const ewtAmount = cents(grossAmount * ewtRate);
  const invoiceTotal = cents(grossAmount + vatAmount);
  return {
    grossAmount,
    vatRate,
    vatAmount,
    ewtRate,
    ewtAmount,
    invoiceTotal,
    netCollectible: cents(invoiceTotal - ewtAmount),
  };
}

/** The company's current rates. Snapshot them onto the document; never re-read. */
export async function currentRates(tx: Tx = prisma): Promise<{ vatRate: number; ewtRate: number }> {
  const company = await tx.company.findUnique({ where: { id: 'company' } });
  return {
    vatRate: company ? num(company.vatRate) : 0.12,
    ewtRate: company ? num(company.ewtRate) : 0.02,
  };
}

/**
 * Supplier withholding, on the payable side.
 *
 * Gruntech withholds from its suppliers in turn: 1% on goods, 2% on services
 * under the usual BIR schedule. Defaults to zero so a bill only withholds when
 * somebody says it should — guessing wrong here underpays a supplier.
 */
export interface FinanceSettings {
  /** Days added to a bill or invoice date when terms say nothing else. */
  defaultTermsDays: number;
  /** Suggested withholding on a supplier of goods. */
  supplierEwtGoods: number;
  /** Suggested withholding on a supplier of services or subcontract labour. */
  supplierEwtServices: number;
  /** Aging buckets, in days. The last bucket is "and over". */
  agingBuckets: number[];
}

const DEFAULTS: FinanceSettings = {
  defaultTermsDays: 30,
  supplierEwtGoods: 0.01,
  supplierEwtServices: 0.02,
  agingBuckets: [30, 60, 90],
};

export async function financeSettings(): Promise<FinanceSettings> {
  const row = await prisma.setting.findUnique({ where: { key: 'finance.rules' } });
  if (!row) return DEFAULTS;
  return { ...DEFAULTS, ...(row.value as Partial<FinanceSettings>) };
}

export async function saveFinanceSettings(value: Partial<FinanceSettings>): Promise<FinanceSettings> {
  const merged = { ...(await financeSettings()), ...value };
  await prisma.setting.upsert({
    where: { key: 'finance.rules' },
    create: {
      key: 'finance.rules',
      value: merged as unknown as Prisma.InputJsonValue,
      description: 'Payment terms, supplier withholding rates and aging buckets',
    },
    update: { value: merged as unknown as Prisma.InputJsonValue },
  });
  return merged;
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** The local date as UTC midnight, so a date column compares predictably. */
export function dayKey(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Whole days between two dates; negative means the later one has not arrived. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((dayKey(to).getTime() - dayKey(from).getTime()) / 86_400_000);
}

// ── Allocation ───────────────────────────────────────────────────────────────

export type SettleableKind = 'invoice' | 'bill' | 'claim';

export interface Settleable {
  kind: SettleableKind;
  id: string;
  number: string;
  /** The figure the document is settled against. */
  payable: number;
  paid: number;
  outstanding: number;
}

/**
 * What is still owed on one document.
 *
 * For an invoice that is `netCollectible − collected`, never
 * `invoiceTotal − collected`.
 */
export async function settleable(
  kind: SettleableKind,
  id: string,
  tx: Tx = prisma,
): Promise<Settleable | null> {
  if (kind === 'invoice') {
    const row = await tx.invoice.findUnique({ where: { id } });
    if (!row) return null;
    const payable = num(row.netCollectible);
    const paid = num(row.amountCollected);
    return { kind, id, number: row.number, payable, paid, outstanding: cents(payable - paid) };
  }
  if (kind === 'bill') {
    const row = await tx.supplierBill.findUnique({ where: { id } });
    if (!row) return null;
    const payable = num(row.netPayable);
    const paid = num(row.amountPaid);
    return { kind, id, number: row.number, payable, paid, outstanding: cents(payable - paid) };
  }
  const row = await tx.expenseClaim.findUnique({ where: { id } });
  if (!row) return null;
  const payable = num(row.total);
  const paid = num(row.amountPaid);
  return { kind, id, number: row.number, payable, paid, outstanding: cents(payable - paid) };
}

/**
 * Re-derives a document's paid total from its allocations and moves its status.
 *
 * Recomputed from the allocation rows rather than incremented, so deleting a
 * payment cannot leave a stale total behind. Statuses are a function of the
 * arithmetic, never set by hand.
 */
export async function refreshSettlement(
  tx: Tx,
  kind: SettleableKind,
  id: string,
): Promise<{ paid: number; outstanding: number; status: string }> {
  const where =
    kind === 'invoice' ? { invoiceId: id } : kind === 'bill' ? { billId: id } : { claimId: id };
  const sum = await tx.paymentAllocation.aggregate({ where, _sum: { amount: true } });
  const paid = cents(num(sum._sum.amount));

  if (kind === 'invoice') {
    const row = await tx.invoice.findUnique({ where: { id } });
    if (!row) throw badRequest('Invoice not found');
    const payable = num(row.netCollectible);
    // A cancelled invoice keeps its status: a payment recorded against one is a
    // data problem to look at, not a reason to quietly resurrect it.
    const status =
      row.status === 'CANCELLED'
        ? 'CANCELLED'
        : paid <= 0
          ? row.issuedAt
            ? 'ISSUED'
            : 'DRAFT'
          : paid + 0.005 >= payable
            ? 'PAID'
            : 'PARTIALLY_PAID';
    await tx.invoice.update({
      where: { id },
      data: { amountCollected: D(paid), status: status as never },
    });
    return { paid, outstanding: cents(payable - paid), status };
  }

  if (kind === 'bill') {
    const row = await tx.supplierBill.findUnique({ where: { id } });
    if (!row) throw badRequest('Supplier bill not found');
    const payable = num(row.netPayable);
    const status =
      row.status === 'CANCELLED' || row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL'
        ? row.status
        : paid <= 0
          ? 'APPROVED'
          : paid + 0.005 >= payable
            ? 'PAID'
            : 'PARTIALLY_PAID';
    await tx.supplierBill.update({
      where: { id },
      data: { amountPaid: D(paid), status: status as never },
    });
    return { paid, outstanding: cents(payable - paid), status };
  }

  const row = await tx.expenseClaim.findUnique({ where: { id } });
  if (!row) throw badRequest('Expense claim not found');
  const payable = num(row.total);
  const status =
    row.status === 'APPROVED' || row.status === 'REIMBURSED'
      ? paid + 0.005 >= payable && paid > 0
        ? 'REIMBURSED'
        : 'APPROVED'
      : row.status;
  await tx.expenseClaim.update({
    where: { id },
    data: { amountPaid: D(paid), status: status as never },
  });
  return { paid, outstanding: cents(payable - paid), status };
}

// ── Aging ────────────────────────────────────────────────────────────────────

export interface AgingBucket {
  label: string;
  from: number;
  to: number | null;
  amount: number;
  count: number;
}

export interface AgedRow {
  id: string;
  number: string;
  party: string;
  partyId: string;
  date: Date;
  dueDate: Date;
  /** Negative while it is not yet due. */
  daysOverdue: number;
  payable: number;
  paid: number;
  outstanding: number;
  bucket: string;
  jobNumber?: string | null;
  /** Withheld at source — reported, never counted as outstanding. */
  withheld?: number;
}

export function bucketFor(daysOverdue: number, buckets: number[]): string {
  if (daysOverdue <= 0) return 'Current';
  let previous = 0;
  for (const edge of buckets) {
    if (daysOverdue <= edge) return `${previous + 1}–${edge}`;
    previous = edge;
  }
  return `${previous}+`;
}

export function bucketLabels(buckets: number[]): string[] {
  const labels = ['Current'];
  let previous = 0;
  for (const edge of buckets) {
    labels.push(`${previous + 1}–${edge}`);
    previous = edge;
  }
  labels.push(`${previous}+`);
  return labels;
}

/** Sums aged rows into the configured buckets, in order. */
export function summarise(rows: AgedRow[], buckets: number[]): AgingBucket[] {
  const labels = bucketLabels(buckets);
  const edges: (number | null)[] = [0, ...buckets, null];
  return labels.map((label, i) => {
    const matching = rows.filter((r) => r.bucket === label);
    return {
      label,
      from: i === 0 ? Number.NEGATIVE_INFINITY : (edges[i - 1] as number) + 1,
      to: edges[i],
      amount: cents(matching.reduce((s, r) => s + r.outstanding, 0)),
      count: matching.length,
    };
  });
}
