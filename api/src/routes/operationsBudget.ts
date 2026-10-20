import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, badRequest } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { requireView, requireEdit } from '../shared/ownScope';
import { renderDocument, formatAmount, formatMoney, formatShortDate, companyCurrency, type PdfSection } from '../shared/pdf';
import { sendListPdf } from '../shared/listPaper';
import { manilaDate } from '../shared/day';

/**
 * G-FIN › Analysis › OPERATIONS BUDGET (2026-10-20, the owner's call: "create
 * a separate budget monitoring for office operation, different from the
 * project budget"; his answer to the plan: yearly, per cost category, set by
 * finance, no approval route).
 *
 * The budget is `OperationsBudget` (year × cost category → amount). What was
 * spent against it is READ, never stored — the documents that name NO
 * project:
 *
 * - expense claims (reimbursements, and liquidations of an advance with no
 *   project) — APPROVED, REIMBURSED or SETTLED is spent, PENDING_APPROVAL is
 *   pending — at their total, on their claim date;
 * - supplier bills not for goods bought on a purchase order (an order's goods
 *   are stock, an asset, or a project's) — APPROVED, PARTIALLY_PAID or PAID
 *   is spent, PENDING_APPROVAL pending — at the SUBTOTAL (input VAT is
 *   recoverable, the job-cost rule), on their bill date.
 *
 * Left = budget − spent − pending. A document with no cost category is shown
 * apart ("Not categorised") so the lines still add up to the totals.
 */
export const operationsBudgetRoutes = Router();
operationsBudgetRoutes.use(authenticate);

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;

const SPENT_CLAIM = ['APPROVED', 'REIMBURSED', 'SETTLED'] as const;
const SPENT_BILL = ['APPROVED', 'PARTIALLY_PAID', 'PAID'] as const;

function yearOf(raw: unknown): number {
  const thisYear = Number(manilaDate(new Date()).toISOString().slice(0, 4));
  if (raw === undefined || raw === '') return thisYear;
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > thisYear + 5) throw badRequest('Choose a year from 2000 to five years ahead');
  return y;
}

const yearRange = (year: number) => ({ gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) });

/** The office's spending of a year: claims and bills that name no project. */
function spendingWhere(year: number) {
  return {
    claim: { jobId: null, claimDate: yearRange(year) } satisfies Prisma.ExpenseClaimWhereInput,
    bill: { jobId: null, orderId: null, receivingId: null, billDate: yearRange(year) } satisfies Prisma.SupplierBillWhereInput,
  };
}

/** The year's budget against what was spent and is pending, per cost category. */
export async function operationsPosition(year: number) {
  const w = spendingWhere(year);
  const [categories, budgets, claims, bills] = await Promise.all([
    prisma.costCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true, isActive: true } }),
    prisma.operationsBudget.findMany({ where: { year }, include: { updatedBy: { select: { name: true } } } }),
    prisma.expenseClaim.groupBy({
      by: ['costCategoryId', 'status'],
      where: { ...w.claim, status: { in: [...SPENT_CLAIM, 'PENDING_APPROVAL'] } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.supplierBill.groupBy({
      by: ['costCategoryId', 'status'],
      where: { ...w.bill, status: { in: [...SPENT_BILL, 'PENDING_APPROVAL'] } },
      _sum: { subtotal: true },
      _count: { _all: true },
    }),
  ]);
  const spentOf = (id: string | null) =>
    cents(
      claims.filter((c) => c.costCategoryId === id && (SPENT_CLAIM as readonly string[]).includes(c.status)).reduce((t, c) => t + num(c._sum.total), 0) +
        bills.filter((b) => b.costCategoryId === id && (SPENT_BILL as readonly string[]).includes(b.status)).reduce((t, b) => t + num(b._sum.subtotal), 0),
    );
  const pendingOf = (id: string | null) =>
    cents(
      claims.filter((c) => c.costCategoryId === id && c.status === 'PENDING_APPROVAL').reduce((t, c) => t + num(c._sum.total), 0) +
        bills.filter((b) => b.costCategoryId === id && b.status === 'PENDING_APPROVAL').reduce((t, b) => t + num(b._sum.subtotal), 0),
    );
  const byCategory = new Map(budgets.map((b) => [b.costCategoryId, b]));
  const lines = categories
    .map((c) => {
      const b = byCategory.get(c.id);
      const budget = num(b?.amount);
      const spent = spentOf(c.id);
      const pending = pendingOf(c.id);
      const left = cents(budget - spent - pending);
      return {
        costCategory: { id: c.id, code: c.code, name: c.name },
        budget,
        notes: b?.notes ?? null,
        spent,
        pending,
        left,
        usedPct: budget > 0 ? Math.round(((spent + pending) / budget) * 1000) / 10 : null,
        over: budget > 0 ? left < -0.005 : spent + pending > 0.005,
        updatedAt: b?.updatedAt ?? null,
        updatedBy: b?.updatedBy?.name ?? null,
        isActive: c.isActive,
      };
    })
    // An inactive category stays while it has a budget or spending.
    .filter((l) => l.isActive || l.budget > 0 || l.spent > 0 || l.pending > 0);
  const uncategorised = { spent: spentOf(null), pending: pendingOf(null) };
  const sum = (f: (l: (typeof lines)[number]) => number) => cents(lines.reduce((t, l) => t + f(l), 0));
  const budget = sum((l) => l.budget);
  const spent = cents(sum((l) => l.spent) + uncategorised.spent);
  const pending = cents(sum((l) => l.pending) + uncategorised.pending);
  return {
    year,
    lines,
    uncategorised,
    totals: { budget, spent, pending, left: cents(budget - spent - pending), usedPct: budget > 0 ? Math.round(((spent + pending) / budget) * 1000) / 10 : null },
  };
}

/** The documents behind the figures — the screen's drill-down, newest first. */
async function spendingDocuments(year: number, costCategoryId: string | null | undefined) {
  const w = spendingWhere(year);
  const cat = costCategoryId === undefined ? {} : { costCategoryId: costCategoryId === 'none' ? null : costCategoryId };
  const [claims, bills] = await Promise.all([
    prisma.expenseClaim.findMany({
      where: { ...w.claim, ...cat, status: { in: [...SPENT_CLAIM, 'PENDING_APPROVAL'] } },
      select: { id: true, number: true, claimDate: true, purpose: true, status: true, total: true, claimedBy: { select: { name: true } }, costCategory: { select: { name: true } } },
      orderBy: { claimDate: 'desc' },
      take: 200,
    }),
    prisma.supplierBill.findMany({
      where: { ...w.bill, ...cat, status: { in: [...SPENT_BILL, 'PENDING_APPROVAL'] } },
      select: { id: true, number: true, billDate: true, status: true, subtotal: true, supplier: { select: { name: true } }, costCategory: { select: { name: true } } },
      orderBy: { billDate: 'desc' },
      take: 200,
    }),
  ]);
  return [
    ...claims.map((c) => ({
      kind: 'claim' as const,
      id: c.id,
      number: c.number,
      date: c.claimDate,
      party: c.claimedBy.name,
      what: c.purpose,
      category: c.costCategory?.name ?? null,
      status: c.status,
      pending: c.status === 'PENDING_APPROVAL',
      amount: num(c.total),
    })),
    ...bills.map((b) => ({
      kind: 'bill' as const,
      id: b.id,
      number: b.number,
      date: b.billDate,
      party: b.supplier.name,
      what: 'Supplier bill',
      category: b.costCategory?.name ?? null,
      status: b.status,
      pending: b.status === 'PENDING_APPROVAL',
      amount: num(b.subtotal),
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());
}

const mayChange = (me: ResolvedUser) =>
  me.isSuperAdmin || can(me, 'gfin.operations_budget.edit_all') || can(me, 'gfin.operations_budget.edit_team') || can(me, 'gfin.operations_budget.edit_own');

operationsBudgetRoutes.get(
  '/',
  requireView('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const year = yearOf(req.query.year);
    const [position, documents, set] = await Promise.all([
      operationsPosition(year),
      spendingDocuments(year, req.query.costCategoryId === undefined ? undefined : String(req.query.costCategoryId)),
      prisma.operationsBudget.findMany({ distinct: ['year'], select: { year: true }, orderBy: { year: 'desc' } }),
    ]);
    const thisYear = yearOf(undefined);
    const years = [...new Set([thisYear + 1, thisYear, ...set.map((r) => r.year), year])].sort((a, b) => b - a);
    res.json({ ...position, years, documents, canEdit: mayChange(me) });
  }),
);

/** The year's lines, replaced whole: each category's amount (0 leaves it unbudgeted) and a note. Audited once. */
operationsBudgetRoutes.put(
  '/:year',
  requireEdit('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const year = yearOf(req.params.year);
    const body = parseBody(
      z.object({
        lines: z
          .array(z.object({ costCategoryId: z.string().min(1), amount: z.number().min(0).max(1e12), notes: z.string().trim().max(500).optional().nullable() }))
          .max(100),
      }),
      req.body ?? {},
    );
    const ids = [...new Set(body.lines.map((l) => l.costCategoryId))];
    if (ids.length !== body.lines.length) throw badRequest('A cost category is named twice');
    const known = await prisma.costCategory.count({ where: { id: { in: ids } } });
    if (known !== ids.length) throw badRequest('A cost category named is not on file');
    const before = await prisma.operationsBudget.findMany({ where: { year }, select: { costCategoryId: true, amount: true } });
    await prisma.$transaction(async (tx) => {
      for (const l of body.lines) {
        const amount = new Prisma.Decimal(cents(l.amount));
        if (amount.isZero() && !l.notes?.trim()) {
          await tx.operationsBudget.deleteMany({ where: { year, costCategoryId: l.costCategoryId } });
          continue;
        }
        await tx.operationsBudget.upsert({
          where: { year_costCategoryId: { year, costCategoryId: l.costCategoryId } },
          create: { year, costCategoryId: l.costCategoryId, amount, notes: l.notes?.trim() || null, updatedById: me.id },
          update: { amount, notes: l.notes?.trim() || null, updatedById: me.id },
        });
      }
    });
    const after = await operationsPosition(year);
    await audit(
      {
        entityType: 'operations_budget',
        entityId: String(year),
        action: 'UPDATED',
        summary: `Operations budget ${year} set — ${formatMoney(after.totals.budget, await companyCurrency())} in all`,
        before: { lines: before.map((b) => ({ costCategoryId: b.costCategoryId, amount: num(b.amount) })) },
        after: { lines: after.lines.filter((l) => l.budget > 0).map((l) => ({ costCategoryId: l.costCategory.id, amount: l.budget })) },
      },
      req,
    );
    res.json({ ...after, canEdit: true });
  }),
);

/** The year on paper: budget, spent, pending and left per category, the totals, and the overspent lines named. */
operationsBudgetRoutes.get(
  '/pdf',
  requireView('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const year = yearOf(req.query.year);
    const p = await operationsPosition(year);
    const currency = await companyCurrency();
    const rows = p.lines.map((l) => [
      { title: l.costCategory.name, body: l.notes ?? '' },
      formatAmount(l.budget),
      formatAmount(l.spent),
      formatAmount(l.pending),
      formatAmount(l.left),
      l.usedPct == null ? '—' : `${l.usedPct.toFixed(1)}%`,
    ]);
    if (p.uncategorised.spent > 0.005 || p.uncategorised.pending > 0.005) {
      rows.push([{ title: 'Not categorised', body: 'Claims and bills that name no cost category' }, '—', formatAmount(p.uncategorised.spent), formatAmount(p.uncategorised.pending), '—', '—']);
    }
    const over = p.lines.filter((l) => l.over);
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Cost category', `Budget (${currency})`, `Spent (${currency})`, `Pending (${currency})`, `Left (${currency})`, 'Used'],
        align: ['left', 'right', 'right', 'right', 'right', 'right'],
        rows,
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Budget', value: formatMoney(p.totals.budget, currency) },
          { label: 'Spent', value: formatMoney(p.totals.spent, currency) },
          { label: 'Pending approval', value: formatMoney(p.totals.pending, currency) },
          { label: 'Left', value: formatMoney(p.totals.left, currency), bold: true },
        ],
      },
      {
        kind: 'text',
        body:
          'Spent is approved expense claims and supplier bills that name no project (a bill for goods on a purchase order is stock or a project’s, not office spending), at the amount before VAT for a bill. Pending is the same waiting for approval.' +
          (over.length ? `\n\nOver budget: ${over.map((l) => l.costCategory.name).join(', ')}.` : ''),
      },
    ];
    const pdf = await renderDocument({ title: `Operations Budget ${year}`, date: new Date(), reference: `As of ${formatShortDate(new Date())}`, sections });
    await audit({ entityType: 'operations_budget', entityId: String(year), action: 'EXPORTED', summary: `Printed the operations budget ${year}` }, req);
    sendListPdf(res, pdf, 'operations-budget.pdf');
  }),
);

