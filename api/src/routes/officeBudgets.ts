import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, badRequest, notFound } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { requireView, requireEdit } from '../shared/ownScope';
import { renderDocument, formatAmount, formatMoney, formatShortDate, companyCurrency, statusLabel, type PdfSection } from '../shared/pdf';
import { sendListPdf } from '../shared/listPaper';
import { manilaDate } from '../shared/day';
import { officeBudgetPosition, officeBudgetsOfYear, officeDocuments, officeLineOptions, officeLineUse } from '../shared/officeBudget';

/**
 * G-FIN › Analysis › OFFICE BUDGET (2026-11-10, the owner's call; it replaced
 * the per-category Operations Budget of 2026-10-20, keeping its menu path and
 * its permission key `gfin.operations_budget`). A year holds any number of
 * named budgets, each a list of coded lines; whoever may edit the page
 * (the Finance Manager, by the owner's call) creates, copies and changes
 * them. The figures are `shared/officeBudget.ts`'s — read off the documents.
 */
export const officeBudgetRoutes = Router();
officeBudgetRoutes.use(authenticate);

const cents = (n: number) => Math.round(n * 100) / 100;
const D = (n: number) => new Prisma.Decimal(cents(n));

function yearOf(raw: unknown): number {
  const thisYear = Number(manilaDate(new Date()).toISOString().slice(0, 4));
  if (raw === undefined || raw === '') return thisYear;
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > thisYear + 5) throw badRequest('Choose a year from 2000 to five years ahead');
  return y;
}

const mayChange = (me: ResolvedUser) =>
  me.isSuperAdmin || can(me, 'gfin.operations_budget.edit_all') || can(me, 'gfin.operations_budget.edit_team') || can(me, 'gfin.operations_budget.edit_own');

/** The forms' picker: the open lines of the open budgets, with what is left. Anyone signed in — whoever files a claim picks one. */
officeBudgetRoutes.get(
  '/lines',
  handler(async (_req, res) => {
    res.json({ budgets: await officeLineOptions() });
  }),
);

officeBudgetRoutes.get(
  '/',
  requireView('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const year = yearOf(req.query.year);
    const [budgets, set] = await Promise.all([
      officeBudgetsOfYear(year),
      prisma.officeBudget.findMany({ distinct: ['year'], select: { year: true }, orderBy: { year: 'desc' } }),
    ]);
    const thisYear = yearOf(undefined);
    const years = [...new Set([thisYear + 1, thisYear, ...set.map((r) => r.year), year])].sort((a, b) => b - a);
    const sum = (k: 'budget' | 'requested' | 'released' | 'actual' | 'remaining') => cents(budgets.reduce((s, b) => s + b.total[k], 0));
    res.json({
      year,
      years,
      budgets,
      total: { budget: sum('budget'), requested: sum('requested'), released: sum('released'), actual: sum('actual'), remaining: sum('remaining') },
      canEdit: mayChange(me),
    });
  }),
);

const lineSchema = z.object({
  id: z.string().optional(),
  code: z.string().trim().min(1, 'Every line needs a code').max(20),
  name: z.string().trim().min(1, 'Every line needs a name').max(200),
  amount: z.number().min(0).max(1e12),
  openingActual: z.number().min(0).max(1e12).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

const createSchema = z.object({
  year: z.number().int(),
  name: z.string().trim().min(2, 'Name the budget').max(120),
  notes: z.string().trim().max(1000).optional().nullable(),
  /** Start from another budget's lines — codes, names and amounts; the actuals start at zero. */
  copyFromId: z.string().optional().nullable(),
  lines: z.array(lineSchema).max(300).optional(),
});

function checkCodes(lines: { code: string }[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    const k = l.code.toLowerCase();
    if (seen.has(k)) throw badRequest(`Line code ${l.code} is used twice`);
    seen.add(k);
  }
}

async function assertNameFree(year: number, name: string, exceptId?: string) {
  const clash = await prisma.officeBudget.findFirst({
    where: { year, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw badRequest(`${year} already has a budget named ${name}`);
}

officeBudgetRoutes.post(
  '/',
  requireEdit('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body ?? {});
    const year = yearOf(body.year);
    await assertNameFree(year, body.name);
    let lines = (body.lines ?? []).map((l, i) => ({ code: l.code, name: l.name, amount: D(l.amount), openingActual: D(l.openingActual ?? 0), notes: l.notes || null, sortOrder: i }));
    let from: string | null = null;
    if (body.copyFromId) {
      const source = await prisma.officeBudget.findUnique({
        where: { id: body.copyFromId },
        include: { lines: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
      });
      if (!source) throw badRequest('The budget to copy is not on file');
      from = source.name;
      lines = source.lines.map((l, i) => ({ code: l.code, name: l.name, amount: l.amount, openingActual: D(0), notes: l.notes, sortOrder: i }));
    }
    checkCodes(lines);
    const made = await prisma.officeBudget.create({
      data: { year, name: body.name, notes: body.notes || null, createdById: me.id, lines: { create: lines } },
    });
    await audit(
      {
        entityType: 'office_budget',
        entityId: made.id,
        action: 'CREATED',
        summary: `Office budget ${body.name} (${year}) created${from ? `, copied from ${from}` : ''} — ${lines.length} line${lines.length === 1 ? '' : 's'}`,
      },
      req,
    );
    res.status(201).json({ id: made.id });
  }),
);

officeBudgetRoutes.get(
  '/:id',
  requireView('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const position = await officeBudgetPosition(req.params.id);
    if (!position) throw notFound('Office budget not found');
    const ids = position.lines.map((l) => l.id);
    const lineId = typeof req.query.lineId === 'string' && ids.includes(req.query.lineId) ? req.query.lineId : null;
    const [documents, use] = await Promise.all([officeDocuments(lineId ? [lineId] : ids), officeLineUse(ids)]);
    const names = new Map(position.lines.map((l) => [l.id, `${l.code} ${l.name}`]));
    res.json({
      ...position,
      lines: position.lines.map((l) => ({ ...l, documents: use.get(l.id) ?? 0 })),
      documents: documents.slice(0, 300).map((d) => ({ ...d, line: names.get(d.lineId) ?? '' })),
      documentCount: documents.length,
      canEdit: mayChange(me),
    });
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2, 'Name the budget').max(120),
  notes: z.string().trim().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
  lines: z.array(lineSchema).max(300),
});

/**
 * The budget saved whole: its name, whether it is open, and its lines — a
 * line sent with its id is changed in place, a new one added, one left out
 * removed, or CLOSED when a document already charges it (its figures stay on
 * the budget). One audit row with the lines before and after.
 */
officeBudgetRoutes.put(
  '/:id',
  requireEdit('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const body = parseBody(updateSchema, req.body ?? {});
    const existing = await prisma.officeBudget.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!existing) throw notFound('Office budget not found');
    await assertNameFree(existing.year, body.name, existing.id);
    checkCodes(body.lines);
    const known = new Map(existing.lines.map((l) => [l.id, l]));
    for (const l of body.lines) if (l.id && !known.has(l.id)) throw badRequest(`Line ${l.code} belongs to another budget`);
    const kept = new Set(body.lines.map((l) => l.id).filter((id): id is string => !!id));
    const dropped = existing.lines.filter((l) => !kept.has(l.id));
    const use = await officeLineUse(dropped.map((l) => l.id));
    const closed: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.officeBudget.update({
        where: { id: existing.id },
        data: { name: body.name, notes: body.notes === undefined ? existing.notes : body.notes || null, isActive: body.isActive ?? existing.isActive },
      });
      for (const l of dropped) {
        if ((use.get(l.id) ?? 0) > 0) {
          closed.push(l.code);
          // Its code is parked so a new line may take it.
          await tx.officeBudgetLine.update({ where: { id: l.id }, data: { isActive: false, code: l.code.endsWith(' (closed)') ? l.code : `${l.code} (closed)`.slice(0, 40), sortOrder: 9000 } });
        } else await tx.officeBudgetLine.delete({ where: { id: l.id } });
      }
      // Two passes, so two lines may swap codes without tripping the unique index.
      for (const l of body.lines) if (l.id) await tx.officeBudgetLine.update({ where: { id: l.id }, data: { code: `~${l.id}` } });
      for (const [i, l] of body.lines.entries()) {
        const data = {
          code: l.code,
          name: l.name,
          amount: D(l.amount),
          ...(l.openingActual === undefined ? {} : { openingActual: D(l.openingActual) }),
          notes: l.notes || null,
          isActive: l.isActive ?? true,
          sortOrder: i,
        };
        if (l.id) await tx.officeBudgetLine.update({ where: { id: l.id }, data });
        else await tx.officeBudgetLine.create({ data: { ...data, budgetId: existing.id } });
      }
    });
    const after = (await officeBudgetPosition(existing.id))!;
    const flat = (ls: { code: string; name: string; amount?: Prisma.Decimal; budget?: number; openingActual: Prisma.Decimal | number }[]) =>
      ls.map((l) => ({ code: l.code, name: l.name, budget: Number(l.amount ?? l.budget ?? 0), openingActual: Number(l.openingActual) }));
    await audit(
      {
        entityType: 'office_budget',
        entityId: existing.id,
        action: 'UPDATED',
        summary:
          `Office budget ${body.name} (${existing.year}) saved — ${formatMoney(after.total.budget, await companyCurrency())} over ${after.lines.filter((l) => l.isActive).length} lines` +
          (closed.length ? `; closed, not removed (documents charge them): ${closed.join(', ')}` : ''),
        before: { name: existing.name, isActive: existing.isActive, lines: flat(existing.lines) },
        after: { name: body.name, isActive: after.budget.isActive, lines: flat(after.lines) },
      },
      req,
    );
    res.json({ ok: true, closed });
  }),
);

/** Only a budget no document charges; otherwise close it. */
officeBudgetRoutes.delete(
  '/:id',
  requireEdit('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const existing = await prisma.officeBudget.findUnique({ where: { id: req.params.id }, include: { lines: { select: { id: true } } } });
    if (!existing) throw notFound('Office budget not found');
    const use = await officeLineUse(existing.lines.map((l) => l.id));
    const used = [...use.values()].reduce((s, n) => s + n, 0);
    if (used > 0) throw badRequest(`${existing.name} is kept — ${used} document${used === 1 ? ' charges' : 's charge'} its lines. Close it instead`);
    await prisma.officeBudget.delete({ where: { id: existing.id } });
    await audit({ entityType: 'office_budget', entityId: existing.id, action: 'DELETED', summary: `Office budget ${existing.name} (${existing.year}) deleted — nothing was charged to it` }, req);
    res.json({ ok: true });
  }),
);

/** The monitor on paper: every line's budget, requested, cash out, actual, remaining and use; the totals; the overspent lines named. */
officeBudgetRoutes.get(
  '/:id/pdf',
  requireView('gfin', 'operations_budget'),
  handler(async (req, res) => {
    const p = await officeBudgetPosition(req.params.id);
    if (!p) throw notFound('Office budget not found');
    const currency = await companyCurrency();
    const lines = p.lines.filter((l) => l.isActive || l.actual || l.released || l.requested);
    const over = lines.filter((l) => l.over);
    const sections: PdfSection[] = [
      {
        kind: 'table',
        head: ['Code', 'Budget line', `Budget (${currency})`, `Requested (${currency})`, `Cash out (${currency})`, `Actual (${currency})`, `Remaining (${currency})`, 'Used'],
        align: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
        rows: lines.map((l) => [
          l.code,
          { title: l.name, body: [l.isActive ? '' : statusLabel('CLOSED'), l.notes ?? ''].filter(Boolean).join(' — ') },
          formatAmount(l.budget),
          formatAmount(l.requested),
          formatAmount(l.released),
          formatAmount(l.actual),
          formatAmount(l.remaining),
          l.usedPct == null ? '—' : `${l.usedPct.toFixed(1)}%`,
        ]),
      },
      {
        kind: 'totals',
        rows: [
          { label: 'Budget', value: formatMoney(p.total.budget, currency) },
          { label: 'Waiting for approval or release', value: formatMoney(p.total.requested, currency) },
          { label: 'Cash out, to be accounted for', value: formatMoney(p.total.released, currency) },
          { label: 'Actual', value: formatMoney(p.total.actual, currency) },
          { label: 'Remaining', value: formatMoney(p.total.remaining, currency), bold: true },
        ],
      },
      {
        kind: 'text',
        body:
          'Actual is each line’s opening actual plus the approved reimbursements and liquidations charged to it and its approved supplier bills before VAT. Cash out is released budget requests and cash advances not yet accounted for. Remaining is the budget less both; what is still waiting for approval or release is shown and not subtracted.' +
          (over.length ? `\n\nOver budget: ${over.map((l) => `${l.code} ${l.name}`).join(', ')}.` : ''),
      },
    ];
    const pdf = await renderDocument({ title: p.budget.name, date: new Date(), reference: `Office budget ${p.budget.year} — as of ${formatShortDate(new Date())}`, landscape: true, sections });
    await audit({ entityType: 'office_budget', entityId: p.budget.id, action: 'EXPORTED', summary: `Printed the office budget ${p.budget.name}` }, req);
    sendListPdf(res, pdf, 'office-budget.pdf');
  }),
);
