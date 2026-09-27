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
 *
 * Phase 10 adds the cash advance, and with it a second rule of the same
 * shape: **a liquidation is settled against what the person is still owed**,
 * which is the receipts less the cash they were already handed. A liquidation
 * measured against its own total would owe the person their advance twice.
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
  /**
   * Days a person has to liquidate a cash advance, counted from the day the
   * cash was handed over — the payment date, cleared or not. Snapshotted onto
   * the advance at release, so changing it never moves a deadline already set.
   */
  advanceLiquidationDays: number;
  /**
   * Refuse a new advance to somebody still holding an unliquidated one. Staff
   * on two trips in one week will be refused until finance turns this off.
   */
  blockAdvanceWhileUnliquidated: boolean;
}

const DEFAULTS: FinanceSettings = {
  defaultTermsDays: 30,
  supplierEwtGoods: 0.01,
  supplierEwtServices: 0.02,
  agingBuckets: [30, 60, 90],
  advanceLiquidationDays: 30,
  blockAdvanceWhileUnliquidated: true,
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
      description: 'Payment terms, supplier withholding rates, aging buckets and cash-advance rules',
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

/**
 * What a claim is settled against.
 *
 * A plain claim: its total. A liquidation: its total less the cash the person
 * was already handed, floored at zero — the receipts cover the advance and
 * the excess, if any, is what is still owed to them. Unspent cash goes the
 * other way and is carried on the advance, never here. For a plain claim this
 * is exactly `total`, so nothing that existed before this function moved.
 */
export function claimPayable(row: {
  total: Prisma.Decimal | number;
  advance?: { amountReleased: Prisma.Decimal | number } | null;
}): number {
  const total = Number(row.total);
  const released = row.advance ? Number(row.advance.amountReleased) : 0;
  return cents(Math.max(0, total - released));
}

export type SettleableKind = 'invoice' | 'bill' | 'claim' | 'advance' | 'advance_refund';

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
 * `invoiceTotal − collected`. For an advance it is the amount not yet handed
 * over (APPROVED only — nothing is owed on a draft); for an advance refund it
 * is the unspent cash not yet returned (REFUND_DUE only).
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
  if (kind === 'advance') {
    const row = await tx.cashAdvance.findUnique({ where: { id } });
    if (!row) return null;
    const payable = num(row.amount);
    const paid = num(row.amountReleased);
    return {
      kind,
      id,
      number: row.number,
      payable,
      paid,
      outstanding: row.status === 'APPROVED' ? cents(payable - paid) : 0,
    };
  }
  if (kind === 'advance_refund') {
    const row = await tx.cashAdvance.findUnique({ where: { id } });
    if (!row) return null;
    // Nothing is owed back until a liquidation has said what was spent.
    const payable = row.liquidatedAt ? cents(Math.max(0, num(row.amountReleased) - num(row.amountSpent))) : 0;
    const paid = num(row.amountRefunded);
    return {
      kind,
      id,
      number: row.number,
      payable,
      paid,
      outstanding: row.status === 'REFUND_DUE' ? cents(payable - paid) : 0,
    };
  }
  const row = await tx.expenseClaim.findUnique({ where: { id }, include: { advance: true } });
  if (!row) return null;
  const payable = claimPayable(row);
  const paid = num(row.amountPaid);
  return { kind, id, number: row.number, payable, paid, outstanding: cents(payable - paid) };
}

/**
 * The ONE function that decides an advance's figures and its status.
 *
 * Every figure on the advance is a cache re-derived from the rows around it:
 * released is the sum of DISBURSEMENT allocations, refunded the sum of RECEIPT
 * allocations, spent the approved liquidation's total. Nothing increments
 * them, so reversing a payment or re-filing a liquidation cannot leave a
 * stale balance behind. DRAFT, PENDING_APPROVAL, REJECTED and CANCELLED are
 * left alone — those are decisions, not arithmetic.
 */
export async function refreshAdvance(
  tx: Tx,
  id: string,
): Promise<{ paid: number; outstanding: number; status: string }> {
  const row = await tx.cashAdvance.findUnique({ where: { id } });
  if (!row) throw badRequest('Cash advance not found');

  const allocations = await tx.paymentAllocation.findMany({
    where: { advanceId: id },
    select: { amount: true, payment: { select: { kind: true, paymentDate: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const releases = allocations.filter((a) => a.payment.kind === 'DISBURSEMENT');
  const released = cents(releases.reduce((s, a) => s + num(a.amount), 0));
  const refunded = cents(
    allocations.filter((a) => a.payment.kind === 'RECEIPT').reduce((s, a) => s + num(a.amount), 0),
  );

  const liquidation = await tx.expenseClaim.findFirst({
    where: { advanceId: id, status: { in: ['APPROVED', 'SETTLED', 'REIMBURSED'] } },
    orderBy: { approvedAt: 'desc' },
    select: { total: true, approvedAt: true },
  });
  const spent = liquidation ? num(liquidation.total) : 0;
  const liquidatedAt = liquidation ? liquidation.approvedAt : null;
  const amount = num(row.amount);

  const frozen = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'].includes(row.status);
  let status: string = row.status;
  if (!frozen) {
    if (!liquidation) {
      status = released + 0.005 >= amount ? 'RELEASED' : 'APPROVED';
    } else {
      const refundDue = cents(Math.max(0, released - spent));
      status = refundDue - refunded > 0.005 ? 'REFUND_DUE' : 'LIQUIDATED';
    }
  }

  // The liquidation clock starts when the person holds the cash, cheque or
  // not — so the release payment's date, not the day it cleared.
  const isReleased = !frozen && status !== 'APPROVED';
  const releasedAt = isReleased ? (row.releasedAt ?? releases[0]?.payment.paymentDate ?? dayKey(new Date())) : null;
  let liquidationDueDate: Date | null = null;
  if (releasedAt) {
    if (row.liquidationDueDate) liquidationDueDate = row.liquidationDueDate;
    else {
      const settings = await financeSettings();
      liquidationDueDate = addDays(releasedAt, settings.advanceLiquidationDays);
    }
  }

  await tx.cashAdvance.update({
    where: { id },
    data: {
      amountReleased: D(released),
      amountRefunded: D(refunded),
      amountSpent: D(spent),
      liquidatedAt,
      releasedAt,
      liquidationDueDate,
      status: status as never,
    },
  });

  const payable = status === 'REFUND_DUE' ? cents(Math.max(0, released - spent)) : amount;
  const paid = status === 'REFUND_DUE' ? refunded : released;
  return { paid, outstanding: cents(payable - paid), status };
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
  if (kind === 'advance' || kind === 'advance_refund') return refreshAdvance(tx, id);

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

  const row = await tx.expenseClaim.findUnique({ where: { id }, include: { advance: true } });
  if (!row) throw badRequest('Expense claim not found');
  const payable = claimPayable(row);
  // SETTLED is terminal: the advance covered every receipt, so there is
  // nothing to reimburse and no payment can move it. A payable of zero on an
  // APPROVED claim likewise stays where it is.
  const status =
    row.status === 'APPROVED' || row.status === 'REIMBURSED'
      ? payable === 0
        ? row.status
        : paid + 0.005 >= payable && paid > 0
          ? 'REIMBURSED'
          : 'APPROVED'
      : row.status;
  await tx.expenseClaim.update({
    where: { id },
    data: { amountPaid: D(paid), status: status as never },
  });
  return { paid, outstanding: cents(payable - paid), status };
}

// ── The position ─────────────────────────────────────────────────────────────

export interface FinancePosition {
  receivable: number;
  receivableOverdue: number;
  payable: number;
  payableOverdue: number;
  /** Approved claims and liquidations not yet paid back, at what is still owed. */
  reimbursable: number;
  /** Withheld at source and not yet certificated. Real money, never overdue. */
  withheldAwaitingCertificate: number;
  /** Approved advances finance has not yet handed over. */
  advancesToRelease: number;
  /** Cash out with people, waiting on a liquidation. */
  advancesInHand: number;
  /** Receivable less everything owed — suppliers, staff, and cash promised. */
  workingPosition: number;
}

/**
 * Where the company stands, decided once.
 *
 * G-FIN's dashboard and Insights' company overview both print a working
 * position, and for a while they disagreed because each summed its own
 * documents. Every consumer reads this instead. The queries are the
 * dashboard's own, moved here unchanged.
 */
export async function financePosition(today: Date): Promise<FinancePosition> {
  const [openInvoices, openBills, openClaims, openAdvances] = await Promise.all([
    prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: { dueDate: true, netCollectible: true, amountCollected: true, ewtAmount: true, ewtCertificateNo: true },
    }),
    prisma.supplierBill.findMany({
      where: { status: { in: ['APPROVED', 'PARTIALLY_PAID'] } },
      select: { dueDate: true, netPayable: true, amountPaid: true },
    }),
    prisma.expenseClaim.findMany({
      where: { status: 'APPROVED' },
      select: { total: true, amountPaid: true, advance: { select: { amountReleased: true } } },
    }),
    prisma.cashAdvance.findMany({
      where: { status: { in: ['APPROVED', 'RELEASED', 'REFUND_DUE'] } },
      select: { status: true, amount: true, amountReleased: true, amountSpent: true, amountRefunded: true },
    }),
  ]);

  const receivable = cents(
    openInvoices.reduce((s, i) => s + (num(i.netCollectible) - num(i.amountCollected)), 0),
  );
  const receivableOverdue = cents(
    openInvoices
      .filter((i) => i.dueDate < today)
      .reduce((s, i) => s + (num(i.netCollectible) - num(i.amountCollected)), 0),
  );
  const payable = cents(openBills.reduce((s, b) => s + (num(b.netPayable) - num(b.amountPaid)), 0));
  const payableOverdue = cents(
    openBills.filter((b) => b.dueDate < today).reduce((s, b) => s + (num(b.netPayable) - num(b.amountPaid)), 0),
  );
  const reimbursable = cents(
    openClaims.reduce((s, c) => s + Math.max(0, claimPayable(c) - num(c.amountPaid)), 0),
  );
  const advancesToRelease = cents(
    openAdvances
      .filter((a) => a.status === 'APPROVED')
      .reduce((s, a) => s + Math.max(0, num(a.amount) - num(a.amountReleased)), 0),
  );
  // Released and not yet accounted for: the full amount while the liquidation
  // is pending, the unreturned remainder once it says what was spent.
  const advancesInHand = cents(
    openAdvances
      .filter((a) => a.status !== 'APPROVED')
      .reduce(
        (s, a) =>
          s +
          (a.status === 'RELEASED'
            ? num(a.amountReleased)
            : Math.max(0, num(a.amountReleased) - num(a.amountSpent) - num(a.amountRefunded))),
        0,
      ),
  );

  return {
    receivable,
    receivableOverdue,
    payable,
    payableOverdue,
    reimbursable,
    withheldAwaitingCertificate: cents(
      openInvoices.filter((i) => !i.ewtCertificateNo).reduce((s, i) => s + num(i.ewtAmount), 0),
    ),
    advancesToRelease,
    advancesInHand,
    // Receivable minus everything owed. Not a bank balance — G-Core does not
    // hold one — but the number that says whether collections are keeping up.
    // An approved advance is cash promised, so it counts against the position
    // before the voucher exists.
    workingPosition: cents(receivable - payable - reimbursable - advancesToRelease),
  };
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
