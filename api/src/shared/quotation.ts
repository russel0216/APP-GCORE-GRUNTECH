import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { cancelOpenRequest } from './approvals';

/**
 * A quotation's money, SCORO-style, in ONE place.
 *
 * SCORO carried a quote-level discount and a per-line cost with the provider
 * who carries it — a supplier (outsourced) or one of our own people
 * (in-house) — and showed the margin split both ways beside the lines. G-CORE
 * keeps all of that, and this file is the only thing that does the arithmetic:
 * the routes store what `quotationTotals` returns and the screen shows what it
 * returns, so the stored total and the panel beside it cannot disagree.
 *
 * The order, which is also the order the schema's doc comment gives:
 *
 *   subtotal       = Σ line amount                      (before discount)
 *   discountAmount = round2(subtotal × discountPct / 100)
 *   net            = subtotal − discountAmount
 *   VAT exclusive:  vatAmount = round2(net × rate); total = net + vatAmount
 *   VAT inclusive:  vatAmount = round2(net − net / (1 + rate)); total = net
 *
 * Margin is measured against the sum WITHOUT tax (`netOfTax`) — SCORO's "Sum
 * without tax". On a VAT-exclusive quote that is `net` itself; on an inclusive
 * one it is `net − vatAmount`, because the 12% in an inclusive price was never
 * ours to keep and counting it as margin would overstate every job.
 *
 * All of it is Decimal inside (rule 10) and rounded to the centavo, half up,
 * at each named step. The numbers returned are already exact to the centavo.
 */

type Money = Prisma.Decimal | number | string | null | undefined;

const D = (v: Money) => (v === null || v === undefined || v === '' ? new Prisma.Decimal(0) : new Prisma.Decimal(v));
const r2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const out = (v: Prisma.Decimal) => Number(r2(v).toFixed(2));
/** A percentage of `base`, to one decimal; null when the base is nothing. */
const pctOf = (part: Prisma.Decimal, base: Prisma.Decimal) =>
  base.isZero() ? null : Number(part.div(base).mul(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toFixed(1));

export interface QuotationLineMoney {
  amount: Money;
  costAmount?: Money;
  providerUserId?: string | null;
  providerSupplierId?: string | null;
  /** A subheading: no money, and not a line the cost panel counts. */
  isHeading?: boolean | null;
}

export interface QuotationTotalsInput {
  lines: QuotationLineMoney[];
  /** 0–100. */
  discountPct?: Money;
  /** The revision's snapshotted rate, e.g. 0.12. */
  vatRate: Money;
  vatInclusive?: boolean;
}

export interface LineMargin {
  amount: number;
  costAmount: number | null;
  /** amount − cost, BEFORE the quote-level discount (what SCORO shows per line). */
  margin: number | null;
  /** margin ÷ amount. */
  marginPct: number | null;
  kind: 'inHouse' | 'outsourced' | 'unassigned';
}

export interface CostPanel {
  totalCost: number;
  inHouseCost: number;
  outsourcedCost: number;
  /** Cost entered on a line with no provider named. */
  unassignedCost: number;
  totalMargin: number;
  inHouseMargin: number;
  outsourcedMargin: number;
  unassignedMargin: number;
  /** Each as a % of `netOfTax`, the sum without tax. Null on an empty quote. */
  totalCostPct: number | null;
  inHouseCostPct: number | null;
  outsourcedCostPct: number | null;
  totalMarginPct: number | null;
  inHouseMarginPct: number | null;
  outsourcedMarginPct: number | null;
  /** Lines with a cost entered, against all lines — a panel on half the lines is half a panel. */
  costedLines: number;
  lineCount: number;
}

export interface QuotationTotals {
  subtotal: number;
  discountPct: number;
  discountAmount: number;
  net: number;
  vatRate: number;
  vatInclusive: boolean;
  vatAmount: number;
  total: number;
  /** SCORO's "Sum without tax" — what margin is measured against. */
  netOfTax: number;
  cost: CostPanel;
  lines: LineMargin[];
}

function lineKind(l: QuotationLineMoney): LineMargin['kind'] {
  if (l.providerUserId) return 'inHouse';
  if (l.providerSupplierId) return 'outsourced';
  return 'unassigned';
}

export function quotationTotals(input: QuotationTotalsInput): QuotationTotals {
  const rate = D(input.vatRate);
  const pct = Prisma.Decimal.min(Prisma.Decimal.max(D(input.discountPct), 0), 100);
  const inclusive = !!input.vatInclusive;

  const amounts = input.lines.map((l) => r2(D(l.amount)));
  const subtotal = amounts.reduce((s, a) => s.add(a), new Prisma.Decimal(0));
  const discountAmount = r2(subtotal.mul(pct).div(100));
  const net = subtotal.sub(discountAmount);
  const vatAmount = inclusive ? r2(net.sub(net.div(rate.add(1)))) : r2(net.mul(rate));
  const total = inclusive ? net : net.add(vatAmount);
  const netOfTax = inclusive ? net.sub(vatAmount) : net;

  // What a peso of list price is worth after the discount and, on an
  // inclusive quote, after the tax is backed out. Applied pro rata, so a 10%
  // discount takes 10% off in-house and outsourced revenue alike.
  const factor = subtotal.isZero() ? new Prisma.Decimal(0) : netOfTax.div(subtotal);

  const zero = () => new Prisma.Decimal(0);
  const cost = { inHouse: zero(), outsourced: zero(), unassigned: zero() };
  const revenue = { inHouse: zero(), outsourced: zero(), unassigned: zero() };
  let costedLines = 0;

  const lines: LineMargin[] = input.lines.map((l, i) => {
    const kind = lineKind(l);
    const amount = amounts[i];
    const hasCost = l.costAmount !== null && l.costAmount !== undefined && l.costAmount !== '';
    const c = hasCost ? r2(D(l.costAmount)) : null;
    if (c) costedLines++;
    cost[kind] = cost[kind].add(c ?? 0);
    revenue[kind] = revenue[kind].add(amount);
    const margin = c ? amount.sub(c) : null;
    return {
      amount: out(amount),
      costAmount: c ? out(c) : null,
      margin: margin ? out(margin) : null,
      marginPct: margin ? pctOf(margin, amount) : null,
      kind,
    };
  });

  const totalCost = cost.inHouse.add(cost.outsourced).add(cost.unassigned);
  const totalMargin = netOfTax.sub(totalCost);
  const inHouseMargin = r2(revenue.inHouse.mul(factor)).sub(cost.inHouse);
  const outsourcedMargin = r2(revenue.outsourced.mul(factor)).sub(cost.outsourced);
  // The remainder, so the three always add up to the total to the centavo.
  const unassignedMargin = totalMargin.sub(inHouseMargin).sub(outsourcedMargin);

  return {
    subtotal: out(subtotal),
    discountPct: Number(pct.toFixed(4)),
    discountAmount: out(discountAmount),
    net: out(net),
    vatRate: Number(rate),
    vatInclusive: inclusive,
    vatAmount: out(vatAmount),
    total: out(total),
    netOfTax: out(netOfTax),
    cost: {
      totalCost: out(totalCost),
      inHouseCost: out(cost.inHouse),
      outsourcedCost: out(cost.outsourced),
      unassignedCost: out(cost.unassigned),
      totalMargin: out(totalMargin),
      inHouseMargin: out(inHouseMargin),
      outsourcedMargin: out(outsourcedMargin),
      unassignedMargin: out(unassignedMargin),
      totalCostPct: pctOf(totalCost, netOfTax),
      inHouseCostPct: pctOf(cost.inHouse, netOfTax),
      outsourcedCostPct: pctOf(cost.outsourced, netOfTax),
      totalMarginPct: pctOf(totalMargin, netOfTax),
      inHouseMarginPct: pctOf(inHouseMargin, netOfTax),
      outsourcedMarginPct: pctOf(outsourcedMargin, netOfTax),
      costedLines,
      lineCount: input.lines.filter((l) => !l.isHeading).length,
    },
    lines,
  };
}

/**
 * The Tax dropdown: the company's VAT rate, 8%, 6% for a government client,
 * and 0% for a zero-rated sale (PEZA or BOI-registered, or an export). A rate
 * typed by hand is how a quote goes out at 1.2%, so these are the only rates a
 * revision takes — plus the one a draft was already snapshotted with.
 */
export const QUOTATION_EXTRA_TAX_RATES: { rate: number; label: string }[] = [
  { rate: 0.08, label: '8%' },
  { rate: 0.06, label: '6% (Government)' },
];

export function quotationTaxOptions(companyRate: number): { rate: number; label: string }[] {
  const pct = (r: number) => `${Number((r * 100).toFixed(2))}%`;
  const options = [{ rate: companyRate, label: pct(companyRate) }, ...QUOTATION_EXTRA_TAX_RATES, { rate: 0, label: '0% (zero-rated)' }];
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.rate.toFixed(4)) ? false : (seen.add(o.rate.toFixed(4)), true)));
}

/** A line's stored amount: quantity × price, to the centavo, in Decimal. */
export function lineAmount(quantity: Money, unitPrice: Money): Prisma.Decimal {
  return r2(D(quantity).mul(D(unitPrice)));
}

/**
 * Recomputes a revision's stored money from its lines and its own snapshot of
 * the VAT rate and discount. Every writer of a revision's totals calls this —
 * the line routes, a new revision, filling from a costing, and continuing a
 * SCORO quote — so there is one arithmetic, not one per caller.
 */
export async function recalcQuotationRevision(revisionId: string, tx: Prisma.TransactionClient = prisma) {
  const rev = await tx.quotationRevision.findUnique({
    where: { id: revisionId },
    include: { items: true },
  });
  if (!rev) return null;
  const t = quotationTotals({
    lines: rev.items,
    discountPct: rev.discountPct,
    vatRate: rev.vatRate,
    vatInclusive: rev.vatInclusive,
  });
  return tx.quotationRevision.update({
    where: { id: revisionId },
    data: {
      subtotal: new Prisma.Decimal(t.subtotal.toFixed(2)),
      discountAmount: new Prisma.Decimal(t.discountAmount.toFixed(2)),
      vatAmount: new Prisma.Decimal(t.vatAmount.toFixed(2)),
      total: new Prisma.Decimal(t.total.toFixed(2)),
    },
  });
}

// ── A costing's scope of work as quotation lines ────────────────────────────

/** What a scope section contributes to a quotation line. */
export interface ScopeSectionForQuote {
  name: string;
  description: string | null;
  value: Prisma.Decimal;
}

/**
 * The one mapping from a costing's scope of work to quotation lines: the
 * section's name is the line's title (bold on the PDF), its description the
 * text under it, one lot at the section's value. "Fill from costing" writes
 * exactly this, and the editor previews exactly this before anything is saved
 * (`GET /quotations/costing-lines`), so the preview and the stored lines
 * cannot disagree.
 */
export function quotationLinesFromSections(sections: ScopeSectionForQuote[]) {
  return sections.map((s, i) => ({
    title: s.name,
    description: s.description ?? '',
    quantity: new Prisma.Decimal(1),
    unit: 'lot',
    unitPrice: s.value,
    amount: s.value,
    sortOrder: i,
  }));
}

/** A costing's scope sections, in their order — what the mapping above reads. */
export function costingScopeSections(costingId: string, tx: Prisma.TransactionClient = prisma) {
  return tx.scopeSection.findMany({
    where: { costingId },
    orderBy: { sortOrder: 'asc' },
    select: { name: true, description: true, value: true },
  });
}

// ── Who may see cost ─────────────────────────────────────────────────────────

/**
 * Cost and margin are internal. They are returned to whoever may edit the
 * quotation (the author, or anyone holding edit_all) and to anyone who sees
 * costings across the company; to everybody else the server never sends them.
 * Hidden in the UI alone would be hidden from nobody who opens the network tab
 * — the same rule as the pay rates in G-HR.
 */
export function canSeeQuotationCost(user: ResolvedUser, ownerId: string | null): boolean {
  return canEditRecord(user, 'gops', 'quotations', ownerId) || can(user, 'gops.costing.view_all');
}

/** The keys on a quotation line that are cost, and never leave for a caller who may not see it. */
export const LINE_COST_KEYS = [
  'unitCost',
  'costAmount',
  'providerSupplierId',
  'providerSupplier',
  'providerUserId',
  'providerUser',
  'costNote',
] as const;

export function stripLineCost<T extends Record<string, unknown>>(line: T): Omit<T, (typeof LINE_COST_KEYS)[number]> {
  const copy: Record<string, unknown> = { ...line };
  for (const k of LINE_COST_KEYS) delete copy[k];
  return copy as Omit<T, (typeof LINE_COST_KEYS)[number]>;
}

// ── Approvals left open on revisions that moved on ──────────────────────────

/**
 * Withdraws every quotation approval request still open on a revision that is
 * no longer waiting for it. Raising a revision used to supersede the latest
 * one without withdrawing its request (it now does, through
 * `cancelOpenRequest`), and each such request sat in its approvers' queue for
 * good. The rule this restores: a quotation's request is open only while its
 * revision is PENDING_APPROVAL.
 *
 * Idempotent — the seed runs it on every deploy, and a second run withdraws
 * nothing. Nothing is deleted: each request stays in the history, CANCELLED.
 * `revisionIds` narrows it to those revisions (a verify script's own). Returns
 * the revisions it withdrew a request from, as "GT-QT-2026-0161 R0".
 */
export async function withdrawStaleQuotationApprovals(revisionIds?: string[]): Promise<string[]> {
  const open = await prisma.approvalRequest.findMany({
    where: { documentType: 'quotation', status: 'PENDING', ...(revisionIds ? { documentId: { in: revisionIds } } : {}) },
    select: { documentId: true, documentNumber: true },
  });
  const withdrawn: string[] = [];
  for (const { documentId, documentNumber } of open) {
    const label = await prisma.$transaction(async (tx) => {
      const revision = await tx.quotationRevision.findUnique({
        where: { id: documentId },
        select: { revision: true, status: true, quotation: { select: { number: true } } },
      });
      if (revision?.status === 'PENDING_APPROVAL') return null; // still waiting: its request is right
      const reason = !revision
        ? 'its revision no longer exists'
        : revision.status === 'SUPERSEDED'
          ? 'superseded before anybody decided'
          : `its revision is no longer waiting for approval (${revision.status.toLowerCase()})`;
      if (!(await cancelOpenRequest('quotation', documentId, tx, reason)).length) return null;
      return revision ? `${revision.quotation.number} R${revision.revision}` : (documentNumber ?? documentId);
    });
    if (label && !withdrawn.includes(label)) withdrawn.push(label);
  }
  return withdrawn;
}
